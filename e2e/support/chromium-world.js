import {execFile} from "node:child_process"
import {mkdir, readFile, rm, stat} from "node:fs/promises"
import {join, resolve} from "node:path"
import {promisify} from "node:util"
import {chromium} from "playwright"
import {BrowserArtifacts} from "./browser-artifacts.js"
import {ExtensionDriver, validateBoundWorld} from "./extension-driver.js"
import {generateTestExtension} from "./test-manifest.js"

const repositoryRoot = resolve(new URL("../..", import.meta.url).pathname)
const execFileAsync = promisify(execFile)
const assetBuilds = new Map()

async function validateAssets(root = repositoryRoot) {
  for (const name of [join("js", "app.js"), join("css", "app.css")]) {
    const path = join(root, "priv", "static", "assets", name)
    const info = await stat(path)
    if (!info.isFile() || info.size === 0) throw new Error(`Phoenix asset is absent or empty: assets/${name}`)
  }
}

export async function prepareChromiumAssets({producer, root = repositoryRoot, timeoutMs = 120_000, execute = execFileAsync, builds = assetBuilds} = {}) {
  if (!producer?.event || !producer?.diagnostic) throw new Error("Chromium artifact producer is required")
  let preparation = builds.get(root)
  if (!preparation) {
    preparation = (async () => {
      try {
        const result = await execute("mix", ["assets.build"], {cwd: root, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024})
        await validateAssets(root)
        await producer.event("browser.assets_prepared", {command: "mix assets.build", status: "ok"})
        return result
      } catch (error) {
        builds.delete(root)
        await producer.diagnostic("asset-build-failure.json", {
          command: "mix assets.build", status: "failed", code: String(error.code ?? "asset_build_failed"),
          stdout: String(error.stdout ?? "").slice(-16_384), stderr: String(error.stderr ?? error.message ?? "").slice(-16_384),
        }, ["command", "status", "code", "stdout", "stderr"]).catch(() => {})
        throw new Error(`Phoenix asset preparation failed: ${error.message}`, {cause: error})
      }
    })()
    builds.set(root, preparation)
  }
  await preparation
  await validateAssets(root)
}

export class ChromiumWorld {
  static async launch({world, recorder, extensionSource = join(repositoryRoot, "extension"), closeTimeoutMs = 10_000, chromiumApi = chromium, broadHostPermissions = false} = {}) {
    if (!world?.manifest && world?.manifestPath) world.manifest = JSON.parse(await readFile(world.manifestPath, "utf8"))
    const manifest = world?.manifest ?? world
    if (!manifest?.browser_profile_path || !manifest?.artifact_directory) throw new Error("live world manifest is required")
    if (!recorder?.producers?.chromium) throw new Error("central ArtifactRecorder Chromium producer is required")
    await prepareChromiumAssets({producer: recorder.producers.chromium})
    const extensionPath = join(resolve(manifest.browser_profile_path, ".."), "generated-extension")
    await mkdir(resolve(manifest.browser_profile_path), {recursive: true, mode: 0o700})
    await rm(extensionPath, {recursive: true, force: true})
    const generated = await generateTestExtension({source: extensionSource, destination: extensionPath, fixtureUrl: manifest.fixture_url, world: manifest, broadHostPermissions})
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
    const errors = []
    try {
      await this.artifacts.drain()
      if (!this.traceCaptured) await this.captureTrace()
    } catch (error) { errors.push(error) }
    let timeout
    try {
      await Promise.race([
        context.close(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(Object.assign(new Error("Chromium close timed out"), {code: "chromium_close_timeout"})), this.closeTimeoutMs) }),
      ])
    } catch (error) { errors.push(error) }
    finally { clearTimeout(timeout); this.context = undefined }
    try {
      await this.artifacts.drain()
      this.artifacts.assertClean()
    } catch (error) { errors.push(error) }
    if (errors.length) {
      const error = errors.length === 1 ? errors[0] : new AggregateError(errors, "Chromium close failed")
      await this.artifacts.producer.failure({summary: error.message, code: error.code ?? "chromium_close_failed"})
      if (typeof this.world?.reap === "function") await this.world.reap()
      else if (typeof this.world?.teardown === "function") await this.world.teardown({remove: false})
      throw error
    }
    await this.artifacts.drain()
  }

  async discardGeneratedCopy() { await rm(this.generated.path, {recursive: true, force: true}) }
}
