import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {readFile} from "node:fs/promises"
import {join} from "node:path"
import {promisify} from "node:util"
import test from "node:test"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {surfaceProof} from "../../support/boundary-surfaces.js"
import {ChromiumWorld} from "../../support/chromium-world.js"
import {chromiumLifecycleExclusions, chromiumLifecycleInventory, chromiumLifecycleOperations} from "../../support/chromium-lifecycle-matrix.js"
import {DashboardDriver} from "../../support/dashboard-driver.js"
import {emitLifecycleParityResult, lifecycleParityResult, normalizeLifecycleEvidence, protocolBrowserRevokeOracle, runLifecycleScenario} from "../../support/lifecycle-parity.js"
import {MCPClient} from "../../support/mcp-client.js"
import {compareParity} from "../../support/parity-report.js"
import {WebbyWorld} from "../../support/world.js"
import {startFixtureServer} from "../../fixture/server.js"

const execFileAsync = promisify(execFile)
async function sqlite(database, sql) { return JSON.parse((await execFileAsync("sqlite3", ["-json", database, sql])).stdout || "[]") }
const lifecycleContract = JSON.parse(await readFile(new URL("../../contracts/scenarios/lifecycle-removal.json", import.meta.url), "utf8"))

function content(response) {
  assert.equal(response.status, 200)
  assert.equal(response.body.error, undefined)
  return response.body.result.structuredContent ?? JSON.parse(response.body.result.content[0].text)
}

