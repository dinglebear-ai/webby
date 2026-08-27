import {mkdir, readFile, rm} from "node:fs/promises"
import {join, resolve} from "node:path"
import {chromium} from "playwright"
import {BrowserArtifacts} from "./browser-artifacts.js"
import {ExtensionDriver, validateBoundWorld} from "./extension-driver.js"
import {generateTestExtension} from "./test-manifest.js"

const repositoryRoot = resolve(new URL("../..", import.meta.url).pathname)

export class ChromiumWorld {
  static async launch({world, recorder, extensionSource = join(repositoryRoot, "extension"), closeTimeoutMs = 10_000, chromiumApi = chromium} = {}) {
    if (!world?.manifest && world?.manifestPath) world.manifest = JSON.parse(await readFile(world.manifestPath, "utf8"))
    const manifest = world?.manifest ?? world
    if (!manifest?.browser_profile_path || !manifest?.artifact_directory) throw new Error("live world manifest is required")
    if (!recorder?.producers?.chromium) throw new Error("central ArtifactRecorder Chromium producer is required")
    const extensionPath = join(resolve(manifest.browser_profile_path, ".."), "generated-extension")
    await mkdir(resolve(manifest.browser_profile_path), {recursive: true, mode: 0o700})
    await rm(extensionPath, {recursive: true, force: true})
    const generated = await generateTestExtension({source: extensionSource, destination: extensionPath, fixtureUrl: manifest.fixture_url, world: manifest})
    validateBoundWorld(generated.binding, manifest)
    const args = [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    const context = await chromiumApi.launchPersistentContext(manifest.browser_profile_path, {
      channel: "chromium", headless: true, args, serviceWorkers: "allow",
    })
    // Chromium 142+ gates loopback/private-network page access behind an
    // explicit user permission. This is the isolated fixture's exact origin,
    // not a browser-wide bypass or disabled security feature.
    await context.grantPermissions(["local-network-access"], {origin: manifest.fixture_url})
    await context.tracing.start({screenshots: false, snapshots: false, sources: false})
    try {
      const artifacts = new BrowserArtifacts(recorder.producers.chromium)
      artifacts.attach(context)
      const driver = new ExtensionDriver({context, binding: generated.binding, world: manifest, artifacts})
      await driver.worker()
      const instance = new ChromiumWorld({world, manifest, context, driver, artifacts, generated, closeTimeoutMs})
      await recorder.producers.chromium.event("browser.launched", {extension_id: generated.binding.expected_extension_id, profile: "isolated", channel: "chromium"})
      return instance
    } catch (error) {
      const closed = await Promise.race([
        context.close(),
        new Promise(resolveClose => setTimeout(() => resolveClose(false), closeTimeoutMs)),
      ]).then(result => result !== false).catch(() => false)
      if (!closed) {
        if (typeof world?.reap === "function") await world.reap()
        else if (typeof world?.teardown === "function") await world.teardown({remove: false})
      }
      throw error
    }
  }

  constructor(values) { Object.assign(this, values) }

  async screenshot(page, name = "chromium-page.png") {
    const path = join(this.manifest.artifact_directory, name)
    await this.artifacts.capture("screenshot", () => page.screenshot({path}))
    return this.artifacts.producer.artifact(path, {name, kind: "screenshot", essential: false})
  }

  async captureTrace(name = "chromium-trace.zip") {
    if (this.traceCaptured) return this.traceCaptured
    const tracePath = join(this.manifest.artifact_directory, name)
    await this.context.tracing.stop({path: tracePath})
    this.traceCaptured = await this.artifacts.producer.artifact(tracePath, {name, kind: "trace", essential: false})
    return this.traceCaptured
  }

  async close() {
    if (!this.context) return
    const context = this.context
    let timeout
    try {
      await this.artifacts.drain()
      this.artifacts.assertClean()
      if (!this.traceCaptured) await this.captureTrace()
      await Promise.race([
        context.close(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(Object.assign(new Error("Chromium close timed out"), {code: "chromium_close_timeout"})), this.closeTimeoutMs) }),
      ])
    } catch (error) {
      await this.artifacts.producer.failure({summary: error.message, code: error.code ?? "chromium_close_failed"})
      if (typeof this.world?.reap === "function") await this.world.reap()
      else if (typeof this.world?.teardown === "function") await this.world.teardown({remove: false})
      throw error
    } finally { clearTimeout(timeout); this.context = undefined }
    await this.artifacts.drain()
    this.artifacts.assertClean()
  }

  async discardGeneratedCopy() { await rm(this.generated.path, {recursive: true, force: true}) }
}
