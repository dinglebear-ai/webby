import assert from "node:assert/strict"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {emitFixtureOutcomeParityReport, runSharedFixtureOutcome} from "../../support/fixture-outcome-parity.js"
import {compareParity} from "../../support/parity-report.js"
import {emitBoundLiveTestReceipt, producerRecord} from "../../support/live-producer-evidence.js"
import {auditState, eventBarrier, openCapacityFixture, rawMcpCancel, toolOutcome} from "./protocol-capacity-fixture.js"

const scenarioPath = new URL("../../contracts/scenarios/fixture-outcomes.json", import.meta.url)

async function runAdapter(t, scenario, driver) {
  const root = await mkdtemp(join(tmpdir(), `webby-fixture-parity-${driver}-`))
  t.after(() => rm(root, {recursive: true, force: true}))
  const recorder = await new ArtifactRecorder({root, scenarioId: scenario.id, worldId: `${driver}-world`, seed: 731}).open()
  const cleanup = async () => ({
    "cleanup.fixture.has.no.pending.tool.promises": {state: "absent"},
    "cleanup.fixture.listener.closes": {state: "closed"},
    "cleanup.browser.resources.close": {state: "closed"},
    "cleanup.temporary.world.is.removable": {state: "removable"},
  })
  const result = await runSharedFixtureOutcome({scenario, driver, world: {worldId: `${driver}-world`, instanceNonce: `${driver}-` + "n".repeat(32), seed: 731}, recorder, cleanup})
  await recorder.finalize({cleanup: {shared_fixture_model: "closed"}})
  return result
}

test("shared semantics execute through ScenarioRunner and emitted adapter reports fail closed on drift", async t => {
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8"))
  const protocol = await runAdapter(t, scenario, "protocol")
  const chromium = await runAdapter(t, scenario, "chromium")
  // This is an adapter-contract test, not a claim that Chromium launched. The
  // live Chromium suite supplies its own observed outcomes to the same emitter.
  assert.deepEqual(protocol.normalized, chromium.normalized)
  assert.equal(protocol.normalized["results.normalized"].value.success.state, "succeeded")
  assert.equal(protocol.normalized["results.normalized"].value.tool_error.value.error_kind, "tool_error")
  assert.equal(protocol.normalized["results.normalized"].value.delayed.value.released, true)
  assert.equal(protocol.normalized["results.normalized"].value.timed_out.state, "timed_out")
  assert.equal(protocol.normalized["results.normalized"].value.result_too_large.value.error_kind, "result_too_large")
  assert.equal(protocol.normalized["results.normalized"].value.result_too_deep.value.error_kind, "result_too_large")
  assert.equal(protocol.normalized["abort.observed"].value.caller, "cancelled")
  assert.equal(protocol.normalized["abort.observed"].value.browser_work, "aborted")
  assert.equal(protocol.normalized["abort.observed"].value.late_result, "rejected")
  assert.equal(protocol.normalized["abort.observed"].value.lifecycle.capacity.state, "released")
  assert.equal(protocol.normalized["abort.observed"].value.lifecycle.audit.terminal, true)
  assert.deepEqual(protocol.normalized["stale.rejected"].value, {error_kind: "stale_document", late_result: "rejected", side_effects: 0})

  const reportRoot = await mkdtemp(join(tmpdir(), "webby-fixture-parity-reports-"))
  t.after(() => rm(reportRoot, {recursive: true, force: true}))
  const common = {scenario, sourceRevision: "a".repeat(40), seed: "fixture-parity-seed", worldNonce: "w".repeat(32)}
  const protocolPath = join(reportRoot, "protocol.json")
  const chromiumPath = join(reportRoot, "chromium.json")
  const protocolReport = await emitFixtureOutcomeParityReport(protocolPath, {...common, driver: "protocol", normalized: protocol.normalized})
  const chromiumReport = await emitFixtureOutcomeParityReport(chromiumPath, {...common, driver: "chromium", normalized: chromium.normalized})
  assert.deepEqual(JSON.parse(await readFile(protocolPath, "utf8")), protocolReport)
  assert.deepEqual(JSON.parse(await readFile(chromiumPath, "utf8")), chromiumReport)
  const parity = compareParity(protocolReport, chromiumReport, [scenario])
  assert.deepEqual(parity, {ok: true, errors: [], compared: [scenario.id]})

  const missing = structuredClone(chromiumReport)
  missing.results[0].raw_observables.pop()
  assert.ok(compareParity(protocolReport, missing, [scenario]).errors.some(error => error.includes("no raw observable provenance") || error.includes("required raw observable")))
  const drift = structuredClone(chromiumReport)
  drift.results[0].outcomes["results.normalized"].value.success = "failed"
  assert.ok(compareParity(protocolReport, drift, [scenario]).errors.some(error => error.includes("normalized outcomes differ")))
})

