import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {promisify} from "node:util"
import test from "node:test"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {ChromiumWorld} from "../../support/chromium-world.js"
import {cleanupRunStatus, collectCleanup, throwCleanupFailures} from "../../support/cleanup-plan.js"
import {DashboardDriver} from "../../support/dashboard-driver.js"
import {MCPClient} from "../../support/mcp-client.js"
import {assertProtocolLifecycleOutcome, protocolLifecycleRows} from "../../support/lifecycle-matrix.js"
import {protocolBrowserRevokeOracle} from "../../support/lifecycle-parity.js"
import {emitBoundLiveTestReceipt, producerRecord} from "../../support/live-producer-evidence.js"
import {SimulatedBrowser} from "../../support/simulated-browser.js"
import {WebbyWorld} from "../../support/world.js"

const execFileAsync = promisify(execFile)
async function sqlite(database, sql) { return JSON.parse((await execFileAsync("sqlite3", ["-json", database, sql])).stdout || "[]") }

async function liveRow(row) {
  const root = await mkdtemp(join(tmpdir(), `webby-${row.transition.replaceAll("-", "_")}-`))
  const world = await WebbyWorld.start({scenarioId: `lc_${row.transition.replaceAll("-", "_")}_${row.phase.replaceAll("-", "_")}`, seed: 1600, preserveArtifacts: true})
  const recorder = await new ArtifactRecorder({root: join(root, "recorder"), scenarioId: row.scenario_id, worldId: world.worldId, seed: world.seed, secrets: [world.secret, world.telemetryCapability]}).open()
  const browser = new SimulatedBrowser({baseUrl: world.baseUrl, producer: recorder.producers.protocol})
  let chromium; let client; let credential; let finalized = false; let claimedOutcome; let primaryError
  try {
    chromium = await ChromiumWorld.launch({world, recorder})
    const page = await chromium.context.newPage()
    const dashboard = await new DashboardDriver({page, recorder}).open(world.baseUrl)
    await browser.connect()
    const pairing = await browser.pair({displayName: `Lifecycle ${row.transition}`})
    await dashboard.refresh()
    const browserId = await dashboard.approvePairing(pairing.pairing_id, `Lifecycle ${row.transition}`)
    await browser.authenticate(browserId)

    if (row.transition === "ignore") {
      const ignored = browser.observation(90, {origin: "https://ignored.lifecycle"})
      await browser.observe([ignored]); await dashboard.refresh()
      const discovery = await dashboard.rowByText("discoveries", "discovery", "Fixture 90")
      await dashboard.ignoreDiscovery((await discovery.getAttribute("id")).slice("discovery-".length))
      const rediscovery = await browser.observe([ignored])
      assert.deepEqual(rediscovery.payload.ignored_origins, ["https://ignored.lifecycle"])
      const auditCount = Number((await sqlite(world.databasePath, "SELECT COUNT(*) AS count FROM invocation_audits"))[0].count)
      claimedOutcome = idleOutcome(row, world, browser, recorder, "absent", {auditCount, pendingCalls: 0, activeSessions: 0, documentGeneration: ignored.document_id})
      return claimedOutcome
    }

    if (row.transition === "credential-revoke") {
      credential = await dashboard.acquireCredential("call")
      await credential.use(async token => {
        client = new MCPClient({baseUrl: world.baseUrl, token, version: "2025-06-18", recorder: {record: recorder.producers.mcp.event}})
        await client.initialize(); client.close(); client = undefined
      })
      await credential.revoke(); credential = undefined
      const auditCount = Number((await sqlite(world.databasePath, "SELECT COUNT(*) AS count FROM invocation_audits"))[0].count)
      claimedOutcome = idleOutcome(row, world, browser, recorder, "absent", {auditCount, pendingCalls: client?.handles().pending ?? 0, activeSessions: 0, documentGeneration: "no-document"})
      return claimedOutcome
    }

    const observation = browser.observation(16, {origin: `https://${row.transition}.lifecycle`})
    await browser.observe([observation]); await dashboard.refresh()
    const discovery = await dashboard.rowByText("discoveries", "discovery", "Fixture 16")
    const registrationId = await dashboard.registerDiscovery((await discovery.getAttribute("id")).slice("discovery-".length), "Fixture 16")
    await browser.observe([observation]); await dashboard.refresh(); await dashboard.registrationSessionCount(registrationId, 1)
    const session = (await sqlite(world.databasePath, `SELECT id, catalog_revision FROM document_sessions WHERE registration_id='${registrationId}' AND status='active'`))[0]

    let pending; let call; let audits = []
    if (row.phase === "in-flight") {
      credential = await dashboard.acquireCredential("call")
      await credential.use(async token => {
        client = new MCPClient({baseUrl: world.baseUrl, token, version: "2025-06-18", recorder: {record: recorder.producers.mcp.event}})
        await client.initialize()
        const incoming = browser.waitFor("tool.call")
        pending = client.call({action: "page.call", params: {page: registrationId, session: session.id, tool: "tool_0", catalog_revision: session.catalog_revision, arguments: {transition: row.transition}}}, {timeoutMs: 30_000})
        call = await incoming
      })
    }

    await trigger(row.transition, {browser, browserId, dashboard, observation})
    const invalidatedSelector = row.transition === "catalog-change"
      ? `id='${session.id}' AND status='active' AND catalog_revision=${session.catalog_revision}`
      : `id='${session.id}' AND status='active'`
    const staleActiveAfterTransition = Number((await sqlite(world.databasePath, `SELECT COUNT(*) AS count FROM document_sessions WHERE ${invalidatedSelector}`))[0].count)
    const documentsAfterTransition = await sqlite(world.databasePath, `SELECT document_id, catalog_revision, status FROM document_sessions WHERE registration_id='${registrationId}' ORDER BY inserted_at, id`)
    let browserWorkMeasured = row.phase === "idle" ? browser.calls.size === 0 : false
    let lateResultMeasured = row.phase === "idle"
    let oldResultAccepted = false
    let lateResultPath = row.phase === "idle" ? "no-call-created" : undefined
    if (pending) {
      const response = await pending
      assert.equal(response.body.result.isError, true, `${row.id} caller did not terminate as an error`)
      assert.notEqual(response.body.result.structuredContent.kind, "tool_timeout", `${row.id} waited for the generic call timeout`)
      audits = await sqlite(world.databasePath, `SELECT outcome, error_kind FROM invocation_audits WHERE session_id='${session.id}'`)
      assert.equal(audits.length, 1)
      browserWorkMeasured = browser.calls.get(call.call_id)?.state === "cancelled" || browser.wire?.closed === true || new Set(["browser_replaced", "browser_offline"]).has(response.body.result.structuredContent.kind)
      const proof = await proveLateResult({row, browser, browserId, observation, registrationId, client, call, response})
      oldResultAccepted = proof.accepted
      lateResultMeasured = proof.measured
      lateResultPath = proof.path
    }
    const globalActive = Number((await sqlite(world.databasePath, "SELECT COUNT(*) AS count FROM document_sessions WHERE status='active'"))[0].count)
    const auditCount = Number((await sqlite(world.databasePath, "SELECT COUNT(*) AS count FROM invocation_audits"))[0].count)
    assert.equal(staleActiveAfterTransition, 0, `${row.id} left its stale target session/revision active`)
    const measured = {auditCount, pendingCalls: client?.handles().pending ?? 0, activeSessions: staleActiveAfterTransition, globalActiveSessions: globalActive, documentGeneration: JSON.stringify(documentsAfterTransition), browserWorkMeasured, lateResultMeasured, oldResultAccepted, lateResultPath}
    const outcome = row.phase === "idle" ? idleOutcome(row, world, browser, recorder, "invalidated", measured) : pendingOutcome(row, world, browser, recorder, audits, measured)
    claimedOutcome = outcome
    return claimedOutcome
  } catch (error) {
    primaryError = error
  } finally {
    const cleanupSteps = [
      ...(client ? [["mcp-client", () => client.close(), () => { client = undefined }]] : []),
      ...(credential ? [["credential", () => credential.revoke(), () => { credential = undefined }]] : []),
      ["simulated-browser", () => browser.close()],
      ...(chromium ? [["chromium", () => chromium.close(), () => { chromium = undefined }]] : []),
      ["world", () => world.teardown({remove: true})],
    ]
    const initialCleanup = await collectCleanup(cleanupSteps)
    const cleanupFailures = initialCleanup.failures
    const residualResources = Number(Boolean(client) || Boolean(credential) || Boolean(chromium) || !world.rootRemoved || (browser.wire && !browser.wire.closed))
    if (residualResources > 0) {
      const residual = new Error(`lifecycle cleanup left ${residualResources} measured resource set open`)
      residual.cleanup_label = "residual-audit"
      cleanupFailures.push(residual)
    }
    if (!finalized) {
      const finalization = await collectCleanup([["recorder", async () => {
      const cleanup = {scenario: cleanupFailures.length === 0 ? "closed" : "failed", failures: cleanupFailures.map(error => error.message)}
      const artifact = await recorder.finalize({status: cleanupRunStatus({primaryError, failures: cleanupFailures}), cleanup})
      if (claimedOutcome) claimedOutcome.artifacts_attested = artifact.attestation.files.some(file => file.path.endsWith("events.ndjson"))
      finalized = true
      }]])
      cleanupFailures.push(...finalization.failures)
    }
    const removal = await collectCleanup([["temporary-root", () => rm(root, {recursive: true, force: true})]])
    cleanupFailures.push(...removal.failures)
    if (claimedOutcome) {
      claimedOutcome.open_resources = residualResources
      claimedOutcome.evidence.resources_measured = true
    }
    throwCleanupFailures(cleanupFailures, "Lifecycle scenario execution and cleanup failed", {primaryError})
  }
}

