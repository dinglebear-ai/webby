import assert from "node:assert/strict"
import {join} from "node:path"
import test from "node:test"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {ChromiumWorld} from "../../support/chromium-world.js"
import {runCleanupPlan} from "../../support/cleanup-plan.js"
import {DashboardDriver} from "../../support/dashboard-driver.js"
import {MCPClient} from "../../support/mcp-client.js"
import {WebbyWorld} from "../../support/world.js"
import {startFixtureServer} from "../../fixture/server.js"
import {chromiumReadActions} from "../../support/chromium-command-matrix.js"

function content(response) {
  assert.equal(response.status, 200)
  assert.equal(response.body.error, undefined)
  return response.body.result.structuredContent ?? JSON.parse(response.body.result.content[0].text)
}

test("actual popup, pairing, discovery, Chrome events, dashboard, and broker reads agree", {timeout: 240_000}, async t => {
  let world = await WebbyWorld.start({scenarioId: "chromium_pairing_discovery", seed: 17017, preserveArtifacts: true})
  await world.releaseFixturePort()
  const fixture = await startFixtureServer({worldId: world.worldId, port: world.fixturePort})
  const recorder = await new ArtifactRecorder({
    root: join(world.workspace.artifacts, "chromium-commands"), scenarioId: world.scenarioId,
    worldId: world.worldId, seed: world.seed, secrets: [world.secret, world.telemetryCapability, fixture.capability],
  }).open()
  let chromium
  let finalized = false
  t.after(async () => {
    await runCleanupPlan([
      ["chromium", () => chromium?.close()],
      ["fixture", () => fixture.close()],
      ["recorder", () => finalized ? undefined : recorder.finalize({status: "failed"})],
      ["world", () => world?.teardown({remove: true})],
    ], {message: "Chromium pairing fallback cleanup failed"})
  })

  chromium = await ChromiumWorld.launch({world, recorder, broadHostPermissions: true})
  const driver = chromium.driver
  await driver.waitForChromeEvent("runtime.onInstalled")
  const dashboardPage = await chromium.context.newPage()
  const dashboard = await new DashboardDriver({page: dashboardPage, recorder}).open(world.baseUrl)

  const attempts = await driver.socketAttempts()
  for (const endpoint of ["http://example.com", `http://user@127.0.0.1:${world.port}`, `${world.baseUrl}/path`, `${world.baseUrl}?redirect=evil`]) {
    assert.match(await driver.configure({baseUrl: endpoint}), /loopback URL/)
    assert.equal(await driver.socketAttempts(), attempts)
  }
  assert.equal(await driver.configure({mode: "all_tabs", paused: true}), "Saved.")
  assert.equal((await driver.storage("scanningPaused")).scanningPaused, true)
  assert.equal(await driver.configure({mode: "all_tabs", paused: false}), "Saved.")
  assert.equal((await driver.storage("scanningPaused")).scanningPaused, false)
  assert.equal((await driver.storage("scanningMode")).scanningMode, "all_tabs")

  const rejected = await driver.pair("Rejected Chrome")
  assert.ok(rejected.pairing_id)
  const duplicate = await driver.pair("Duplicate Chrome")
  assert.equal(duplicate.pairing_id, rejected.pairing_id, "duplicate pairing must not create a second durable request")
  await dashboard.refresh()
  await dashboard.rejectPairing(rejected.pairing_id)
  assert.equal((await driver.storage("browserId")).browserId, undefined)

  const pending = await driver.pair("Chrome")
  assert.notEqual(pending.pairing_id, rejected.pairing_id)
  const approved = driver.waitForStorageValue("browserId", {timeoutMs: 5_000})
  await dashboard.refresh()
  const browserId = await dashboard.approvePairing(pending.pairing_id, "Chrome")
  assert.equal(await approved, browserId)
  assert.equal(await driver.waitForStorageValue("e2eAuthenticatedBrowserId", {timeoutMs: 10_000}), browserId)

  const tab = await driver.newFixtureTab("/")
  await tab.waitForFunction(() => typeof document.modelContext?.getTools === "function")
  await tab.waitForFunction(async () => (await document.modelContext.getTools()).length > 0)
  await driver.waitForChromeEvent("tabs.onUpdated")
  await driver.waitForChromeEvent("tabs.onActivated")
  await driver.scanNow({activePage: tab})
  await dashboard.refresh()
  const discoveryRow = await dashboard.rowByText("discoveries", "discovery", "Webby fixture")
  const discoveryId = (await discoveryRow.getAttribute("id")).slice("discovery-".length)

  let registrationId
  await dashboard.withCredential("read", async ({token}) => {
    const mcp = new MCPClient({baseUrl: world.baseUrl, token, version: "2025-06-18", recorder: {record: recorder.producers.mcp.event}})
    try {
      assert.equal((await mcp.initialize()).status, 200)
      const results = new Map()
      results.set("status", content(await mcp.call({action: "status"})))
      results.set("browser.list", content(await mcp.call({action: "browser.list"})))
      results.set("discovery.list", content(await mcp.call({action: "discovery.list"})))
      results.set("discovery.get", content(await mcp.call({action: "discovery.get", params: {id: discoveryId}})))
      assert.deepEqual([...results.keys()], chromiumReadActions.slice(0, 4))
      assert.equal(results.get("browser.list").find(browser => browser.id === browserId)?.available, true)
      assert.ok(results.get("discovery.list").some(discovery => discovery.id === discoveryId))
      assert.equal(results.get("discovery.get").id, discoveryId)

      registrationId = await dashboard.registerDiscovery(discoveryId, "Webby fixture")
      await driver.scanNow({activePage: tab})
      await dashboard.refresh()
      await dashboard.registrationSessionCount(registrationId, 1)
      results.set("page.list", content(await mcp.call({action: "page.list"})))
      results.set("page.get", content(await mcp.call({action: "page.get", params: {page: registrationId}})))
      results.set("page.tools", content(await mcp.call({action: "page.tools", params: {page: registrationId}})))
      assert.deepEqual([...results.keys()], chromiumReadActions)
      assert.equal(results.get("page.list").find(page => page.id === registrationId)?.available, true)
      assert.equal(results.get("page.get").id, registrationId)
      assert.ok(results.get("page.tools").sessions[0].tools.some(tool => tool.name === "echo"))
    } finally { mcp.close() }
  })

  const ignoredTab = await driver.newFixtureTab("/dynamic")
  await ignoredTab.waitForFunction(() => typeof document.modelContext?.getTools === "function")
  await ignoredTab.waitForFunction(async () => (await document.modelContext.getTools()).length > 0)
  await driver.scanNow({activePage: ignoredTab})
  await dashboard.refresh()
  const ignoredRow = await dashboard.rowByText("discoveries", "discovery", "Dynamic Webby fixture")
  const ignoredId = (await ignoredRow.getAttribute("id")).slice("discovery-".length)
  await dashboard.ignoreDiscovery(ignoredId)
  await driver.scanNow({activePage: ignoredTab})
  assert.ok((await driver.waitForStorageValue("ignoredOrigins", {timeoutMs: 10_000})).includes(new URL(world.fixtureUrl).origin))

  await driver.scheduleScanAlarm()
  await driver.closeTab(ignoredTab)
  await driver.closeTab(tab)
  const eventCounts = await driver.chromeEventCounts()
  for (const event of ["runtime.onInstalled", "tabs.onUpdated", "tabs.onActivated", "tabs.onRemoved", "alarms.onAlarm", "storage.onChanged", "runtime.onMessage"]) {
    assert.ok(eventCounts[event] > 0, `${event} was not dispatched by Chromium`)
  }

  const privateState = await driver.storage(["privateKey", "publicKey"])
  assert.ok(privateState.publicKey)
  recorder.addSecret(JSON.stringify(privateState.privateKey))
  await assert.rejects(recorder.producers.chromium.secretZone("private-jwk", () => chromium.artifacts.capture("extension-storage", () => driver.storage(null))), error => error.code === "secret_zone_capture_prohibited")

  await chromium.close()
  chromium = await ChromiumWorld.launch({world, recorder, broadHostPermissions: true})
  assert.equal(await chromium.driver.configure({mode: "all_tabs"}), "Saved.")
  assert.equal((await chromium.driver.storage("scanningMode")).scanningMode, "all_tabs")
  assert.equal((await chromium.driver.storage("publicKey")).publicKey, privateState.publicKey)
  await chromium.close(); chromium = undefined
  await recorder.finalize({status: "passed", coverage: {eligible: 29, mapped: 29, percent: 100}})
  finalized = true
  await fixture.close()
  await world.teardown({remove: true}); world = undefined
})
