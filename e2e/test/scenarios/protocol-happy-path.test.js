import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {promisify} from "node:util"
import test from "node:test"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {assertLifecycleVocabulary} from "../../support/assertions.js"
import {ChromiumWorld} from "../../support/chromium-world.js"
import {DashboardDriver} from "../../support/dashboard-driver.js"
import {MCPClient} from "../../support/mcp-client.js"
import {LogicalHandles, ScenarioRunner, loadScenarioMatrix} from "../../support/scenario-runner.js"
import {SimulatedBrowser} from "../../support/simulated-browser.js"
import {WebbyWorld} from "../../support/world.js"

const execFileAsync = promisify(execFile)
const contractPath = new URL("../../contracts/scenarios/shared-vertical-slice.json", import.meta.url)
const scenarioTemplate = JSON.parse(await readFile(contractPath, "utf8"))
function syntheticScenario(id, {steps, outcomes = [{key: "test.outcome", predicate: {kind: "present", subject: "test.outcome"}}], cleanup = [{kind: "closed", subject: "cleanup.done"}], artifacts = ["timeline", "world-manifest"]} = {}) {
  return {...structuredClone(scenarioTemplate), id, title: `Synthetic runner contract for ${id}`, description: `Runtime-valid synthetic contract used to exercise ${id}.`, drivers: ["protocol"], handles: {}, steps, outcomes, cleanup, artifacts, parity: {protocol: {required_raw_keys: outcomes.map(outcome => outcome.key), raw_exclusions: []}}}
}
async function sqlite(database, sql) { return JSON.parse((await execFileAsync("sqlite3", ["-json", database, sql])).stdout || "[]") }

test("matrix expansion is shared, tagged, and maps every deferred simulated row", async () => {
  const protocol = await loadScenarioMatrix({tags: {drivers: "protocol"}})
  assert.ok(protocol.some(row => row.id === "e2e-shared-vertical-slice"))
  const deferred = protocol.filter(row => row.deferred_to)
  assert.equal(deferred.length, 4)
  assert.equal(new Set(deferred.map(row => row.deferred_to)).size, deferred.length)
  for (const row of deferred) { assert.equal(row.owner, row.deferred_to); assert.match(row.deferred_to, /^webby-ihb\.1[3-6]$/) }
  const pr = await loadScenarioMatrix({tags: {tier: "pr"}})
  assert.ok(pr.length > 0); assert.ok(pr.every(row => row.tier === "pr"))
})

test("handles reject cross-world and cross-contract reuse", () => {
  const first = {worldId: "world-a", instanceNonce: "nonce-a"}; const second = {worldId: "world-b", instanceNonce: "nonce-b"}
  const source = new LogicalHandles({world: first, contract: {id: "one"}}); const handle = source.bind("browser", "browser", "runtime-browser")
  const wrongWorld = new LogicalHandles({world: second, contract: {id: "one"}}); assert.throws(() => wrongWorld.import("browser", handle), error => error.code === "stale_handle")
  const wrongContract = new LogicalHandles({world: first, contract: {id: "two"}}); assert.throws(() => wrongContract.import("browser", handle), error => error.code === "stale_handle")
})

test("runner rejects ineligible drivers and incomplete artifact contracts", () => {
  const scenario = syntheticScenario("e2e-test", {steps: [{id: "probe", action: {op: "health.request"}, wait: {predicate: {kind: "present", subject: "test.outcome"}, timeout_ms: 100}}]})
  const world = {worldId: "world", instanceNonce: "nonce"}; const recorder = {journal: {sequence: 0}, producers: {world: {}}}; const options = {scenario, world, recorder, actions: {}, observe: async () => ({}), cleanup: async () => ({})}
  assert.throws(() => new ScenarioRunner({...options, driver: "chromium"}), error => error.code === "ineligible_driver")
  assert.throws(() => new ScenarioRunner({...options, driver: "protocol", scenario: {...scenario, artifacts: ["timeline"]}}), error => error.code === "missing_artifact_requirement")
})

async function syntheticRecorder(t, scenarioId) {
  const root = await mkdtemp(join(tmpdir(), "webby-runner-unit-")); t.after(() => rm(root, {recursive: true, force: true}))
  return new ArtifactRecorder({root, scenarioId, worldId: "world-unit"}).open()
}

