import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {join} from "node:path"
import {promisify} from "node:util"
import test from "node:test"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {ChromiumWorld} from "../../support/chromium-world.js"
import {assertLifecycleEvidence} from "../../support/chromium-lifecycle-matrix.js"
import {DashboardDriver} from "../../support/dashboard-driver.js"
import {MCPClient} from "../../support/mcp-client.js"
import {WebbyWorld} from "../../support/world.js"
import {startFixtureServer} from "../../fixture/server.js"

const execFileAsync = promisify(execFile)
async function sqlite(database, sql) { return JSON.parse((await execFileAsync("sqlite3", ["-json", database, sql])).stdout || "[]") }

function content(response) {
  assert.equal(response.status, 200)
  assert.equal(response.body.error, undefined)
  return response.body.result.structuredContent ?? JSON.parse(response.body.result.content[0].text)
}

async function waitFor(operation, description, timeoutMs = 30_000, signal) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason
    try {
      const result = await operation()
      if (result) return result
    } catch (error) { lastError = error }
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`timed out waiting for ${description}`, {cause: lastError})
}

async function bounded(label, operation, timeoutMs = 15_000) {
  let timer
  try {
    return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} cleanup exceeded ${timeoutMs}ms`)), timeoutMs) })])
  } finally { clearTimeout(timer) }
}

test("persistent profile, MV3 socket, dashboard, and Webby recover across real restarts", {timeout: 300_000}, async t => {
  const deadline = new AbortController()
  const deadlineTimer = setTimeout(() => deadline.abort(new Error("restart lifecycle exceeded its 270000ms execution budget")), 270_000)
  const startedAt = performance.now()
  let phaseAt = startedAt
  const phase = async name => {
    const now = performance.now()
    await recorder.producers.world.event("restart.phase.completed", {phase: name, duration_ms: Math.round(now - phaseAt), elapsed_ms: Math.round(now - startedAt)})
    phaseAt = now
    if (deadline.signal.aborted) throw deadline.signal.reason
  }
  let world = await WebbyWorld.start({scenarioId: "chromium_reconnect_restart", seed: 19020, preserveArtifacts: true})
  await world.releaseFixturePort()
  const fixture = await startFixtureServer({worldId: world.worldId, port: world.fixturePort})
  const recorder = await new ArtifactRecorder({root: join(world.workspace.artifacts, "chromium-reconnect-restart"), scenarioId: world.scenarioId, worldId: world.worldId, seed: world.seed, secrets: [world.secret, world.telemetryCapability, fixture.capability]}).open()
  let chromium
  let lease
  let mcp
  let finalized = false
  let fixtureClosed = false
  t.after(async () => {
    clearTimeout(deadlineTimer)
    const errors = []
    mcp?.close()
    for (const [label, operation] of [
      ["credential", () => lease?.revoke()], ["chromium", () => chromium?.close()], ["fixture", () => fixtureClosed ? undefined : fixture.close()],
      ["recorder", () => finalized ? undefined : recorder.finalize({status: "failed"})], ["world", () => world?.teardown({remove: true})],
    ]) try { await bounded(label, operation) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, "Chromium restart lifecycle cleanup failed")
  })

  chromium = await ChromiumWorld.launch({world, recorder, broadHostPermissions: true})
  await phase("initial-chromium-launch")
  let driver = chromium.driver
  let dashboard = await new DashboardDriver({page: await chromium.context.newPage(), recorder}).open(world.baseUrl)
  assert.equal(await driver.configure({mode: "all_tabs"}), "Saved.")
  const pending = await driver.pair("Chrome")
  await dashboard.refresh()
  const browserId = await dashboard.approvePairing(pending.pairing_id, "Chrome")
  assert.equal(await driver.waitForStorageValue("e2eAuthenticatedBrowserId"), browserId)
  const firstPage = await driver.newFixtureTab("/")
  await firstPage.waitForFunction(() => typeof document.modelContext?.executeTool === "function")
  await driver.scanNow({activePage: firstPage}); await dashboard.refresh()
  const discovery = await dashboard.rowByText("discoveries", "discovery", "Webby fixture")
  const registrationId = await dashboard.registerDiscovery((await discovery.getAttribute("id")).slice("discovery-".length), "Webby fixture")
  await driver.scanNow({activePage: firstPage}); await dashboard.refresh(); await dashboard.registrationSessionCount(registrationId, 1)
  const identity = await driver.storage(["publicKey", "browserId", "scanningMode"])
  const firstWorkerUrl = (await driver.worker()).url()

  lease = await dashboard.acquireCredential("read")
  let token
  await lease.use(value => { token = value })
  mcp = new MCPClient({baseUrl: world.baseUrl, token, version: "2025-06-18", limits: {requestMs: 10_000, lifetimeMs: 180_000}, recorder: {record: recorder.producers.mcp.event}})
  assert.equal((await mcp.initialize()).status, 200)
  assert.equal(content(await mcp.call({action: "page.tools", params: {page: registrationId}})).sessions.length, 1)

  mcp.close(); mcp = undefined
  await lease.revoke({dashboard}); lease = undefined
  token = undefined
  await chromium.close(); chromium = undefined
  await phase("initial-profile-close")
  chromium = await ChromiumWorld.launch({world, recorder, broadHostPermissions: true})
  await phase("persistent-profile-relaunch")
  driver = chromium.driver
  dashboard = await new DashboardDriver({page: await chromium.context.newPage(), recorder}).open(world.baseUrl)
  assert.deepEqual(await driver.storage(["publicKey", "browserId", "scanningMode"]), identity, "persistent profile must retain identity and public settings")
  const replacementWorkerUrl = (await driver.worker()).url()
  assert.equal(await driver.waitForStorageValue("e2eAuthenticatedBrowserId"), browserId)
  const replacementPage = await driver.newFixtureTab("/")
  await replacementPage.waitForFunction(() => typeof document.modelContext?.executeTool === "function")
  await driver.scanNow({activePage: replacementPage})
  await dashboard.refresh(); await dashboard.registrationSessionCount(registrationId, 1)

  lease = await dashboard.acquireCredential("read")
  await lease.use(value => { token = value })
  mcp = new MCPClient({baseUrl: world.baseUrl, token, version: "2025-06-18", limits: {requestMs: 10_000, lifetimeMs: 180_000}, recorder: {record: recorder.producers.mcp.event}})
  assert.equal((await mcp.initialize()).status, 200)
  const preRestartPublicSession = await waitFor(async () => content(await mcp.call({action: "page.tools", params: {page: registrationId}})).sessions[0], "Chromium restart resync", 30_000, deadline.signal)
  const [preRestartDurableSession] = await sqlite(world.databasePath, `SELECT document_id, catalog_revision FROM document_sessions WHERE id='${preRestartPublicSession.id}' AND status='active'`)

  const serviceWorker = await driver.worker()
  const attemptsBefore = await serviceWorker.evaluate(() => globalThis.__webbyE2ESocketAttempts ?? 0)
  const scanAllBefore = await driver.scanAllCompletions()
  const protocolSequenceBefore = Math.max(0, ...(await driver.protocolEvents()).map(event => event.sequence))
  const oldWorld = {pid: world.pid, baseUrl: world.baseUrl}
  let attemptsAfter
  let recoveredBrowser
  let recoveredSessions
  await chromium.artifacts.duringExpectedNetworkOutage(async () => {
    world = await world.restart({preserveState: true})
    await phase("webby-restart")
    assert.equal(world.baseUrl, chromium.binding?.base_url ?? chromium.generated.binding.base_url, "Webby restart must retain authority")
    const restartedHealth = await fetch(`${world.baseUrl}/health`).then(response => response.json())
    assert.equal(restartedHealth.runtime.capabilities.health.instance_nonce, world.instanceNonce)
    attemptsAfter = await waitFor(async () => {
      const workers = chromium.context.serviceWorkers().filter(worker => worker.url().includes("service_worker.js"))
      for (const worker of workers) {
        const attempts = await worker.evaluate(() => globalThis.__webbyE2ESocketAttempts ?? 0).catch(() => 0)
      if (attempts > attemptsBefore) return attempts
      }
      return false
    }, "extension socket reconnect after Webby restart", 30_000, deadline.signal)
    await dashboard.page.close()
    dashboard = await new DashboardDriver({page: await chromium.context.newPage(), recorder}).open(world.baseUrl)
    recoveredBrowser = await waitFor(async () => {
      const browser = content(await mcp.call({action: "browser.list"})).find(row => row.id === browserId)
      return browser?.available === true ? browser : undefined
    }, "browser availability after Webby restart", 30_000, deadline.signal)
    const resyncUrl = new URL(replacementPage.url()).origin + new URL(replacementPage.url()).pathname
    const resync = await driver.waitForProtocolReply("browser.resync", protocolSequenceBefore, {timeoutMs: 30_000, sanitizedUrl: resyncUrl})
    assert.equal(resync.reply.observation_count, 1)
    const resyncedObservation = resync.outbound.observations.find(observation => observation.document_id)
    assert.ok(resyncedObservation, "acknowledged resync must carry the observed document")
    const restartAssociation = {
      registrations: await sqlite(world.databasePath, `SELECT id, origin, url_pattern, enabled, auto_attach FROM page_registrations WHERE id='${registrationId}'`),
      sessions: await sqlite(world.databasePath, `SELECT id, registration_id, document_id, catalog_revision, status FROM document_sessions WHERE registration_id='${registrationId}' ORDER BY updated_at DESC`),
      discoveries: await sqlite(world.databasePath, `SELECT id, origin, sanitized_path, state FROM discoveries WHERE browser_id='${browserId}' ORDER BY updated_at DESC`),
    }
    recoveredSessions = content(await mcp.call({action: "page.tools", params: {page: registrationId}})).sessions
    assert.equal(recoveredSessions.length, 1, `accepted restart resync did not restore public session: ${JSON.stringify(restartAssociation)}`)
    const [durableSession] = await sqlite(world.databasePath, `SELECT document_id, catalog_revision FROM document_sessions WHERE id='${recoveredSessions[0].id}' AND status='active'`)
    assert.equal(durableSession.document_id, resyncedObservation.document_id)
    assert.equal(durableSession.catalog_revision, preRestartDurableSession.catalog_revision, "Webby restart must preserve the server-assigned catalog revision")
    await dashboard.registrationSessionCount(registrationId, 1)
    await driver.waitForScanAllCompletion(scanAllBefore, {timeoutMs: 30_000})
  })

  const transitions = ["service-worker-restart", "chromium-restart", "socket-reconnect", "webby-restart", "profile-identity"]
  const common = {page: {registration_id: registrationId, sessions: recoveredSessions.map(row => row.id)}, dashboard: {browser_id: browserId, available: recoveredBrowser.available}, terminal: "recovered", capacity: mcp.handles().pending, cleanup: "bounded"}
  const evidence = {
    "service-worker-restart": {...common, browser: {worker_url: replacementWorkerUrl, socket_attempts: attemptsAfter}},
    "chromium-restart": {...common, browser: {before_worker: firstWorkerUrl, after_worker: replacementWorkerUrl}},
    "socket-reconnect": {...common, browser: {attempts_before: attemptsBefore, attempts_after: attemptsAfter}},
    "webby-restart": {...common, browser: {old_pid: oldWorld.pid, new_pid: world.pid, old_base_url: oldWorld.baseUrl, new_base_url: world.baseUrl}},
    "profile-identity": {...common, browser: {public_key: identity.publicKey, browser_id: identity.browserId, scanning_mode: identity.scanningMode}},
  }
  const coverage = assertLifecycleEvidence(evidence, transitions)
  await recorder.producers.chromium.diagnostic("restart-lifecycle-evidence.json", {workers: 1, retries: 0, ...evidence}, ["workers", "retries", ...transitions])
  token = undefined
  mcp.close(); mcp = undefined
  await lease.revoke({dashboard}); lease = undefined
  await chromium.close(); chromium = undefined
  await phase("final-chromium-close")
  await recorder.finalize({status: "passed", coverage}); finalized = true
  await fixture.close(); fixtureClosed = true
  await world.teardown({remove: true}); world = undefined
})