async function proveLateResult({row, browser, browserId, observation, registrationId, client, call, response}) {
  if (row.transition === "browser-revoke") {
    assert.equal(browser.wire.closed, true)
    return {accepted: false, measured: true, path: "revoked-socket-closed"}
  }
  if (row.transition === "disconnect") await browser.authenticate(browserId)
  if (row.transition === "pause") await browser.settingsUpdate({scanning_paused: false})
  if (new Set(["close", "pause", "disconnect", "resync-omission"]).has(row.transition)) await browser.observe([observation])
  if (row.transition === "reconnect") await browser.resync([observation])

  const tools = await client.call({action: "page.tools", params: {page: registrationId}})
  const current = tools.body.result.structuredContent.sessions[0]
  assert.ok(current, `${row.id} did not recover a current session for late-result proof`)
  const incoming = browser.waitFor("tool.call")
  let freshSettled = false
  const freshPending = client.call({action: "page.call", params: {page: registrationId, session: current.id, tool: "tool_0", catalog_revision: current.catalog_revision, arguments: {fresh: true}}}, {timeoutMs: 30_000}).then(value => { freshSettled = true; return value })
  const freshCall = await incoming
  await browser.message("tool.result", {call_id: call.call_id, result: {stale: true}})
  await Promise.resolve()
  assert.equal(freshSettled, false, `${row.id} late old result satisfied fresh call`)
  assert.equal(response.body.result.isError, true, `${row.id} old terminal response changed`)
  await browser.result(freshCall.call_id, {fresh: true})
  const fresh = await freshPending
  assert.deepEqual(fresh.body.result.structuredContent, {fresh: true})
  return {accepted: false, measured: true, path: "fresh-call-remained-pending"}
}