test("complete fixture outcome denominator executes through the live protocol adapter", {timeout: 180_000}, async t => {
  const fixture = await openCapacityFixture(t, "protocol-live-fixture-outcomes", {invocationTimeoutMs: 400})
  const browser = fixture.browsers[0].browser
  const entry = fixture.credentials[0]
  const outcomes = []
  const invoke = async (name, complete) => {
    const tools = await entry.client.call({action: "page.tools", params: {page: fixture.registrationId}})
    const session = tools.body.result.structuredContent.sessions[0]
    const id = `fixture-${name}`
    const arrival = eventBarrier(browser, "tool.call", 1)
    const request = entry.client.call({action: "page.call", params: {page: fixture.registrationId, session: session.id, tool: "tool_0", catalog_revision: session.catalog_revision, arguments: {outcome: name}}}, {id})
    const [call] = await arrival
    await complete({call, id, request})
    const response = await request
    outcomes.push({name, outcome: toolOutcome(response), status: response.status})
    return response
  }
  await invoke("json", ({call}) => browser.result(call.call_id, {json: {ok: true}}))
  await invoke("text", ({call}) => browser.result(call.call_id, {text: "fixture text"}))
  await invoke("throw", ({call}) => browser.toolError(call.call_id, "tool_error", "fixture rejection"))
  await invoke("delay", async ({call}) => { await new Promise(resolve => setImmediate(resolve)); await browser.result(call.call_id, {released: true}) })
  await invoke("cancel", async ({id}) => { await rawMcpCancel(fixture.world.baseUrl, entry.credential.token, id) })
  let deep = {leaf: true}; for (let index = 0; index < 80; index++) deep = {nested: deep}
  await invoke("deep", async ({call}) => { await browser.result(call.call_id, deep).catch(error => assert.ok(["channel_reply_error", "frame_size_limit"].includes(error.code))) })
  await invoke("side-effect", ({call}) => browser.result(call.call_id, {side_effects: 1}))
  await invoke("oversized", async ({call}) => { browser.wire.maxFrameBytes = 2_000_000; try { await browser.result(call.call_id, {value: "x".repeat(1_100_000)}).catch(error => assert.ok(error)) } finally { browser.wire.maxFrameBytes = 262_144 } })
  if (browser.wire?.closed) { await browser.authenticate(browser.browserId); await browser.observe([fixture.observation]) }
  const oldSession = entry.sessions[0]
  const staleArrival = eventBarrier(browser, "tool.call", 1)
  const staleRequest = entry.client.call({action: "page.call", params: {page: fixture.registrationId, session: oldSession.id, tool: "tool_0", catalog_revision: oldSession.catalog_revision, arguments: {outcome: "stale"}}}, {id: "fixture-stale"})
  await staleArrival
  const replacement = {...fixture.observation, document_id: "fixture-mutated-document"}
  await browser.observe([replacement])
  const stale = await staleRequest
  assert.equal(stale.body.result.isError, true)
  assert.deepEqual(new Set(outcomes.map(row => row.name)), new Set(["json", "text", "throw", "delay", "cancel", "oversized", "deep", "side-effect"]))
  assert.equal(outcomes.every(row => row.status === 200), true)
  const audits = await auditState(fixture)
  assert.equal(audits.started, 0)
  const assertions = {tool_outcomes: outcomes.length, transport_exchanges: outcomes.length, side_effects: 1}
  await emitBoundLiveTestReceipt({scenarioId: "e2e-fixture-tool-outcomes", adapter: "protocol", receiptId: "fixture-protocol-live", assertions, producerRecords: [producerRecord("sqlite_result", "webby-sqlite", fixture.world.worldId, {rows: audits.rows, outcomes, stale: toolOutcome(stale)})]})
})
