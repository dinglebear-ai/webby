import {createHash, randomBytes, randomUUID} from "node:crypto"
import {createWriteStream} from "node:fs"
import {chmod, readFile, unlink} from "node:fs/promises"
import {createServer} from "node:net"
import {join, resolve} from "node:path"
import {spawn} from "node:child_process"
import {fileURLToPath} from "node:url"
import {atomicPrivateWrite, assertInside, assertOwnedRegular, createTempWorkspace, diskBytes, removeOwnedWorkspace} from "./temp-workspace.js"
import {captureProcessIdentity, processExists, reapProcessGroup} from "./process-tree.js"

const supportDirectory = fileURLToPath(new URL(".", import.meta.url))
const repositoryRoot = resolve(supportDirectory, "../..")

function token(bytes = 32) { return randomBytes(bytes).toString("base64url") }
function sha256(value) { return createHash("sha256").update(value).digest("hex") }
function delay(ms) { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)) }

export async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once("error", reject)
    server.listen({host: "127.0.0.1", port: 0, exclusive: true}, resolveListen)
  })
  const port = server.address().port
  let released = false
  return {
    port,
    async release() {
      if (released) return
      released = true
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
    },
  }
}

async function run(command, args, {env, stdout, stderr, timeoutMs = 60_000}) {
  const child = spawn(command, args, {cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"]})
  child.stdout.pipe(stdout, {end: false})
  child.stderr.pipe(stderr, {end: false})
  let timer
  const result = await new Promise((resolveRun, reject) => {
    timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${command} timed out`)) }, timeoutMs)
    child.once("error", reject)
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code ?? signal}`)))
  }).finally(() => clearTimeout(timer))
  return result
}

function timestampedLog(path) {
  const target = createWriteStream(path, {flags: "wx", mode: 0o600})
  let pending = ""
  return {
    stream: new TransformStreamShim(chunk => {
      pending += chunk.toString()
      const lines = pending.split("\n"); pending = lines.pop()
      for (const line of lines) target.write(`${new Date().toISOString()} ${line}\n`)
    }),
    close: async () => {
      if (pending) target.write(`${new Date().toISOString()} ${pending}\n`)
      await new Promise(resolveClose => target.end(resolveClose))
      await chmod(path, 0o600)
    },
  }
}

import {Writable} from "node:stream"
class TransformStreamShim extends Writable {
  constructor(writeChunk) { super(); this.writeChunk = writeChunk }
  _write(chunk, _encoding, callback) { try { this.writeChunk(chunk); callback() } catch (error) { callback(error) } }
}

async function readRssKb(pid) {
  const {execFile} = await import("node:child_process")
  return new Promise(resolveRss => execFile("ps", ["-o", "rss=", "-p", String(pid)], (_error, stdout) => resolveRss(Number(stdout.trim()) || 0)))
}

async function waitForReadiness(world, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let lastError
  while (Date.now() < deadline) {
    if (!(await processExists(world.pid))) throw new Error("Webby exited before readiness")
    world.metrics.peak_rss_kb = Math.max(world.metrics.peak_rss_kb, await readRssKb(world.pid))
    try {
      const response = await fetch(`${world.baseUrl}/health`, {signal: AbortSignal.timeout(1_000)})
      const body = await response.json()
      const healthCapability = body.runtime?.capabilities?.health
      if (response.status === 200 && body.service === "webby" && body.status === "ok" &&
          body.runtime?.base_url === world.baseUrl &&
          healthCapability?.instance_nonce === world.instanceNonce &&
          healthCapability?.environment_marker === "isolated-e2e") {
        const runtime = JSON.parse(await readFile(world.runtimePath, "utf8"))
        if (runtime.instance_id !== world.instanceNonce || runtime.base_url !== world.baseUrl ||
            runtime.environment_marker !== "isolated-e2e") {
          throw new Error("readiness belongs to a different instance")
        }
        return body
      }
      lastError = new Error(`health returned ${response.status}`)
    } catch (error) { lastError = error }
    await delay(Math.min(20 * 2 ** attempt++, 250))
  }
  throw new Error(`readiness timed out: ${lastError?.message ?? "no response"}`)
}

export class WebbyWorld {
  static async start(options = {}) {
    const world = new WebbyWorld(options)
    await world.start()
    return world
  }