test("runner fails closed for a dropped observation and still cleans up", async t => {
  const recorder = await syntheticRecorder(t, "e2e-missing-observation"); let cleaned = false
  const scenario = syntheticScenario("e2e-missing-observation", {steps: [{id: "one", action: {op: "health.request"}, wait: {predicate: {kind: "present", subject: "probe.actual"}, timeout_ms: 100}}]})
  const runner = new ScenarioRunner({scenario, driver: "protocol", world: {worldId: "world-unit", instanceNonce: "nonce", seed: 1}, recorder, actions: {"health.request": async () => ({})}, observe: async () => ({}), cleanup: async () => { cleaned = true; return {"cleanup.done": {state: "closed"}} }})
  await assert.rejects(runner.run(), error => error.code === "missing_observation"); assert.equal(cleaned, true); await recorder.finalize()
})

test("runner enforces declared action order rather than parallelizing dependent steps", async t => {
  const recorder = await syntheticRecorder(t, "e2e-action-order"); const order = []
  const step = id => ({id, action: {op: "health.request", params: {id}}, wait: {predicate: {kind: "present", subject: `${id}.done`}, timeout_ms: 100}})
  const scenario = syntheticScenario("e2e-action-order", {steps: [step("first"), step("second")], outcomes: [{key: "test.outcome", predicate: {kind: "present", subject: "second.done"}}]})
  const actions = {"health.request": async ({params}) => { if (params.id === "first") { order.push("first:start"); await Promise.resolve(); order.push("first:end") } else order.push("second"); return {observations: {[`${params.id}.done`]: true}} }}
  await new ScenarioRunner({scenario, driver: "protocol", world: {worldId: "world-unit", instanceNonce: "nonce", seed: 1}, recorder, actions, observe: async () => ({}), cleanup: async () => ({"cleanup.done": {state: "closed"}})}).run()
  assert.deepEqual(order, ["first:start", "first:end", "second"]); await recorder.finalize()
})

test("runner aborts and drains a timed-out action before cleanup", async t => {
  const recorder = await syntheticRecorder(t, "e2e-action-timeout"); const order = []
  const scenario = syntheticScenario("e2e-action-timeout", {steps: [{id: "slow", action: {op: "health.request"}, wait: {predicate: {kind: "present", subject: "slow.done"}, timeout_ms: 10}}]})
  const actions = {"health.request": ({signal}) => new Promise(resolve => signal.addEventListener("abort", () => { order.push("action:drained"); resolve({}) }, {once: true}))}
  const runner = new ScenarioRunner({scenario, driver: "protocol", world: {worldId: "world-unit", instanceNonce: "nonce", seed: 1}, recorder, actions, observe: async () => ({}), cleanup: async () => { order.push("cleanup"); return {"cleanup.done": {state: "closed"}} }, defaultTimeoutMs: 100})
  await assert.rejects(runner.run(), error => error.code === "scenario_timeout")
  assert.deepEqual(order, ["action:drained", "cleanup"]); await recorder.finalize()
})

test("runner preserves primary and cleanup failures", async t => {
  const recorder = await syntheticRecorder(t, "e2e-dual-failure")
  const scenario = syntheticScenario("e2e-dual-failure", {steps: [{id: "fail", action: {op: "health.request"}, wait: {predicate: {kind: "present", subject: "fail.done"}, timeout_ms: 100}}]})
  const runner = new ScenarioRunner({scenario, driver: "protocol", world: {worldId: "world-unit", instanceNonce: "nonce", seed: 1}, recorder, actions: {"health.request": async () => { throw new Error("primary") }}, observe: async () => ({}), cleanup: async () => { throw new Error("cleanup") }})
  await assert.rejects(runner.run(), error => error instanceof AggregateError && error.errors.map(item => item.message).join(",") === "primary,cleanup")
  await recorder.finalize()
})

