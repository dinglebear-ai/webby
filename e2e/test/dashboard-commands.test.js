import assert from "node:assert/strict"
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {ArtifactRecorder} from "../support/artifacts.js"
import {classifyBrowserError} from "../support/browser-artifacts.js"
import {ChromiumWorld, prepareChromiumAssets} from "../support/chromium-world.js"
import {DashboardDriver} from "../support/dashboard-driver.js"
import {dashboardEventContract, dashboardExclusions, dashboardSelectors, recordSelector} from "../support/dashboard-selectors.js"
import {SimulatedBrowser} from "../support/simulated-browser.js"
import {WebbyWorld} from "../support/world.js"

async function boundedCleanup(operation, timeoutMs = 10_000) {
  let timer
  try { await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("dashboard cleanup timed out")), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}

test("dashboard selector contract maps every actual event and explicit non-dashboard surface", () => {
  assert.deepEqual(dashboardEventContract.map(item => item.event).sort(), ["approve-pairing", "create-mcp-credential", "ignore-discovery", "register-discovery", "reject-pairing", "revoke-browser", "revoke-mcp-credential"].sort())
  assert.deepEqual(dashboardExclusions["invocation-audit-dom"].owners, ["artifact-recorder", "webby-ihb.15", "webby-ihb.16"])
  assert.deepEqual(dashboardExclusions["popup-pause-resume-scan-mode"].owners, ["webby-ihb.17", "webby-ihb.18", "webby-ihb.19"])
  assert.equal(recordSelector("pairing", "00000000-0000-0000-0000-000000000001"), "#pairing-00000000-0000-0000-0000-000000000001")
  assert.throws(() => recordSelector("pairing", "unsafe selector"), /invalid dashboard record ID/)
  assert.equal(classifyBrowserError({kind: "network_error", text: {message: "HTTP 404", url: "http://127.0.0.1/assets/js/app.js"}}).code, "core_asset_missing")
})

test("asset preparation deduplicates builds and fails with bounded diagnostics", async t => {
  const root = await mkdtemp(join(tmpdir(), "webby-assets-test-")); t.after(() => rm(root, {recursive: true, force: true}))
  const events = []; const diagnostics = []
  const producer = {event: async (...args) => events.push(args), diagnostic: async (...args) => diagnostics.push(args)}
  let executions = 0
  const execute = async (_command, _args, options) => {
    executions++; assert.equal(options.timeout, 1234)
    await mkdir(join(root, "priv/static/assets/js"), {recursive: true}); await mkdir(join(root, "priv/static/assets/css"), {recursive: true})
    await writeFile(join(root, "priv/static/assets/js/app.js"), "javascript"); await writeFile(join(root, "priv/static/assets/css/app.css"), "css")
    return {stdout: "", stderr: ""}
  }
  const builds = new Map()
  await Promise.all([prepareChromiumAssets({producer, root, timeoutMs: 1234, execute, builds}), prepareChromiumAssets({producer, root, timeoutMs: 1234, execute, builds})])
  await prepareChromiumAssets({producer, root, timeoutMs: 1234, execute, builds})
  assert.equal(executions, 1); assert.equal(events.length, 1)

  const failedRoot = await mkdtemp(join(tmpdir(), "webby-assets-fail-")); t.after(() => rm(failedRoot, {recursive: true, force: true}))
  await assert.rejects(prepareChromiumAssets({producer, root: failedRoot, timeoutMs: 1, builds: new Map(), execute: async () => { throw Object.assign(new Error("deadline"), {code: "ETIMEDOUT", stdout: "safe", stderr: "bounded"}) }}), /asset preparation failed/)
  assert.equal(diagnostics.at(-1)[1].code, "ETIMEDOUT")
})