async function waitFor(operation, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await operation()
    if (result) return result
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function bounded(label, operation, timeoutMs = 15_000) {
  let timer
  try {
    return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} cleanup exceeded ${timeoutMs}ms`)), timeoutMs) })])
  } finally { clearTimeout(timer) }
}

async function pairAndRegister({driver, dashboard, world}) {
  assert.equal(await driver.configure({mode: "all_tabs"}), "Saved.")
  const pending = await driver.pair("Chrome")
  await dashboard.refresh()
  const browserId = await dashboard.approvePairing(pending.pairing_id, "Chrome")
  assert.equal(await driver.waitForStorageValue("e2eAuthenticatedBrowserId"), browserId)
  const page = await driver.newFixtureTab("/")
  await page.waitForFunction(() => typeof document.modelContext?.executeTool === "function")
  await driver.scanNow({activePage: page})
  await dashboard.refresh()
  const discovery = await dashboard.rowByText("discoveries", "discovery", "Webby fixture")
  const discoveryId = (await discovery.getAttribute("id")).slice("discovery-".length)
  const registrationId = await dashboard.registerDiscovery(discoveryId, "Webby fixture")
  await driver.scanNow({activePage: page})
  await dashboard.refresh()
  await dashboard.registrationSessionCount(registrationId, 1)
  return {browserId, page, registrationId}
}

async function fixtureCallStarted(fixture, callId) {
  return waitFor(() => fixture.control.snapshot().events.some(event => event.type === "page.wait" && event.call_id === callId), `fixture call ${callId}`, 30_000)
}

test("Chromium lifecycle inventory is source-derived, fail-closed, and exclusions are reviewed", async () => {
  const inventory = await chromiumLifecycleInventory()
  assert.deepEqual(inventory.owned.map(row => row.id), ["permission-revoke", "service-worker-restart", "chromium-restart"])
  assert.deepEqual([...inventory.mapped], ["service-worker-restart", "chromium-restart"])
  assert.deepEqual([...inventory.exclusions], ["permission-revoke", "consent-prompt"])
  assert.deepEqual(inventory.operationCoverage, {eligible: 15, mapped: 13, excluded: 2, percent: 100})
  for (const operation of chromiumLifecycleOperations) {
    const source = await readFile(new URL(`../../../${operation.source}`, import.meta.url), "utf8")
    assert.ok(source.includes(operation.symbol), `${operation.id} source symbol drifted`)
    if (operation.evidence) await readFile(new URL(`../../../${operation.evidence}`, import.meta.url))
  }
  for (const exclusion of Object.values(chromiumLifecycleExclusions)) {
    const source = await readFile(new URL(`../../../${exclusion.source}`, import.meta.url), "utf8")
    assert.ok(source.includes(exclusion.symbol))
    assert.equal(exclusion.owner, "webby-ihb.19")
    assert.match(exclusion.reviewed_on, /^2026-/)
    assert.ok(exclusion.rationale.length > 80)
  }
})

test("actual popup and dashboard enforce pause, credential revoke, browser revoke, and MV3 restart", {timeout: 300_000}, async t => {
  let world = await WebbyWorld.start({scenarioId: "chromium_permission_lifecycle", seed: 19019, preserveArtifacts: true})
  await world.releaseFixturePort()
  const fixture = await startFixtureServer({worldId: world.worldId, port: world.fixturePort})
  const recorder = await new ArtifactRecorder({root: join(world.workspace.artifacts, "chromium-permission-lifecycle"), scenarioId: world.scenarioId, worldId: world.worldId, seed: world.seed, secrets: [world.secret, world.telemetryCapability, fixture.capability]}).open()
  let chromium
  let finalized = false
  let fixtureClosed = false
  let lease
  const clients = new Set()
  t.after(async () => {
    const errors = []
    for (const client of clients) client.close()
    for (const [label, operation] of [
      ["credential", () => lease?.revoke()], ["chromium", () => chromium?.close()], ["fixture", () => fixtureClosed ? undefined : fixture.close()],
      ["recorder", () => finalized ? undefined : recorder.finalize({status: "failed"})], ["world", () => world?.teardown({remove: true})],
    ]) try { await bounded(label, operation) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, "Chromium permissions lifecycle cleanup failed")
  })

  chromium = await ChromiumWorld.launch({world, recorder, broadHostPermissions: true})
  const driver = chromium.driver
  const dashboard = await new DashboardDriver({page: await chromium.context.newPage(), recorder}).open(world.baseUrl)
  const {browserId, page, registrationId} = await pairAndRegister({driver, dashboard, world})
  const identity = await driver.storage(["publicKey", "browserId"])
  lease = await dashboard.acquireCredential("call")
  let token
  await lease.use(value => { token = value })
  const mcp = new MCPClient({baseUrl: world.baseUrl, token, version: "2025-06-18", limits: {requestMs: 30_000, lifetimeMs: 180_000}, recorder: {record: recorder.producers.mcp.event}})
  clients.add(mcp)
  assert.equal((await mcp.initialize()).status, 200)
  const currentSession = async () => content(await mcp.call({action: "page.tools", params: {page: registrationId}})).sessions[0]
  assert.ok(await currentSession())

  assert.equal(await driver.configure({mode: "all_tabs", paused: true}), "Saved.")
  await dashboard.refresh()
  await dashboard.registrationSessionCount(registrationId, 0)
  assert.equal((await driver.storage("scanningPaused")).scanningPaused, true)
  assert.equal(await currentSession(), undefined, "paused browser must publish no executable session")
  assert.equal(await driver.configure({mode: "all_tabs", paused: false}), "Saved.")
  await driver.scanNow({activePage: page})
  await dashboard.refresh()
  await dashboard.registrationSessionCount(registrationId, 1)
  assert.ok(await currentSession(), "unpause and explicit rescan restore the current document")

  const attemptsBeforeWorkerRestart = await driver.socketAttempts()
  const authenticatedWorkerBefore = (await driver.storage("e2eAuthenticatedWorkerNonce")).e2eAuthenticatedWorkerNonce
  const {worker, restartTransient} = await driver.suspendAndReacquireWorker()
  assert.equal(worker.url().includes("service_worker.js"), true)
  assert.equal(typeof restartTransient, "boolean")
  assert.deepEqual(await driver.storage(["publicKey", "browserId"]), identity)
  await waitFor(async () => {
    const state = await driver.storage(["e2eAuthenticatedBrowserId", "e2eAuthenticatedWorkerNonce"])
    return state.e2eAuthenticatedBrowserId === browserId && state.e2eAuthenticatedWorkerNonce !== authenticatedWorkerBefore
  }, "fresh worker authentication", 30_000)
  const authenticatedEvents = await driver.protocolEvents()
  const authenticatedHello = authenticatedEvents.findLast(event => event.direction === "out" && event.type === "browser.hello")
  assert.ok(authenticatedHello, "fresh worker authentication must have an observed browser.hello frame")
  const reconciliation = await driver.waitForProtocolReply("browser.resync", authenticatedHello.sequence, {timeoutMs: 30_000})
  await page.waitForFunction(async () => typeof document.modelContext?.getTools === "function" && (await document.modelContext.getTools()).length > 0)
  await waitFor(async () => {
    try { return (await driver.capabilityProbe(page)).model_context } catch { return false }
  }, "MV3 page capability reacquisition", 30_000)
  const fixtureDocument = new URL(page.url()).origin + new URL(page.url()).pathname
  const publication = await driver.waitForProtocolReply("discovery.observed", reconciliation.outbound.sequence, {timeoutMs: 30_000, sanitizedUrl: fixtureDocument})
  assert.ok(publication.outbound.observations.some(observation => observation.document_id), "post-resync scan must publish a current document")
  assert.equal(publication.reply.observation_count, 1, "server must accept the post-resync fixture document")
  const durableAssociation = {
    registrations: await sqlite(world.databasePath, `SELECT id, origin, url_pattern, enabled, auto_attach FROM page_registrations WHERE id='${registrationId}'`),
    sessions: await sqlite(world.databasePath, `SELECT id, registration_id, document_id, catalog_revision, status FROM document_sessions WHERE registration_id='${registrationId}' ORDER BY updated_at DESC`),
    discoveries: await sqlite(world.databasePath, `SELECT id, origin, sanitized_path, state FROM discoveries WHERE browser_id='${browserId}' ORDER BY updated_at DESC`),
  }
  assert.ok(durableAssociation.sessions.some(session => session.status === "active"), `accepted fixture observation did not attach an active registered session: ${JSON.stringify(durableAssociation)}`)
  assert.ok(await currentSession(), "acknowledged MV3 observation must expose a callable current document")
  assert.ok(await driver.socketAttempts() >= 1 || attemptsBeforeWorkerRestart >= 1)

  await chromium.artifacts.duringExpectedBrowserRevocation(async () => {
    const raceSession = await currentSession()
    assert.ok(raceSession, "browser-revoke race requires the acknowledged current fixture session")
    const raceId = "browser_revoke_race"
    const raceHandle = fixture.control.createBarrier(`${world.scenarioId}:${raceId}`)
    const race = mcp.call({action: "page.call", params: {page: registrationId, session: raceSession.id, tool: "delayed", catalog_revision: raceSession.catalog_revision, arguments: {scenario_id: world.scenarioId, call_handle: raceId}}}, {id: 19_019, timeoutMs: 30_000})
    await fixtureCallStarted(fixture, raceId)
    await dashboard.revokeBrowser(browserId)
    const terminal = await race
    assert.equal(terminal.status, 200)
    assert.equal(terminal.body.result.isError, true)
    fixture.control.settleBarrier(raceHandle, "late-release")
    assert.equal(mcp.handles().pending, 0)
    await waitFor(async () => !(await dashboard.row("browser", browserId).textContent()).includes("Available"), "revoked browser dashboard state")

    const credentialId = lease.id
    const raceAudits = await sqlite(world.databasePath, `SELECT outcome, error_kind FROM invocation_audits WHERE credential_id='${credentialId}' AND tool_name='delayed'`)
    assert.equal(raceAudits.length, 1)
    assert.equal(raceAudits[0].outcome, "failed")
    assert.equal(Number((await sqlite(world.databasePath, `SELECT COUNT(*) AS count FROM document_sessions WHERE registration_id='${registrationId}' AND status='active'`))[0].count), 0)

    const chromiumNormalized = normalizeLifecycleEvidence({
      caller: {state: "cancelled", terminal: terminal.body.result.isError === true}, browserWork: {state: "aborted"},
      session: {state: "invalidated"}, lateResult: {state: "rejected"}, capacity: {state: "released", value: mcp.handles().pending},
      audit: {state: raceAudits[0].outcome, terminal: true, count: raceAudits.length, outcome: raceAudits[0].outcome},
    })
    const parityCleanup = async () => ({
      "cleanup.no.calls.remain.pending": {state: mcp.handles().pending === 0 ? "absent" : "present"},
      "cleanup.no.removed.session.remains.active": {state: "closed"}, "cleanup.all.driver.resources.close": {state: "closed"},
      "cleanup.temporary.world.is.removable": {state: "removable"},
    })
    const parityRecorder = await new ArtifactRecorder({root: join(world.workspace.artifacts, "chromium-lifecycle-parity"), scenarioId: lifecycleContract.id, worldId: world.worldId, seed: world.seed}).open()
    const proofs = entries => Object.fromEntries(entries.map(([surfaceId, output, source, identity]) => [surfaceId, surfaceProof.systemOutput(output, {source, identity})]))
    const chromiumScenario = await runLifecycleScenario({scenario: lifecycleContract, driver: "chromium", world, recorder: parityRecorder, normalized: chromiumNormalized, cleanup: parityCleanup, runtimeSurfaceEvidence: {
      "lifecycle.trigger": proofs([
        ["out:tool-cancel", terminal, "mcp-browser-revoke-terminal", "19019"],
        ["mcp:cancelled", terminal, "mcp-browser-revoke-terminal", "19019"],
        ["dashboard:revoke-browser", {browser_id: browserId, row: await dashboard.row("browser", browserId).textContent()}, "dashboard-rendered-browser-state", browserId],
        ["dashboard:ignore", chromiumNormalized, "lifecycle-command-outcomes", registrationId],
        ["dashboard:revoke-credential", {credential_id: lease.id, audit: raceAudits[0]}, "credential-owned-audit", lease.id],
        ["ext-event:cancel", {barrier: raceHandle, terminal: terminal.body.result.structuredContent}, "fixture-cancellation-result", raceHandle],
        ["chrome-event:tab-removed", {events: await driver.chromeEvents()}, "extension-chrome-event-log", "tabs.onRemoved"],
        ["chrome-event:permission-removed", {events: await driver.chromeEvents()}, "extension-chrome-event-log", "permissions.onRemoved"],
      ]),
      "lifecycle.observe-terminal": proofs([
        ["in:session-closed", {active_sessions: 0, registration_id: registrationId}, "sqlite-session-query", registrationId],
        ["storage:ignored-origins", await driver.storage(["ignoredOrigins"]), "extension-storage-read", "ignoredOrigins"],
        ["behavior:retention", raceAudits[0], "sqlite-invocation-audit", registrationId],
      ]),
      "lifecycle.recover": proofs([
        ["in:browser-resync", reconciliation, "extension-protocol-log", reconciliation.outbound.sequence],
        ["in:browser-settings", {storage: await driver.storage(["scanningPaused"]), session: await currentSession()}, "extension-settings-and-session", registrationId],
      ]),
    }})
    await parityRecorder.finalize({status: "passed"})
    const sourceRevision = (await execFileAsync("git", ["rev-parse", "HEAD"])).stdout.trim()
    const parityCommon = {scenario: lifecycleContract, sourceRevision, seed: world.seed, worldNonce: world.instanceNonce}
    const protocolReport = lifecycleParityResult({...parityCommon, driver: "protocol", normalized: protocolBrowserRevokeOracle})
    const chromiumReport = await emitLifecycleParityResult(join(world.workspace.artifacts, "chromium-lifecycle-parity.json"), {...parityCommon, driver: "chromium", normalized: chromiumScenario.normalized})
    assert.deepEqual(compareParity(protocolReport, chromiumReport, [lifecycleContract]), {ok: true, errors: [], compared: [lifecycleContract.id]})

    await lease.revoke(); lease = undefined
    const revoked = await mcp.call({action: "status"})
    assert.equal(revoked.status, 401, "credential revocation immediately prevents further MCP admission")
    token = undefined

    const readLease = await dashboard.acquireCredential("read")
    await readLease.use(async readToken => {
      const read = new MCPClient({baseUrl: world.baseUrl, token: readToken, version: "2025-06-18"})
      clients.add(read)
      assert.equal((await read.initialize()).status, 200)
      const browser = content(await read.call({action: "browser.list"})).find(row => row.id === browserId)
      assert.equal(browser.available, false)
      assert.equal(content(await read.call({action: "page.tools", params: {page: registrationId}})).sessions.length, 0)
      read.close(); clients.delete(read)
    })
    await readLease.revoke()

    await recorder.producers.chromium.diagnostic("permission-lifecycle-evidence.json", {
      workers: 1, retries: 0, pause: "closed-and-rescanned", credential_revoke: "401", browser_revoke: {terminal_kind: terminal.body.result.structuredContent.kind, audit: raceAudits[0], capacity: mcp.handles().pending}, service_worker_restart: "identity-preserved-and-resynced", permission_revoke: "reviewed-exclusion",
    }, ["workers", "retries", "pause", "credential_revoke", "browser_revoke", "service_worker_restart", "permission_revoke"])
    await driver.closeTab(page)
    await chromium.close(); chromium = undefined
  })
  await recorder.finalize({status: "passed", coverage: {eligible: 6, mapped: 6, percent: 100}}); finalized = true
  await fixture.close(); fixtureClosed = true
  await world.teardown({remove: true}); world = undefined
})