  constructor({scenarioId = "unspecified", seed = 0, startupTimeoutMs = 45_000, preserveArtifacts = false, workspace, authorityPort = 0} = {}) {
    if (!/^[a-zA-Z0-9_-]+$/.test(scenarioId)) throw new Error("invalid scenario ID")
    if (!Number.isInteger(authorityPort) || authorityPort < 0 || authorityPort > 65_535) throw new Error("invalid authority port")
    this.scenarioId = scenarioId
    this.seed = seed
    this.startupTimeoutMs = startupTimeoutMs
    this.preserveArtifacts = preserveArtifacts
    this.workspace = workspace
    this.authorityPort = authorityPort
    this.worldId = `world-${randomUUID()}`
    this.instanceNonce = token()
    this.metrics = {startup_kind: workspace ? "warm" : "cold", startup_ms: 0, migration_ms: 0, peak_rss_kb: 0, disk_bytes: 0}
  }

  async prepare() {
    this.workspace ??= await createTempWorkspace()
    this.root = this.workspace.root
    this.databasePath = join(this.workspace.data, "webby.db")
    this.runtimePath = join(this.workspace.config, "webby-runtime.json")
    this.manifestPath = join(this.root, "world.json")
    this.telemetryPath = join(this.workspace.artifacts, "telemetry.ndjson")
    this.boundPortPath = join(this.workspace.config, "bound-port")
    this.stdoutPath = join(this.workspace.artifacts, "stdout.log")
    this.stderrPath = join(this.workspace.artifacts, "stderr.log")
    this.secretPath = join(this.workspace.config, "secret-key-base")
    this.telemetryCapabilityPath = join(this.workspace.config, "telemetry-capability")
    for (const path of [this.databasePath, this.runtimePath, this.manifestPath, this.telemetryPath, this.boundPortPath]) assertInside(this.root, path)
    this.secret = token(64)
    this.telemetryCapability = token()
    await atomicPrivateWrite(this.secretPath, this.secret)
    await atomicPrivateWrite(this.telemetryCapabilityPath, this.telemetryCapability)
    await atomicPrivateWrite(this.telemetryPath, "")
    this.fixtureReservation = await reserveLoopbackPort()
    this.fixturePort = this.fixtureReservation.port
    this.fixtureUrl = `http://127.0.0.1:${this.fixturePort}`
  }

  environment() {
    return {
      ...process.env,
      MIX_ENV: "e2e",
      PHX_SERVER: "true",
      WEBBY_ENVIRONMENT_MARKER: "isolated-e2e",
      WEBBY_E2E_WORLD_ROOT: this.root,
      WEBBY_DATABASE_PATH: this.databasePath,
      WEBBY_E2E_RUNTIME_FILE: this.runtimePath,
      WEBBY_E2E_BOUND_PORT_FILE: this.boundPortPath,
      WEBBY_E2E_INSTANCE_NONCE: this.instanceNonce,
      WEBBY_E2E_TELEMETRY_PATH: this.telemetryPath,
      WEBBY_E2E_TELEMETRY_CAPABILITY_HASH: sha256(this.telemetryCapability),
      WEBBY_PORT: "0",
      // Port zero delegates selection to RuntimeDiscovery's own listen call. The
      // authority socket is therefore acquired once and never handed off.
      WEBBY_AUTHORITY_PORT: String(this.authorityPort),
      SECRET_KEY_BASE: this.secret,
      XDG_CONFIG_HOME: this.workspace.config,
      XDG_DATA_HOME: this.workspace.data,
    }
  }

