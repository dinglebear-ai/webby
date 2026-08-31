import {createHash, randomBytes, randomUUID} from "node:crypto"
import {createWriteStream} from "node:fs"
import {chmod, readFile, unlink} from "node:fs/promises"
import {createServer} from "node:net"
import {join, resolve} from "node:path"
import {spawn} from "node:child_process"
import {fileURLToPath} from "node:url"
import {atomicPrivateWrite, assertInside, assertOwnedRegular, createTempWorkspace, diskBytes, removeOwnedWorkspace} from "./temp-workspace.js"
import {captureProcessIdentity, processExists, processGroupMembers, reapProcessGroup} from "./process-tree.js"
import {assertWorldManifest, readWorldManifest} from "./runtime-contracts.js"

const supportDirectory = fileURLToPath(new URL(".", import.meta.url))
const repositoryRoot = resolve(supportDirectory, "../..")

function token(bytes = 32) { return randomBytes(bytes).toString("base64url") }
function sha256(value) { return createHash("sha256").update(value).digest("hex") }
function delay(ms) { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)) }

const sqliteMutation = String.raw`
import json, sqlite3, sys
payload = json.load(sys.stdin)
connection = sqlite3.connect(sys.argv[1], timeout=5)
try:
    if payload["operation"] == "insert":
        connection.execute("INSERT INTO mcp_credentials (id, display_name, token_hash, scopes, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", (payload["id"], payload["display_name"], bytes.fromhex(payload["token_hash"]), json.dumps(payload["scopes"], separators=(",", ":")), payload["now"], payload["now"]))
    elif payload["operation"] == "revoke":
        cursor = connection.execute("UPDATE mcp_credentials SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL", (payload["now"], payload["now"], payload["id"]))
        if cursor.rowcount != 1: raise RuntimeError("credential was missing or already revoked")
    else: raise RuntimeError("unsupported mutation")
    connection.commit()
finally:
    connection.close()
`

async function pythonSqlite(databasePath, payload) {
  const child = spawn("python3", ["-c", sqliteMutation, databasePath], {stdio: ["pipe", "pipe", "pipe"]})
  child.stdin.end(JSON.stringify(payload))
  let stderr = ""
  child.stderr.on("data", chunk => { stderr += chunk })
  await new Promise((resolveExit, reject) => {
    child.once("error", reject)
    child.once("exit", code => code === 0 ? resolveExit() : reject(new Error(`isolated SQLite mutation failed: ${stderr.trim()}`)))
  })
}

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

export async function readRssKb(pid) {
  const {execFile} = await import("node:child_process")
  return new Promise((resolveRss, reject) => execFile("ps", ["-o", "rss=", "-p", String(pid)], (error, stdout) => {
    if (error) return reject(new Error(`failed to measure RSS for process ${pid}`, {cause: error}))
    const rssKb = Number(stdout.trim())
    if (!Number.isFinite(rssKb) || rssKb <= 0) return reject(new Error(`invalid RSS measurement for process ${pid}: ${stdout.trim() || "empty"}`))
    resolveRss(rssKb)
  }))
}

async function unlinkIfPresent(path) {
  try { await unlink(path) }
  catch (error) { if (error.code !== "ENOENT") throw error }
}