test("runner preserves a primary failure plus journal and cleanup failures", async t => {
  const recorder = await syntheticRecorder(t, "e2e-three-failures")
  recorder.producers.world.failure = async () => { throw new Error("journal") }
  const scenario = syntheticScenario("e2e-three-failures", {steps: [{id: "fail", action: {op: "health.request"}, wait: {predicate: {kind: "present", subject: "fail.done"}, timeout_ms: 100}}]})
  const runner = new ScenarioRunner({scenario, driver: "protocol", world: {worldId: "world-unit", instanceNonce: "nonce", seed: 1}, recorder, actions: {"health.request": async () => { throw new Error("primary") }}, observe: async () => ({}), cleanup: async () => { throw new Error("cleanup") }})
  await assert.rejects(runner.run(), error => error instanceof AggregateError && error.errors[0] instanceof AggregateError && error.errors[0].errors.map(item => item.message).join(",") === "primary,journal" && error.errors[1].message === "cleanup")
  await recorder.journal.close()
})

test("synthetic lifecycle vocabulary covers every locked terminal state", () => {
  assert.doesNotThrow(() => assertLifecycleVocabulary({caller: {state: "cancelled"}, browser_work: {state: "aborted"}, session: {state: "invalidated"}, late_result: {state: "rejected"}, capacity: {state: "released"}, audit: {state: "failed", terminal: true}}))
})