async function trigger(transition, {browser, browserId, dashboard, observation}) {
  switch (transition) {
    case "close": return browser.closeSession(observation.tab_id, observation.document_id)
    case "replacement": return browser.observe([{...observation, document_id: `${observation.document_id}-replacement`}])
    case "catalog-change": return browser.observe([{...observation, tools: [...observation.tools, {name: "changed", description: "changed", inputSchema: {type: "object"}}]}])
    case "pause": return browser.settingsUpdate({scanning_paused: true})
    case "browser-revoke": return dashboard.revokeBrowser(browserId)
    case "disconnect": return browser.disconnect()
    case "reconnect": return browser.authenticate(browserId)
    case "resync-omission": return browser.resync([])
    default: throw new Error(`missing live lifecycle trigger: ${transition}`)
  }
}

function identity(row, world, browser, recorder, measured) {
  return {id: row.id, scenario_id: row.scenario_id, transition: row.transition, phase: row.phase, world_nonce: world.instanceNonce, document_generation: measured.documentGeneration, socket_generation: browser.generation, artifact_refs: [world.manifestPath, recorder.journal.path], artifacts_attested: false, pending_calls: measured.pendingCalls, active_sessions: measured.activeSessions, global_active_sessions: measured.globalActiveSessions ?? measured.activeSessions, open_resources: 1, old_result_accepted: measured.oldResultAccepted ?? false, late_result_path: measured.lateResultPath, evidence: {pending_calls_measured: Number.isInteger(measured.pendingCalls), sessions_measured: Number.isInteger(measured.activeSessions), resources_measured: false, audit_measured: Number.isInteger(measured.auditCount), browser_work_measured: measured.browserWorkMeasured ?? true, late_result_measured: measured.lateResultMeasured ?? true}}
}
function idleOutcome(row, world, browser, recorder, session, measured) {
  assert.equal(measured.auditCount, 0)
  assert.equal(measured.pendingCalls, 0)
  return {...identity(row, world, browser, recorder, measured), normalized: {caller: {state: "absent"}, browser_work: {state: measured.browserWorkMeasured === false ? "unknown" : "prevented"}, session: {state: session}, late_result: {state: measured.lateResultMeasured === false ? "unknown" : "prevented"}, capacity: {state: measured.pendingCalls === 0 ? "released" : "held", value: measured.pendingCalls}, audit: {state: "absent", count: measured.auditCount}}}
}
function pendingOutcome(row, world, browser, recorder, audits, measured) {
  return {...identity(row, world, browser, recorder, measured), normalized: {caller: {state: audits[0].outcome === "failed" ? "cancelled" : audits[0].outcome, terminal: true}, browser_work: {state: measured.browserWorkMeasured ? "aborted" : "unknown"}, session: {state: measured.activeSessions === 0 ? "invalidated" : "active"}, late_result: {state: measured.lateResultMeasured && !measured.oldResultAccepted ? "rejected" : "unknown"}, capacity: {state: measured.pendingCalls === 0 ? "released" : "held", value: measured.pendingCalls}, audit: {state: audits[0].outcome, terminal: true, count: audits.length, outcome: audits[0].outcome}}}
}