  async start() {
    await this.prepare()
    const stdout = timestampedLog(this.stdoutPath)
    const stderr = timestampedLog(this.stderrPath)
    this.logs = {stdout, stderr}
    let env = this.environment()
    try {
      const migrationStarted = performance.now()
      await run("mix", ["ecto.create", "--quiet"], {env, stdout: stdout.stream, stderr: stderr.stream})
      await run("mix", ["ecto.migrate", "--quiet"], {env, stdout: stdout.stream, stderr: stderr.stream})
      this.metrics.migration_ms = Math.round(performance.now() - migrationStarted)
      const started = performance.now()
      this.child = spawn(process.execPath, [join(supportDirectory, "world-process.js"), this.instanceNonce], {
        cwd: repositoryRoot, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
      })
      this.child.stdout.pipe(stdout.stream, {end: false})
      this.child.stderr.pipe(stderr.stream, {end: false})
      await new Promise((resolveSpawn, reject) => { this.child.once("spawn", resolveSpawn); this.child.once("error", reject) })
      this.pid = this.child.pid
      this.identity = await captureProcessIdentity(this.pid, this.instanceNonce)
      const portDeadline = Date.now() + this.startupTimeoutMs
      while (Date.now() < portDeadline) {
        try {
          this.port = Number((await readFile(this.boundPortPath, "utf8")).trim())
          if (this.port > 0) break
        } catch (error) {
          if (error.code !== "ENOENT") throw error
        }
        if (!(await processExists(this.pid))) throw new Error("Webby exited before binding")
        await delay(20)
      }
      if (!this.port) throw new Error("Webby did not atomically report a bound port")
      this.baseUrl = `http://127.0.0.1:${this.port}`
      await waitForReadiness(this, this.startupTimeoutMs)
      this.metrics.startup_ms = Math.round(performance.now() - started)
      this.metrics.disk_bytes = await diskBytes(this.root)
      await this.writeManifest()
      return this
    } catch (error) {
      if (!this.identity && this.pid && await processExists(this.pid)) {
        this.identity = await captureProcessIdentity(this.pid, this.instanceNonce).catch(() => undefined)
      }
      await this.teardown({remove: false}).catch(() => {})
      throw new Error(`${error.message}; diagnostics: ${this.stdoutPath}, ${this.stderrPath}`)
    }
  }

  async writeManifest() {
    const manifest = {
      manifest_version: 1, world_id: this.worldId, scenario_id: this.scenarioId, seed: this.seed,
      environment_marker: "isolated-e2e", instance_nonce: this.instanceNonce, pid: this.pid,
      process_group_id: this.identity.pgid, process_started: this.identity.started,
      process_executable: this.identity.executable, process_cwd: this.identity.cwd,
      base_url: this.baseUrl, fixture_url: this.fixtureUrl, database_path: this.databasePath,
      browser_profile_path: this.workspace.profile, artifact_directory: this.workspace.artifacts,
      telemetry_path: this.telemetryPath, telemetry_capability_path: this.telemetryCapabilityPath,
      stdout_path: this.stdoutPath, stderr_path: this.stderrPath, started_at: new Date().toISOString(),
      versions: {node: process.version, webby: "0.1.0"}, metrics: this.metrics,
    }
    await atomicPrivateWrite(this.manifestPath, JSON.stringify(manifest, null, 2) + "\n")
    await assertOwnedRegular(this.manifestPath, {mode: 0o600})
    this.manifest = manifest
  }

  async releaseFixturePort() { await this.fixtureReservation?.release() }

  async telemetry(capability) {
    if (sha256(capability) !== sha256(this.telemetryCapability)) throw new Error("invalid telemetry capability")
    const text = await readFile(this.telemetryPath, "utf8")
    return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : []
  }

  async restart({preserveState = true} = {}) {
    const previousDatabase = this.databasePath
    const previousRoot = this.root
    await this.teardown({remove: !preserveState})
    const replacement = new WebbyWorld({scenarioId: this.scenarioId, seed: this.seed, startupTimeoutMs: this.startupTimeoutMs, preserveArtifacts: this.preserveArtifacts, workspace: preserveState ? this.workspace : undefined, authorityPort: this.authorityPort})
    if (preserveState) {
      replacement.databasePath = previousDatabase
      for (const path of [join(previousRoot, "world.json"), join(previousRoot, "config", "bound-port"), join(previousRoot, "config", "secret-key-base"), join(previousRoot, "config", "telemetry-capability"), join(previousRoot, "artifacts", "telemetry.ndjson"), join(previousRoot, "artifacts", "stdout.log"), join(previousRoot, "artifacts", "stderr.log")]) await unlink(path).catch(() => {})
    }
    await replacement.start()
    return replacement
  }

  async teardown({remove = !this.preserveArtifacts} = {}) {
    await this.fixtureReservation?.release().catch(() => {})
    if (this.identity) await reapProcessGroup(this.identity, this.instanceNonce)
    await this.logs?.stdout.close()
    await this.logs?.stderr.close()
    this.logs = undefined
    if (remove && this.root && !this.rootRemoved) {
      await removeOwnedWorkspace(this.root)
      this.rootRemoved = true
    }
  }
}

export async function reapManifest(manifestPath) {
  await assertOwnedRegular(manifestPath, {mode: 0o600})
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  assertInside(resolve(manifestPath, ".."), manifest.database_path)
  return reapProcessGroup({pid: manifest.pid, pgid: manifest.process_group_id, started: manifest.process_started, executable: manifest.process_executable, cwd: manifest.process_cwd, uid: process.getuid?.()}, manifest.instance_nonce)
}