test("complete simulated protocol pair-to-audit vertical slice", {timeout: 120_000}, async t => {
  const scenario = JSON.parse(await readFile(contractPath, "utf8")); const root = await mkdtemp(join(tmpdir(), "webby-scenario-"))
  const world = await WebbyWorld.start({scenarioId: scenario.id, seed: 8675309, preserveArtifacts: true})
  const recorder = await new ArtifactRecorder({root: join(root, "recorder"), scenarioId: scenario.id, worldId: world.worldId, seed: world.seed, secrets: [world.secret, world.telemetryCapability]}).open()
  const browser = new SimulatedBrowser({baseUrl: world.baseUrl, producer: recorder.producers.protocol}); let chromium; let mcp; let page
  t.after(async () => { await browser.close().catch(() => {}); mcp?.close(); await chromium?.close().catch(() => {}); await world.teardown({remove: true}).catch(() => {}); await rm(root, {recursive: true, force: true}) })
  chromium = await ChromiumWorld.launch({world, recorder}); page = await chromium.context.newPage(); const dashboard = await new DashboardDriver({page, recorder}).open(world.baseUrl)
  let observation; let discoveryId; let registrationId; let browserId; let credentialId; let auditId; let callResponse; let credentialLease
  const toolCall = new Promise(resolve => browser.once("tool.call", resolve))
  const actions = {
    "health.request": async () => { const response = await fetch(`${world.baseUrl}/health`); const ready = {state: response.ok ? "ready" : "failed", value: response.ok}; return {handles: {world: world.worldId}, observations: {"health.ready": ready, "wait.shared-vertical-slice.health": ready}} },
    "browser.pair": async () => { await browser.connect(); const pending = await browser.pair({displayName: "Scenario Simulator"}); await dashboard.refresh(); browserId = await dashboard.approvePairing(pending.pairing_id, "Scenario Simulator"); await browser.authenticate(browserId); const authenticated = {state: "recovered", value: true}; return {handles: {pairing: pending.pairing_id, browser: browserId}, observations: {"browser.authenticated": authenticated, "wait.shared-vertical-slice.pair": {state: "succeeded", terminal: true, value: browserId}}} },
    "discovery.publish": async () => { observation = browser.observation(42, {origin: "https://scenario.fixture", toolCount: 1}); await browser.observe([observation]); await dashboard.refresh(); const row = await dashboard.rowByText("discoveries", "discovery", "Fixture 42"); discoveryId = (await row.getAttribute("id")).slice("discovery-".length); registrationId = await dashboard.registerDiscovery(discoveryId, "Fixture 42"); await browser.observe([observation]); await dashboard.refresh(); await dashboard.registrationSessionCount(registrationId, 1); const available = {state: "present", value: registrationId}; return {handles: {page: registrationId, document: observation.document_id, session: `${browserId}:${observation.tab_id}:${observation.document_id}`}, observations: {"page.available": available, "wait.shared-vertical-slice.discover": available}} },
    "credential.create": async () => { credentialLease = await dashboard.acquireCredential("call"); credentialId = credentialLease.id; return {handles: {credential: credentialId}, observations: {"wait.shared-vertical-slice.credential": {state: "present", value: true}}} },
    "mcp.invoke": async ({handles}) => credentialLease.use(async secret => {
      assert.equal(handles.get("browser", "browser"), browserId); assert.equal(handles.get("credential", "credential"), credentialId)
      mcp = new MCPClient({baseUrl: world.baseUrl, token: secret, version: "2025-06-18", recorder: {record: recorder.producers.mcp.event}}); await mcp.initialize()
      const pages = await mcp.call({action: "page.list"}); const pageList = pages.body.result.structuredContent ?? JSON.parse(pages.body.result.content[0].text); const registered = pageList.find(item => item.id === registrationId); assert.equal(registered.available, true)
      const tools = await mcp.call({action: "page.tools", params: {page: registrationId}}); const session = tools.body.result.structuredContent.sessions[0]
      const effect = {probe: "scenario-effect"}; const expectedResult = {echo: effect.probe}
      const pending = mcp.call({action: "page.call", params: {page: registrationId, session: session.id, tool: "tool_0", catalog_revision: session.catalog_revision, arguments: effect}}); const call = await toolCall
      assert.deepEqual(call.arguments, effect); assert.equal(call.tool_name, "tool_0"); await browser.result(call.call_id, expectedResult); callResponse = await pending; mcp.close(); mcp.token = undefined
      assert.deepEqual(callResponse.body.result.structuredContent, expectedResult)
      return {handles: {call: call.call_id}, observations: {"call.succeeded": {state: "succeeded", terminal: true, value: callResponse.body.result.structuredContent}, "wait.shared-vertical-slice.invoke": {state: "present", value: true}}}
    }),
    "audit.observe": async () => { const audits = await sqlite(world.databasePath, `SELECT id, credential_id, browser_id, outcome, tool_name FROM invocation_audits WHERE credential_id='${credentialId}'`); assert.equal(audits.length, 1); assert.equal(audits[0].browser_id, browserId); assert.equal(audits[0].outcome, "succeeded"); assert.equal(audits[0].tool_name, "tool_0"); auditId = audits[0].id; return {handles: {audit: auditId}, observations: {"audit.once": {state: "present", value: 1}, "wait.shared-vertical-slice.audit": {state: "present", value: true}}} },
  }
  const observe = async () => ({})
  const cleanup = async () => {
    mcp?.close(); await credentialLease?.revoke(); await browser.close().catch(() => {}); await chromium.screenshot(page, "dashboard-snapshot.png"); await chromium.close(); chromium = undefined
    await recorder.producers.world.artifact(world.manifestPath, {name: "world-manifest.json", kind: "manifest", essential: true})
    await world.teardown({remove: false})
    await recorder.producers.world.artifact(world.stdoutPath, {name: "server-stdout.log", kind: "log", essential: true})
    await recorder.producers.world.artifact(world.stderrPath, {name: "server-stderr.log", kind: "log", essential: true})
    return {"cleanup.all.child.processes.exit": {state: "closed"}, "cleanup.all.listeners.close": {state: "closed"}, "cleanup.temporary.database.and.profile.are.removable": {state: "removable"}, "cleanup.no.active.sessions.remain.after.shutdown": {state: "absent"}}
  }
  const runner = new ScenarioRunner({scenario, driver: "protocol", world, recorder, actions, observe, cleanup})
  const result = await runner.run()
  assert.equal(callResponse.body.result.isError, false); assert.deepEqual(result.normalized["call.succeeded"], {state: "succeeded", terminal: true, value: {echo: "scenario-effect"}}); assert.equal(result.handles.get("audit", "audit"), auditId)
  const artifact = await recorder.finalize({cleanup: {scenario: "closed", browser: "closed", chromium: "closed", mcp: "closed", world: "closed"}})
  assert.ok(artifact.attestation.files.some(file => file.path.endsWith("events.ndjson"))); assert.ok(artifact.attestation.files.some(file => file.path.endsWith("world-manifest.json"))); assert.ok(artifact.attestation.files.some(file => file.path.endsWith("dashboard-snapshot.png"))); assert.equal(artifact.replay.seed, 8675309); assert.equal(artifact.replay.first_failure, undefined)
})