test("every lifecycle row owned by webby-ihb.16 executes against an isolated live world", {timeout: 600_000}, async t => {
  const complete = await protocolLifecycleRows()
  assert.equal(complete.length, 18)
  const rows = process.env.WEBBY_LIFECYCLE_TRANSITION ? complete.filter(row => row.transition === process.env.WEBBY_LIFECYCLE_TRANSITION) : complete
  assert.ok(rows.length > 0)
  const outcomes = []
  for (const row of rows) await t.test(row.id, {timeout: 60_000}, async () => {
    const outcome = await liveRow(row)
    outcomes.push(outcome)
    if (row.transition === "browser-revoke" && row.phase === "in-flight") assert.deepEqual(outcome.normalized, protocolBrowserRevokeOracle)
    assert.equal(assertProtocolLifecycleOutcome(row, outcome, {world_nonce: outcome.world_nonce, document_generation: outcome.document_generation, socket_generation: outcome.socket_generation}), outcome)
  })
  if (!process.env.WEBBY_LIFECYCLE_TRANSITION) await emitBoundLiveTestReceipt({scenarioId: "e2e-lifecycle-removal", adapter: "protocol", receiptId: "lifecycle-removal-live", assertions: {rows_executed: outcomes.length, pending_calls: outcomes.reduce((sum, outcome) => sum + outcome.pending_calls, 0), open_resources: outcomes.reduce((sum, outcome) => sum + outcome.open_resources, 0)}, producerRecords: [producerRecord("sqlite_result", "lifecycle-live-worlds", "protocol-lifecycle-matrix", {rows: outcomes})]})
})
