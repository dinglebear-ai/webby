import assert from "node:assert/strict"
import {EventEmitter} from "node:events"
import {lstat, mkdtemp, readFile, readdir, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"
import test from "node:test"
import {ArtifactRecorder} from "../support/artifacts.js"
import {BrowserArtifacts, classifyBrowserError} from "../support/browser-artifacts.js"
import {ChromiumWorld, cleanupFailedChromiumLaunch} from "../support/chromium-world.js"
import {validateBoundWorld} from "../support/extension-driver.js"
import {extensionIdForKey, generateTestExtension, hashExtensionTree, RUNTIME_EXTENSION_FILES, TEST_MANIFEST_KEY} from "../support/test-manifest.js"
import {WebbyWorld} from "../support/world.js"
import {startFixtureServer} from "../fixture/server.js"

const repositoryRoot = resolve(new URL("../..", import.meta.url).pathname)
const extensionRoot = join(repositoryRoot, "extension")

function manifest(values = {}) {
  return {
    world_id: "world_browser_test", environment_marker: "isolated-e2e", instance_nonce: "n".repeat(43),
    base_url: "http://127.0.0.1:65001", fixture_url: "http://127.0.0.1:65002", ...values,
  }
}

function binding(world = manifest(), values = {}) {
  return {
    expected_extension_id: extensionIdForKey(), environment_marker: world.environment_marker,
    instance_nonce: world.instance_nonce, base_url: world.base_url, fixture_url: world.fixture_url, ...values,
  }
}

test("public manifest key deterministically pins a Chrome extension ID", () => {
  assert.match(TEST_MANIFEST_KEY, /^[A-Za-z0-9+/=]+$/)
  assert.match(extensionIdForKey(), /^[a-p]{32}$/)
  assert.equal(extensionIdForKey(), extensionIdForKey(TEST_MANIFEST_KEY))
})

test("generated copy only adds approved manifest and isolated binding material", async () => {
  const root = await mkdtemp(join(tmpdir(), "webby-extension-copy-"))
  const destination = join(root, "extension")
  try {
    const before = await hashExtensionTree(extensionRoot)
    const generated = await generateTestExtension({source: extensionRoot, destination, fixtureUrl: manifest().fixture_url, world: manifest()})
    assert.equal(await hashExtensionTree(extensionRoot), before)
    assert.equal(generated.productionHash, before)
    assert.equal(generated.manifest.key, TEST_MANIFEST_KEY)
    assert.deepEqual(generated.manifest.host_permissions, ["http://127.0.0.1/*"])
    assert.equal(generated.binding.expected_extension_id, extensionIdForKey())
    const generatedWorker = await readFile(join(destination, "src", "service_worker.js"), "utf8")
    assert.match(generatedWorker, /createIsolatedE2EDiagnostics/)
    assert.doesNotMatch(generatedWorker, /import\("\.\/service_worker\.js"\)/)
    assert.match(await readFile(join(destination, "src", "e2e_binding.js"), "utf8"), /isolated-e2e/)
    assert.equal(generated.manifest.background.service_worker, "src/service_worker.js")
    assert.equal(generated.manifest.version_name, "isolated-e2e")
    const walk = async (directory, prefix = "") => (await Promise.all((await readdir(directory, {withFileTypes: true})).map(async entry => {
      const relative = join(prefix, entry.name)
      const path = join(directory, entry.name)
      assert.equal((await lstat(path)).isSymbolicLink(), false, relative)
      return entry.isDirectory() ? walk(path, relative) : [relative]
    }))).flat()
    const copied = (await walk(destination)).sort()
    assert.equal(copied.some(path => path.startsWith("node_modules/")), false)
    assert.deepEqual(copied, [...RUNTIME_EXTENSION_FILES, "e2e-binding.json"].sort())
  } finally { await rm(root, {recursive: true, force: true}) }
})

test("failed Chromium launch cleanup records timeout and force-closes the browser", async () => {
  const context = new EventEmitter()
  context.close = () => new Promise(() => {})
  context.pages = () => [{}]
  let forced = 0
  context.newCDPSession = async () => ({
    async send(command) {
      assert.equal(command, "Browser.close")
      forced += 1
      queueMicrotask(() => context.emit("close"))
    },
    async detach() {}
  })
  const artifacts = {duringExpectedBrowserShutdown: operation => operation()}
  const failures = await cleanupFailedChromiumLaunch(context, artifacts, 5)
  assert.equal(forced, 1)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].code, "chromium_launch_close_timeout")

  context.newCDPSession = async () => ({async send() { throw new Error("forced close failed") }, async detach() {}})
  const failedForce = await cleanupFailedChromiumLaunch(context, artifacts, 5)
  assert.deepEqual(failedForce.map(error => error.code ?? error.message), ["chromium_launch_close_timeout", "forced close failed"])
})

