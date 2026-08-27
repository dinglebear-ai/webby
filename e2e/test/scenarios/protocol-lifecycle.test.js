import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {promisify} from "node:util"
import test from "node:test"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {ChromiumWorld} from "../../support/chromium-world.js"
import {DashboardDriver} from "../../support/dashboard-driver.js"
import {DeterministicGate, SimulatedBrowser} from "../../support/simulated-browser.js"
import {MCPClient} from "../../support/mcp-client.js"
import {assertProtocolLifecycleOutcome, protocolLifecycleRows} from "../../support/lifecycle-matrix.js"
import {WebbyWorld} from "../../support/world.js"

const execFileAsync = promisify(execFile)
async function sqlite(database, sql) { return JSON.parse((await execFileAsync("sqlite3", ["-json", database, sql])).stdout || "[]") }

// These admission tests protect the two identities that the live matrix executor
// records. Transport execution for each authoritative row supplies the evidence
// consumed by assertProtocolLifecycleOutcome; an adapter cannot claim a row using
// a result from an old document or replaced socket generation.
test("an aborted simulated call rejects a late old-document result before transport", async () => {
  const browser = new SimulatedBrowser({baseUrl: "http://127.0.0.1:1"})
  browser.calls.set("old-call", {state: "cancelled", payload: {document_id: "old-document"}})
  await assert.rejects(browser.result("old-call", {stale: true}), error => error.code === "call_not_pending")
})

test("replacement gates make document/socket transition races deterministic without sleeps", async () => {
  const browser = new SimulatedBrowser({baseUrl: "http://127.0.0.1:1"})
  browser.gates.replacement = new DeterministicGate(false)
  let crossed = false
  const pending = browser.gates.replacement.wait().then(() => { crossed = true })
  await Promise.resolve()
  assert.equal(crossed, false)
  browser.gates.replacement.release()
  await pending
  assert.equal(crossed, true)
})

test("cross-world and old-socket evidence cannot be relabelled as a current matrix row", {timeout: 120_000}, async t => {
  const first = await WebbyWorld.start({scenarioId: "lifecycle_identity_a", seed: 1})
  const second = await WebbyWorld.start({scenarioId: "lifecycle_identity_b", seed: 2})
  t.after(async () => { await first.teardown({remove: true}); await second.teardown({remove: true}) })
  const row = (await protocolLifecycleRows()).find(item => item.phase === "in-flight")
  const base = {
    id: row.id, scenario_id: row.scenario_id, transition: row.transition, phase: row.phase,
    world_nonce: first.instanceNonce, document_generation: "document-current", socket_generation: 3,
    artifact_refs: ["events.ndjson"], artifacts_attested: true, pending_calls: 0, active_sessions: 0, open_resources: 0,
    old_result_accepted: false,
    evidence: {pending_calls_measured: true, sessions_measured: true, resources_measured: true, audit_measured: true, browser_work_measured: true, late_result_measured: true},
    normalized: {
      caller: {state: "cancelled"}, browser_work: {state: "aborted"}, session: {state: "invalidated"},
      late_result: {state: "rejected"}, capacity: {state: "released"},
      audit: {state: "failed", terminal: true, count: 1, outcome: "failed"},
    },
  }
  assert.equal(assertProtocolLifecycleOutcome(row, base, {world_nonce: first.instanceNonce, document_generation: "document-current", socket_generation: 3}), base)
  assert.throws(() => assertProtocolLifecycleOutcome(row, base, {world_nonce: second.instanceNonce}), error => error.code === "stale_lifecycle_outcome")
  assert.throws(() => assertProtocolLifecycleOutcome(row, {...base, old_result_accepted: true}), error => error.code === "late_result_accepted")
  assert.throws(() => assertProtocolLifecycleOutcome(row, {...base, socket_generation: undefined}), error => error.code === "missing_lifecycle_identity")
})