export async function forceReapSpawnedGroup(child, pid, {signal = process.kill, graceMs = 2_000} = {}) {
  if (!child || child.pid !== pid) throw new Error("cannot reap an unidentified process without its spawn handle")
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise(resolveExit => child.once("exit", resolveExit))
  try { signal(-pid, "SIGKILL") }
  catch (error) { if (error.code !== "ESRCH" && error.code !== "EPERM") throw error }
  const deadline = Date.now() + graceMs
  while ((await processGroupMembers(pid)).length > 0) {
    if (Date.now() >= deadline) throw new Error("unidentified spawned process group survived SIGKILL")
    await delay(20)
  }
  await exited
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

  constructor({scenarioId = "unspecified", seed = 0, startupTimeoutMs = 45_000, preserveArtifacts = false, workspace, authorityPort = 0, listenPort = 0, invocationTimeoutMs = 120_000} = {}) {
    if (!/^[a-zA-Z0-9_-]+$/.test(scenarioId)) throw new Error("invalid scenario ID")
    if (!Number.isInteger(authorityPort) || authorityPort < 0 || authorityPort > 65_535) throw new Error("invalid authority port")
    if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65_535) throw new Error("invalid listen port")
    if (!Number.isInteger(invocationTimeoutMs) || invocationTimeoutMs < 100 || invocationTimeoutMs > 120_000) throw new Error("invalid invocation timeout")
    this.scenarioId = scenarioId
    this.seed = seed
    this.startupTimeoutMs = startupTimeoutMs
    this.preserveArtifacts = preserveArtifacts
    this.workspace = workspace
    this.authorityPort = authorityPort
    this.listenPort = listenPort
    this.invocationTimeoutMs = invocationTimeoutMs
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
    this.healthFaultPath = join(this.workspace.config, "health-degraded")
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
      WEBBY_E2E_HEALTH_FAULT_FILE: this.healthFaultPath,
      WEBBY_E2E_INVOCATION_TIMEOUT_MS: String(this.invocationTimeoutMs),
      WEBBY_PORT: String(this.listenPort),
      // Authority port zero delegates selection to RuntimeDiscovery's own
      // listen call, so that socket is acquired once and never handed off.
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
    const env = this.environment()
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
      try {
        this.identity = await captureProcessIdentity(this.pid, this.instanceNonce)
      } catch (identityError) {
        try { await forceReapSpawnedGroup(this.child, this.pid) }
        catch (reapError) {
          throw new AggregateError([identityError, reapError], "process identity capture failed and spawned process group could not be reaped", {cause: identityError})
        }
        throw identityError
      }
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
      // Chromium owns its isolated profile and creates platform-specific
      // symlinks. Count those links without following them; every other world
      // directory remains fail-closed against symlink substitution.
      this.metrics.disk_bytes = await diskBytes(this.root, {symlinkRoots: [this.workspace.profile]})
      await this.writeManifest()
      return this
    } catch (error) {
      try { await this.teardown({remove: false}) }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], `${error.message}; startup cleanup failed; diagnostics: ${this.stdoutPath}, ${this.stderrPath}`, {cause: error}) }
      throw new Error(`${error.message}; diagnostics: ${this.stdoutPath}, ${this.stderrPath}`, {cause: error})
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
    assertWorldManifest(manifest, {source: "generated world manifest"})
    await atomicPrivateWrite(this.manifestPath, JSON.stringify(manifest, null, 2) + "\n")
    await assertOwnedRegular(this.manifestPath, {mode: 0o600})
    this.manifest = manifest
  }

  async releaseFixturePort() { await this.fixtureReservation?.release() }

  async provisionCredential({scopes = ["read"]} = {}) {
    if (!this.root || !this.databasePath) throw new Error("world is not prepared")
    assertInside(this.root, this.databasePath)
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some(scope => !["read", "call"].includes(scope))) throw new Error("invalid credential scopes")
    const credentialToken = `webby_${token()}`
    const credential = {id: randomUUID(), token: credentialToken, scopes: [...new Set(scopes)]}
    const now = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")
    await pythonSqlite(this.databasePath, {operation: "insert", id: credential.id, display_name: "Isolated E2E client", token_hash: sha256(credentialToken), scopes: {values: credential.scopes}, now})
    return credential
  }

  async revokeCredential(id) {
    if (!this.root || !this.databasePath || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("invalid isolated credential")
    assertInside(this.root, this.databasePath)
    const now = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")
    await pythonSqlite(this.databasePath, {operation: "revoke", id, now})
  }

  async setHealthDegraded(active = true) {
    assertInside(this.root, this.healthFaultPath)
    if (active) {
      await atomicPrivateWrite(this.healthFaultPath, `${this.instanceNonce}\n`)
      await assertOwnedRegular(this.healthFaultPath, {mode: 0o600})
    } else {
      try { await assertOwnedRegular(this.healthFaultPath, {mode: 0o600}) }
      catch (error) { if (error.code === "ENOENT") return; throw error }
      await unlinkIfPresent(this.healthFaultPath)
    }
  }

  async telemetry(capability) {
    if (sha256(capability) !== sha256(this.telemetryCapability)) throw new Error("invalid telemetry capability")
    const text = await readFile(this.telemetryPath, "utf8")
    return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : []
  }

  async restart({preserveState = true} = {}) {
    const previousDatabase = this.databasePath
    const previousRoot = this.root
    const previousPort = this.port
    await this.teardown({remove: !preserveState})
    const replacement = new WebbyWorld({scenarioId: this.scenarioId, seed: this.seed, startupTimeoutMs: this.startupTimeoutMs, preserveArtifacts: this.preserveArtifacts, workspace: preserveState ? this.workspace : undefined, authorityPort: this.authorityPort, listenPort: preserveState ? previousPort : 0, invocationTimeoutMs: this.invocationTimeoutMs})
    if (preserveState) {
      replacement.databasePath = previousDatabase
      for (const path of [join(previousRoot, "world.json"), join(previousRoot, "config", "bound-port"), join(previousRoot, "config", "secret-key-base"), join(previousRoot, "config", "telemetry-capability"), join(previousRoot, "artifacts", "telemetry.ndjson"), join(previousRoot, "artifacts", "stdout.log"), join(previousRoot, "artifacts", "stderr.log")]) await unlinkIfPresent(path)
    }
    await replacement.start()
    return replacement
  }

  async teardown({remove = !this.preserveArtifacts} = {}) {
    const failures = []
    try { await this.setHealthDegraded(false) } catch (error) { failures.push(error) }
    try { await this.fixtureReservation?.release() } catch (error) { failures.push(error) }
    try {
      if (this.identity) await reapProcessGroup(this.identity, this.instanceNonce)
      else if (this.pid && await processExists(this.pid)) throw new Error("refusing successful teardown of a live process without captured identity")
    } catch (error) { failures.push(error) }
    try { await this.logs?.stdout.close() } catch (error) { failures.push(error) }
    try { await this.logs?.stderr.close() } catch (error) { failures.push(error) }
    this.logs = undefined
    if (remove && this.root && !this.rootRemoved) {
      try { await removeOwnedWorkspace(this.root); this.rootRemoved = true } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, "World teardown had multiple failures", {cause: failures[0]})
  }
}

export async function reapManifest(manifestPath) {
  await assertOwnedRegular(manifestPath, {mode: 0o600})
  const manifest = await readWorldManifest(manifestPath)
  assertInside(resolve(manifestPath, ".."), manifest.database_path)
  return reapProcessGroup({pid: manifest.pid, pgid: manifest.process_group_id, started: manifest.process_started, executable: manifest.process_executable, cwd: manifest.process_cwd, uid: process.getuid?.()}, manifest.instance_nonce)
}