test("binding rejects wrong worlds, stale copies, remote/developer/default endpoints, and authority collapse", () => {
  const world = manifest()
  assert.equal(validateBoundWorld(binding(world), world), true)
  for (const candidate of [
    binding(world, {instance_nonce: "x".repeat(43)}),
    binding(world, {expected_extension_id: "a".repeat(32)}),
    binding(world, {base_url: "https://example.com"}),
    binding(world, {base_url: "http://127.0.0.1:6477"}),
    binding(world, {fixture_url: world.base_url}),
    binding(world, {environment_marker: "dev"}),
  ]) assert.throws(() => validateBoundWorld(candidate, world))
})

test("central classifier narrowly recognizes restart transients and rejects real browser errors", () => {
  assert.equal(classifyBrowserError({kind: "page_error", text: "Service worker restarted"}).severity, "transient")
  assert.equal(classifyBrowserError({kind: "page_error", text: "private JWK leaked"}).severity, "failure")
  assert.equal(classifyBrowserError({kind: "console", text: {level: "info", message: "ready"}}).severity, "diagnostic")
  assert.equal(classifyBrowserError({kind: "worker_console", text: {level: "error", message: "boom"}}).severity, "failure")
  assert.equal(classifyBrowserError({kind: "worker_console", text: {level: "info", message: "ready"}}).severity, "diagnostic")
  const refused = {kind: "network_error", text: {message: "net::ERR_CONNECTION_REFUSED", url: "http://127.0.0.1:65001/health"}}
  assert.equal(classifyBrowserError(refused).severity, "failure")
  assert.equal(classifyBrowserError({...refused, expectedNetworkOutage: true}).code, "expected_restart_outage")
  const aborted = {kind: "network_error", text: {message: "net::ERR_ABORTED", url: "http://127.0.0.1:65001/"}}
  assert.equal(classifyBrowserError(aborted).severity, "failure")
  assert.equal(classifyBrowserError({...aborted, expectedNetworkOutage: true}).code, "expected_restart_outage")
  const errorPage = {kind: "worker_console", text: {level: "error", message: "Webby tab scan failed {error: Error:Frame with ID 1 is showing error page}"}}
  assert.equal(classifyBrowserError(errorPage).severity, "failure")
  const revokedTabClose = {kind: "worker_console", text: {level: "error", message: "Webby removed tab close failed Error: channel_not_ready", url: `chrome-extension://${extensionIdForKey()}/src/service_worker.js`}, expectedExtensionId: extensionIdForKey(), expectedBrowserRevocation: true}
  assert.equal(classifyBrowserError(revokedTabClose).code, "expected_revoked_tab_close")
  assert.equal(classifyBrowserError({...errorPage, expectedNetworkOutage: true}).code, "expected_restart_error_page")
  const revokedClose = {kind: "worker_console", text: {level: "error", message: "Webby observation close failed; resync required {error: channel_not_ready}", url: "chrome-extension://bound/src/service_worker.js"}}
  assert.equal(classifyBrowserError(revokedClose).severity, "failure")
  assert.equal(classifyBrowserError({...revokedClose, expectedBrowserRevocation: true}).code, "expected_revoked_observation_close")
  const revokedEvent = {kind: "worker_console", text: {level: "error", message: "Webby channel event failed {error: Error: channel_disconnected}", url: "chrome-extension://bound/src/service_worker.js"}}
  assert.equal(classifyBrowserError(revokedEvent).severity, "failure")
  assert.equal(classifyBrowserError({...revokedEvent, expectedBrowserRevocation: true}).code, "expected_revoked_channel_disconnect")
  const revokedCall = {...revokedEvent, text: {...revokedEvent.text, message: "Webby channel event failed {callId: a3d3bda1-a1f9-4212-aa92-6b976783b03a, error: Error: channel_disconnected\n    at socket.onclose (chrome-extension://bound/src/channel.js:1:1)}"}}
  assert.equal(classifyBrowserError({...revokedCall, expectedBrowserRevocation: true}).code, "expected_revoked_channel_disconnect")
  assert.equal(classifyBrowserError({...revokedCall, text: {...revokedCall.text, url: "service-worker"}, expectedBrowserRevocation: true, expectedExtensionId: "a".repeat(32)}).code, "expected_revoked_channel_disconnect")
  const notReadyCall = {...revokedCall, text: {...revokedCall.text, url: "service-worker", message: revokedCall.text.message.replace("channel_disconnected", "channel_not_ready")}}
  assert.equal(classifyBrowserError({...notReadyCall, expectedBrowserRevocation: true, expectedExtensionId: "a".repeat(32)}).code, "expected_revoked_channel_not_ready")
  assert.equal(classifyBrowserError({...revokedCall, text: {...revokedCall.text, url: "service-worker"}, expectedBrowserRevocation: true}).severity, "failure")
  const shutdownAbort = {kind: "network_error", text: {message: "net::ERR_ABORTED", url: "http://127.0.0.1:65001/"}}
  assert.equal(classifyBrowserError(shutdownAbort).severity, "failure")
  assert.equal(classifyBrowserError({...shutdownAbort, expectedBrowserShutdown: true}).code, "expected_browser_shutdown_abort")
  const shutdownConsole = {kind: "worker_console", text: {level: "error", message: "Webby E2E binding failed Error: The browser is shutting down.", url: `chrome-extension://${"a".repeat(32)}/src/service_worker.js`}, expectedExtensionId: "a".repeat(32)}
  assert.equal(classifyBrowserError(shutdownConsole).severity, "failure")
  assert.equal(classifyBrowserError({...shutdownConsole, expectedBrowserShutdown: true}).code, "expected_browser_shutdown_console")
  assert.equal(classifyBrowserError({...shutdownConsole, expectedBrowserShutdown: true, text: {...shutdownConsole.text, message: `${shutdownConsole.text.message} unexpected`}}).severity, "failure")
  assert.equal(classifyBrowserError({...shutdownConsole, expectedBrowserShutdown: true, text: {...shutdownConsole.text, url: "service-worker"}}).severity, "failure")
  const capacityDenial = {kind: "console", text: {level: "error", message: "Failed to load resource: the server responded with a status of 400 (Bad Request)", url: "http://127.0.0.1:65002/__fixture/wait?scenario_id=chromium_invocation_tools&call_id=capacity_99"}}
  assert.equal(classifyBrowserError(capacityDenial).severity, "failure")
  assert.equal(classifyBrowserError({...capacityDenial, expectedFixtureCapacityDenial: true}).code, "expected_fixture_capacity_denial")
  assert.equal(classifyBrowserError({...capacityDenial, expectedFixtureCapacityDenial: true, text: {...capacityDenial.text, message: "Failed to load resource: the server responded with a status of 401 (Unauthorized)"}}).severity, "failure")
  assert.equal(classifyBrowserError({...capacityDenial, expectedFixtureCapacityDenial: true, text: {...capacityDenial.text, url: capacityDenial.text.url.replace("capacity_99", "other_99")}}).severity, "failure")
  assert.equal(classifyBrowserError({...revokedCall, text: {...revokedCall.text, message: revokedCall.text.message.replace("channel_disconnected", "unexpected_failure")}, expectedBrowserRevocation: true}).severity, "failure")
  assert.equal(classifyBrowserError({...revokedEvent, kind: "console", expectedBrowserRevocation: true}).severity, "failure")
  assert.equal(classifyBrowserError({...revokedEvent, text: {...revokedEvent.text, url: "https://fixture.test/"}, expectedBrowserRevocation: true}).severity, "failure")
})