test("actual LiveView dashboard drives all commands and visible lifecycle states", {timeout: 90_000}, async t => {
  const root = await mkdtemp(join(tmpdir(), "webby-dashboard-test-"))
  const world = await WebbyWorld.start({scenarioId: "dashboard-commands", seed: 12, preserveArtifacts: true})
  const recorder = await new ArtifactRecorder({root: join(root, "recorder"), scenarioId: world.scenarioId, worldId: world.worldId, secrets: [world.secret, world.telemetryCapability]}).open()
  const browsers = []
  let chromium
  t.after(async () => {
    for (const browser of browsers) await boundedCleanup(() => browser.close().catch(() => {}))
    if (chromium) await boundedCleanup(() => chromium.close().catch(() => {}))
    await boundedCleanup(() => world.teardown({remove: true}).catch(() => {}))
    await rm(root, {recursive: true, force: true})
  })

  chromium = await ChromiumWorld.launch({world, recorder})
  const page = await chromium.context.newPage()
  await chromium.context.grantPermissions(["clipboard-read", "clipboard-write"], {origin: world.baseUrl})
  const dashboard = await new DashboardDriver({page, recorder}).open(world.baseUrl)
  assert.equal(await dashboard.page.locator(dashboardSelectors.root).getAttribute("data-status"), "ok")
  await dashboard.section("access").waitFor({state: "visible"})
  await dashboard.section("pairing").waitFor({state: "visible"})
  await dashboard.section("browsers").waitFor({state: "visible"})
  await dashboard.section("discoveries").waitFor({state: "visible"})
  await dashboard.section("registrations").waitFor({state: "visible"})

  const rejected = new SimulatedBrowser({baseUrl: world.baseUrl, producer: recorder.producers.protocol}); browsers.push(rejected)
  await rejected.connect(); const rejectedPairing = await rejected.pair({displayName: "Rejected Dashboard Browser"})
  await dashboard.refresh()
  await dashboard.page.evaluate(() => window.liveSocket.enableLatencySim(200))
  const rejectedRow = dashboard.row("pairing", rejectedPairing.pairing_id)
  const staleReject = await rejectedRow.getByRole("button", {name: "Reject", exact: true}).elementHandle()
  const rejecting = rejectedRow.getByRole("button", {name: "Reject", exact: true}).click()
  await rejectedRow.getByRole("button", {name: "Reject", exact: true}).waitFor({state: "visible"})
  await dashboard.page.locator(`#pairing-${rejectedPairing.pairing_id} .phx-click-loading`).waitFor({state: "visible"})
  await rejecting
  await rejectedRow.waitFor({state: "detached"})
  await dashboard.page.evaluate(() => window.liveSocket.disableLatencySim())
  assert.equal((await rejected.pairingStatus()).payload.status, "rejected")
  await dashboard.assertActionUnavailable("pairing", rejectedPairing.pairing_id, "Reject")
  await assert.rejects(staleReject.click(), /not connected|not attached|detached/i)

  const browser = new SimulatedBrowser({baseUrl: world.baseUrl, producer: recorder.producers.protocol}); browsers.push(browser)
  await browser.connect(); const pending = await browser.pair({displayName: "Dashboard Browser"})
  await dashboard.refresh()
  const browserId = await dashboard.approvePairing(pending.pairing_id, "Dashboard Browser")
  assert.equal((await browser.pairingStatus()).payload.status, "approved")
  await browser.authenticate(browserId)
  assert.match(await dashboard.row("browser", browserId).textContent(), /Paired.*Granted sites only.*Scanning/s)

  const ignoredObservation = browser.observation(31, {origin: "https://ignored.example", toolCount: 2})
  const registeredObservation = browser.observation(32, {origin: "https://registered.example", toolCount: 1})
  await browser.observe([ignoredObservation, registeredObservation]); await dashboard.refresh()
  const ignoredRow = await dashboard.rowByText("discoveries", "discovery", "Fixture 31")
  const registeredRow = await dashboard.rowByText("discoveries", "discovery", "Fixture 32")
  const ignoredId = (await ignoredRow.getAttribute("id")).slice("discovery-".length)
  const discoveryId = (await registeredRow.getAttribute("id")).slice("discovery-".length)
  await dashboard.ignoreDiscovery(ignoredId); await dashboard.assertActionUnavailable("discovery", ignoredId, "Ignore")
  const registrationId = await dashboard.registerDiscovery(discoveryId, "Fixture 32")
  await dashboard.registrationSessionCount(registrationId, 0)
  await browser.observe([registeredObservation]); await dashboard.refresh()
  await dashboard.registrationSessionCount(registrationId, 1)

  for (const scope of ["read", "call"]) {
    let captured
    let retainedContext
    await dashboard.withCredential(scope, async secretContext => {
      retainedContext = secretContext
      captured = secretContext.token; assert.match(secretContext.token, /^webby_[A-Za-z0-9_-]+$/)
      if (scope === "read") {
        for (const kind of ["trace", "screenshot", "video", "dom", "clipboard", "attachment", "extension-storage"]) {
          await assert.rejects(recorder.producers.chromium.capture(kind, async () => secretContext.token), error => error.code === "secret_zone_capture_prohibited")
        }
      }
    })
    assert.ok(captured)
    assert.equal(retainedContext.token, undefined)
    await dashboard.assertSecretAbsent(captured)
    const row = await dashboard.credentialRow(scope)
    assert.match(await row.textContent(), /Revoked/)
    assert.equal(await row.getByRole("button", {name: "Revoke", exact: true}).count(), 0)
    captured = undefined
  }

  for (const mode of ["throw", "timeout", "cancel"]) {
    let captured
    const controller = new AbortController()
    if (mode === "cancel") queueMicrotask(() => controller.abort())
    let retainedContext
    const error = await dashboard.withCredential("read", async (secretContext, _id, signal) => {
      retainedContext = secretContext
      captured = secretContext.token
      if (mode === "throw") throw new Error("safe callback failure")
      return new Promise((resolve, reject) => {
        if (signal.aborted) reject(new Error("safe interrupted callback"))
        else signal.addEventListener("abort", () => reject(new Error("safe interrupted callback")), {once: true})
      })
    }, {timeoutMs: mode === "timeout" ? 25 : 1_000, signal: controller.signal}).then(() => undefined, failure => failure)
    assert.ok(error)
    assert.equal(retainedContext.token, undefined)
    assert.equal(error.message.includes(captured), false)
    if (mode !== "throw") assert.equal(error.code, `credential_operation_${mode === "cancel" ? "cancelled" : "timeout"}`)
    await dashboard.assertSecretAbsent(captured)
    assert.equal(await dashboard.section("access").locator("article[id^='mcp-credential-']").filter({has: dashboard.page.getByRole("button", {name: "Revoke", exact: true})}).count(), 0)
    captured = undefined
  }

  await dashboard.page.evaluate(() => window.liveSocket.disconnect())
  await dashboard.page.locator("[data-phx-main].phx-client-error").waitFor({state: "attached"})
  await dashboard.page.evaluate(() => window.liveSocket.connect())
  await dashboard.page.locator("[data-phx-main].phx-connected").waitFor({state: "attached"})
  await dashboard.section("browsers").waitFor({state: "visible"})

  await dashboard.revokeBrowser(browserId)
  await dashboard.assertActionUnavailable("browser", browserId, "Revoke")
  await dashboard.refresh()
  await dashboard.registrationSessionCount(registrationId, 0)
  await dashboard.refresh()
  assert.equal(await dashboard.page.locator(dashboardSelectors.root).getAttribute("data-status"), "ok")

  await chromium.close(); chromium = undefined
  const finalized = await recorder.finalize({cleanup: {dashboard: "closed", chromium: "closed"}})
  assert.ok(finalized.attestation.files.some(file => file.path.endsWith("chromium-trace.zip")))
  assert.equal(finalized.replay.first_failure, undefined)
  const evidence = Buffer.concat(await Promise.all(finalized.uploadCandidates.map(path => readFile(path))))
  assert.doesNotMatch(evidence.toString(), /webby_[A-Za-z0-9_-]{20,}/)
})