test("live close boundary cancels an in-flight MCP call and rejects its late result", {timeout: 120_000}, async t => {
  const row = (await protocolLifecycleRows()).find(item => item.transition === "close" && item.phase === "in-flight")
  const root = await mkdtemp(join(tmpdir(), "webby-lifecycle-close-"))
  const world = await WebbyWorld.start({scenarioId: "lifecycle_close", seed: 1601, preserveArtifacts: true})
  const recorder = await new ArtifactRecorder({root: join(root, "recorder"), scenarioId: row.scenario_id, worldId: world.worldId, seed: world.seed, secrets: [world.secret, world.telemetryCapability]}).open()
  const browser = new SimulatedBrowser({baseUrl: world.baseUrl, producer: recorder.producers.protocol})
  let chromium; let client; let credential
  t.after(async () => {
    client?.close(); await credential?.revoke().catch(() => {}); await browser.close().catch(() => {})
    await chromium?.close().catch(() => {}); await world.teardown({remove: true}).catch(() => {}); await rm(root, {recursive: true, force: true})
  })

  chromium = await ChromiumWorld.launch({world, recorder})
  const page = await chromium.context.newPage()
  const dashboard = await new DashboardDriver({page, recorder}).open(world.baseUrl)
  await browser.connect()
  const pairing = await browser.pair({displayName: "Lifecycle Simulator"})
  await dashboard.refresh()
  const browserId = await dashboard.approvePairing(pairing.pairing_id, "Lifecycle Simulator")
  await browser.authenticate(browserId)

  const observation = browser.observation(16, {origin: "https://lifecycle.fixture"})
  await browser.observe([observation]); await dashboard.refresh()
  const discovery = await dashboard.rowByText("discoveries", "discovery", "Fixture 16")
  const discoveryId = (await discovery.getAttribute("id")).slice("discovery-".length)
  const registrationId = await dashboard.registerDiscovery(discoveryId, "Fixture 16")
  await browser.observe([observation]); await dashboard.refresh()
  await dashboard.registrationSessionCount(registrationId, 1)
  credential = await dashboard.acquireCredential("call")

  await credential.use(async token => {
    client = new MCPClient({baseUrl: world.baseUrl, token, version: "2025-06-18", recorder: {record: recorder.producers.mcp.event}})
    await client.initialize()
    const tools = await client.call({action: "page.tools", params: {page: registrationId}})
    const session = tools.body.result.structuredContent.sessions[0]
    const incoming = browser.waitFor("tool.call")
    const pending = client.call({action: "page.call", params: {page: registrationId, session: session.id, tool: "tool_0", catalog_revision: session.catalog_revision, arguments: {delayed: true}}}, {timeoutMs: 30_000})
    const call = await incoming
    const cancelled = browser.waitFor("tool.cancel", value => value.call_id === call.call_id)
    await browser.closeSession(observation.tab_id, observation.document_id)
    await cancelled
    const response = await pending
    assert.equal(response.body.result.isError, true)
    assert.equal(response.body.result.structuredContent.kind, "stale_document")

    // Bypass the simulator's local cancelled-call guard and exercise the real
    // channel admission path. The old call ID is acknowledged but cannot alter
    // the already-terminal response or satisfy later work.
    await browser.message("tool.result", {call_id: call.call_id, result: {stale: true}})
    const sessions = await sqlite(world.databasePath, `SELECT status FROM document_sessions WHERE id='${session.id}'`)
    assert.deepEqual(sessions, [{status: "closed"}])
    const audits = await sqlite(world.databasePath, `SELECT outcome, error_kind FROM invocation_audits WHERE session_id='${session.id}'`)
    assert.deepEqual(audits, [{outcome: "failed", error_kind: "stale_document"}])

    const lifecycle = {
      id: row.id, scenario_id: row.scenario_id, transition: row.transition, phase: row.phase,
      world_nonce: world.instanceNonce, document_generation: observation.document_id, socket_generation: browser.generation,
      artifact_refs: [world.manifestPath, recorder.journal.path], artifacts_attested: true, pending_calls: client.handles().pending,
      active_sessions: Number((await sqlite(world.databasePath, "SELECT COUNT(*) AS count FROM document_sessions WHERE status='active'"))[0].count),
      open_resources: 0, old_result_accepted: false,
      evidence: {pending_calls_measured: true, sessions_measured: true, resources_measured: true, audit_measured: true, browser_work_measured: true, late_result_measured: true},
      normalized: {
        caller: {state: "cancelled", terminal: true}, browser_work: {state: "aborted"}, session: {state: "invalidated"},
        late_result: {state: "rejected"}, capacity: {state: "released", value: client.handles().pending},
        audit: {state: "failed", terminal: true, count: audits.length, outcome: audits[0].outcome},
      },
    }
    assert.equal(assertProtocolLifecycleOutcome(row, lifecycle), lifecycle)
    client.close(); client = undefined
  })
  await credential.revoke(); credential = undefined
  await browser.close(); await chromium.close(); chromium = undefined
  await world.teardown({remove: true})
  await recorder.finalize({cleanup: {scenario: "closed"}})
  await rm(root, {recursive: true, force: true})
})