test("browser artifacts obey recorder secret zones", async () => {
  const root = await mkdtemp(join(tmpdir(), "webby-browser-artifacts-"))
  const recorder = await new ArtifactRecorder({root, scenarioId: "chromium_secret_zone", worldId: "world_browser", secrets: ["private-jwk-value"]}).open()
  const artifacts = new BrowserArtifacts(recorder.producers.chromium)
  await assert.rejects(recorder.producers.chromium.secretZone("extension-storage", () => artifacts.capture("extension-storage", async () => ({privateKey: "private-jwk-value"}))), error => error.code === "secret_zone_capture_prohibited")
  await recorder.finalize({status: "passed"})
  assert.doesNotMatch(await readFile(join(root, "sanitized-staging", "events.ndjson"), "utf8"), /private-jwk-value/)
  await rm(root, {recursive: true, force: true})
})

test("browser artifact shutdown drains delayed failures before asserting clean", async () => {
  let release
  const producer = {
    event: () => new Promise(resolve => { release = resolve }), capture: (_kind, operation) => operation(),
    diagnostic: async () => {},
  }
  const artifacts = new BrowserArtifacts(producer)
  artifacts.record("page_error", {message: "delayed failure", url: "https://fixture.test"})
  const drained = artifacts.drain()
  release()
  await drained
  assert.throws(() => artifacts.assertClean(), /delayed failure/)
})

test("bundled Chromium loads the bound unpacked MV3 extension and drives observable surfaces", {timeout: 120_000}, async () => {
  const world = await WebbyWorld.start({scenarioId: "chromium_bootstrap", seed: 7, preserveArtifacts: true})
  await world.releaseFixturePort()
  const fixture = await startFixtureServer({worldId: world.worldId, port: world.fixturePort})
  const recorder = await new ArtifactRecorder({root: join(world.workspace.artifacts, "chromium-recorder"), scenarioId: world.scenarioId, worldId: world.worldId, secrets: [world.secret, fixture.capability]}).open()
  let browser
  try {
    browser = await ChromiumWorld.launch({world, recorder})
    const driver = browser.driver
    const worker = await driver.worker()
    assert.equal(new URL(worker.url()).hostname, driver.binding.expected_extension_id)
    assert.deepEqual((await driver.storage("e2eBinding")).e2eBinding, driver.binding)

    const socketAttempts = await driver.waitForSocketAttempts()
    const deceptive = [
      "http://example.com", "https://127.0.0.1.example.com:65001", "http://127.0.0.1:65001/path",
      "http://user@127.0.0.1:65001", "http://127.0.0.1:65001?next=evil", "http://127.0.0.1:65001#evil",
    ]
    for (const url of deceptive) {
      assert.match(await driver.configure({baseUrl: url}), /loopback URL/)
      assert.equal((await driver.storage("baseUrl")).baseUrl, world.baseUrl)
      assert.equal(await driver.socketAttempts(), socketAttempts)
    }
    assert.equal(await driver.configure(), "Saved.")

    const page = await driver.newFixtureTab("/")
    const probe = await driver.capabilityProbe(page)
    assert.equal(probe.world, "MAIN")
    assert.equal(probe.execute_script, true)
    assert.equal(probe.document_ids, true)
    assert.ok(probe.page_instance_id)
    assert.equal(probe.model_context, true)
    const screenshot = await browser.screenshot(page)
    assert.equal(screenshot.kind, "screenshot")
    const trace = await browser.captureTrace()
    assert.equal(trace.kind, "trace")
    await driver.scanNow()

    const pairing = await driver.pair()
    assert.ok(pairing.pairing_id)

    assert.deepEqual((await driver.permissions()).origins, [])
    assert.equal(await driver.removeBroadPermissions(), true)
    assert.equal(await driver.configure({mode: "granted_sites"}), "Saved.")

    const privateState = await driver.storage(["privateKey", "publicKey"])
    const pendingIdentity = await driver.storage(["pairingId", "browserId"])
    recorder.addSecret(JSON.stringify(privateState.privateKey))
    await assert.rejects(recorder.producers.chromium.secretZone("private-jwk", () => browser.artifacts.capture("extension-storage", () => driver.storage(null))), error => error.code === "secret_zone_capture_prohibited")

    const restarted = await driver.suspendAndReacquireWorker()
    assert.equal(new URL(restarted.worker.url()).hostname, driver.binding.expected_extension_id)

    await browser.close()
    browser = undefined
    // Persistent profile restart proves stable identity and forces worker reacquisition.
    browser = await ChromiumWorld.launch({world, recorder})
    assert.equal((await browser.driver.storage("publicKey")).publicKey, privateState.publicKey)
    assert.deepEqual(await browser.driver.storage(["pairingId", "browserId"]), pendingIdentity)
    assert.notEqual(await browser.driver.worker(), restarted.worker)
  } finally {
    await browser?.close().catch(() => {})
    await recorder.finalize({status: "passed", cleanup: {chromium_closed: true}})
    await fixture.close().catch(() => {})
    await world.teardown({remove: true}).catch(() => {})
  }
})
