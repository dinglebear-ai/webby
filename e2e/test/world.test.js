import assert from "node:assert/strict"
import {execFile, spawn} from "node:child_process"
import {chmod, lstat, mkdir, open, readFile, stat, symlink, writeFile} from "node:fs/promises"
import {createServer} from "node:net"
import {promisify} from "node:util"
import test from "node:test"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import {WebbyWorld, reapManifest, reserveLoopbackPort} from "../support/world.js"
import {captureProcessIdentity, processExists, processGroupMembers, reapProcessGroup} from "../support/process-tree.js"
import {atomicPrivateWrite, createTempWorkspace, diskBytes, openFileHandles, removeOwnedWorkspace} from "../support/temp-workspace.js"

const execFileAsync = promisify(execFile)
const worlds = new Set()

async function start(options) {
  const world = await WebbyWorld.start(options)
  worlds.add(world)
  return world
}

async function stop(world, options) {
  if (!world) return
  await world.teardown(options)
  worlds.delete(world)
}

test.afterEach(async () => {
  await Promise.all([...worlds].map(world => stop(world).catch(() => {})))
})

test("private workspaces and exclusive writes reject symlink substitution", async () => {
  const workspace = await createTempWorkspace("webby-security-")
  try {
    assert.equal((await stat(workspace.root)).mode & 0o777, 0o700)
    const privatePath = `${workspace.config}/token`
    await atomicPrivateWrite(privatePath, "secret")
    assert.equal((await stat(privatePath)).mode & 0o777, 0o600)
    await assert.rejects(atomicPrivateWrite(privatePath, "replacement"), /refusing to replace/)
    await symlink(privatePath, `${workspace.config}/substitute`)
    await assert.rejects(atomicPrivateWrite(`${workspace.config}/substitute`, "replacement"), /refusing to replace/)
  } finally {
    await removeOwnedWorkspace(workspace.root)
  }
})

test("disk budgets count browser-profile symlinks without following them and reject all others", async () => {
  const workspace = await createTempWorkspace("webby-disk-symlink-")
  try {
    await writeFile(`${workspace.profile}/target`, "browser-data")
    await symlink("target", `${workspace.profile}/RunningChromeVersion`)
    assert.ok(await diskBytes(workspace.root, {symlinkRoots: [workspace.profile]}) > 0)
    await symlink(workspace.profile, `${workspace.config}/substitute`)
    await assert.rejects(diskBytes(workspace.root, {symlinkRoots: [workspace.profile]}), /symlink in world/)
  } finally { await removeOwnedWorkspace(workspace.root) }
})

test("atomic private publication is no-clobber and never exposes partial bytes", async () => {
  const workspace = await createTempWorkspace("webby-atomic-")
  try {
    const path = `${workspace.config}/publication`
    const payload = "x".repeat(256 * 1024)
    const reader = (async () => {
      for (;;) {
        try { return await readFile(path, "utf8") } catch (error) {
          if (error.code !== "ENOENT") throw error
          await new Promise(resolve => setImmediate(resolve))
        }
      }
    })()
    await atomicPrivateWrite(path, payload)
    assert.equal(await reader, payload)
    const results = await Promise.allSettled([
      atomicPrivateWrite(`${workspace.config}/race`, "first"),
      atomicPrivateWrite(`${workspace.config}/race`, "second"),
    ])
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    assert.equal(results.filter(result => result.status === "rejected").length, 1)
  } finally { await removeOwnedWorkspace(workspace.root) }
})

test("atomic publication rejects unsafe and symlinked parents", async () => {
  const workspace = await createTempWorkspace("webby-parent-")
  try {
    const unsafe = `${workspace.root}/unsafe`
    await mkdir(unsafe, {mode: 0o700})
    await chmod(unsafe, 0o755)
    await assert.rejects(atomicPrivateWrite(`${unsafe}/value`, "x"), /wrong parent mode/)
    await symlink(workspace.config, `${workspace.root}/config-link`)
    await assert.rejects(atomicPrivateWrite(`${workspace.root}/config-link/value`, "x"), /unsafe parent|non-canonical/)
  } finally { await removeOwnedWorkspace(workspace.root) }
})

test("loopback reservations allocate distinct ports and exclude collisions", async () => {
  const [first, second] = await Promise.all([reserveLoopbackPort(), reserveLoopbackPort()])
  try {
    assert.notEqual(first.port, second.port)
    const contender = createServer()
    await assert.rejects(new Promise((resolve, reject) => {
      contender.once("error", reject)
      contender.listen({host: "127.0.0.1", port: first.port, exclusive: true}, resolve)
    }), error => error.code === "EADDRINUSE")
  } finally {
    await first.release(); await second.release()
  }
})

test("child-selected authority acquisition has no reservation handoff and rejects a live collider", {timeout: 90_000}, async t => {
  const collider = createServer()
  await new Promise((resolve, reject) => {
    collider.once("error", reject)
    collider.listen({host: "127.0.0.1", port: 0, exclusive: true}, resolve)
  })
  t.after(async () => {
    if (collider.listening) await new Promise(resolve => collider.close(resolve))
  })
  const occupiedPort = collider.address().port
  const collisionWorkspace = await createTempWorkspace("webby-authority-collision-")
  t.after(() => removeOwnedWorkspace(collisionWorkspace.root))
  const world = await start({scenarioId: "atomic-port", authorityPort: 0})
  assert.equal(collider.listening, true)
  assert.notEqual(world.port, occupiedPort)
  assert.equal((await fetch(`${world.baseUrl}/health`)).status, 200)
  await assert.rejects(
    WebbyWorld.start({scenarioId: "authority-collision", authorityPort: occupiedPort, startupTimeoutMs: 10_000, workspace: collisionWorkspace}),
    /already_running|eaddrinuse|exited before binding|diagnostics/,
  )
  assert.equal(collider.listening, true)
})

test("two real worlds migrate and attest distinct isolated identities", {timeout: 90_000}, async () => {
  const [first, second] = await Promise.all([
    start({scenarioId: "parallel-a", seed: 11}),
    start({scenarioId: "parallel-b", seed: 12}),
  ])
  for (const world of [first, second]) {
    const response = await fetch(`${world.baseUrl}/health`)
    const health = await response.json()
    assert.equal(response.status, 200)
    assert.equal(health.runtime.capabilities.health.instance_nonce, world.instanceNonce)
    assert.equal(health.runtime.capabilities.health.environment_marker, "isolated-e2e")
    const runtime = JSON.parse(await readFile(world.runtimePath, "utf8"))
    assert.equal(runtime.instance_id, world.instanceNonce)
    assert.ok(world.runtimePath.startsWith(`${world.root}/`))
    assert.ok(world.databasePath.startsWith(`${world.root}/`))
    assert.ok((await stat(world.databasePath)).size > 0)
    assert.equal((await stat(world.manifestPath)).mode & 0o777, 0o600)
    assert.ok(world.metrics.startup_ms > 0)
    assert.equal(world.metrics.startup_kind, "cold")
    assert.ok(world.metrics.migration_ms > 0)
    assert.ok(world.metrics.peak_rss_kb > 0)
  }
  assert.notEqual(first.port, second.port)
  assert.notEqual(first.fixturePort, second.fixturePort)
  assert.notEqual(first.databasePath, second.databasePath)
  assert.notEqual(first.instanceNonce, second.instanceNonce)
  assert.notEqual(await readFile(first.secretPath, "utf8"), await readFile(second.secretPath, "utf8"))
})

test("world manifest validates and never embeds credential values", {timeout: 60_000}, async () => {
  const world = await start({scenarioId: "manifest", seed: 42})
  const schema = JSON.parse(await readFile(new URL("../support/world-manifest.schema.json", import.meta.url), "utf8"))
  const ajv = new Ajv2020({strict: true, allErrors: true})
  addFormats(ajv)
  const manifest = JSON.parse(await readFile(world.manifestPath, "utf8"))
  assert.equal(ajv.compile(schema)(manifest), true)
  const serialized = JSON.stringify(manifest)
  assert.ok(!serialized.includes(world.secret))
  assert.ok(!serialized.includes(world.telemetryCapability))
})

test("capability-authenticated telemetry records real repository queries", {timeout: 60_000}, async () => {
  const world = await start({scenarioId: "telemetry"})
  await assert.rejects(world.telemetry("wrong-capability"), /invalid telemetry capability/)
  const records = await world.telemetry(world.telemetryCapability)
  assert.ok(records.length > 0)
  assert.ok(records.every(record => record.instance_nonce === world.instanceNonce))
  assert.ok(records.every(record => record.event.join(".") === "webby.repo.query"))
  assert.ok(records.every(record => record.capability_hash && !record.capability_hash.includes(world.telemetryCapability)))
})

test("preserved restart retains durable browser state while fresh restart does not", {timeout: 120_000}, async () => {
  let world = await start({scenarioId: "restart", seed: 7})
  const now = "2026-08-27T12:00:00"
  await execFileAsync("sqlite3", [world.databasePath, `INSERT INTO browsers(id,display_name,extension_id,public_key,scanning_mode,paired_at,inserted_at,updated_at) VALUES('00000000-0000-0000-0000-000000000001','E2E','extension-preserved',X'01','granted_sites','${now}','${now}','${now}')`])
  await execFileAsync("sqlite3", [world.databasePath, `INSERT INTO page_registrations(id,slug,display_name,origin,url_pattern,preferred_browser_id,auto_attach,enabled,exposure_mode,inserted_at,updated_at) VALUES('00000000-0000-0000-0000-000000000002','live-page','Live Page','https://fixture.test','/*','00000000-0000-0000-0000-000000000001',1,1,'broker','${now}','${now}'); INSERT INTO document_sessions(id,browser_id,registration_id,tab_id,document_id,current_origin,sanitized_path,page_title,catalog_revision,catalog_fingerprint,catalog_summary,connected_at,last_seen_at,status,inserted_at,updated_at) VALUES('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',1,'doc-live','https://fixture.test','/','Live',1,'fingerprint','{"tools":[]}','${now}','${now}','active','${now}','${now}')`])
  assert.equal((await execFileAsync("sqlite3", [world.databasePath, "SELECT status FROM document_sessions WHERE document_id='doc-live'"])).stdout.trim(), "active")
  const oldPid = world.pid
  const oldBaseUrl = world.baseUrl
  worlds.delete(world)
  world = await world.restart({preserveState: true})
  worlds.add(world)
  assert.equal((await execFileAsync("sqlite3", [world.databasePath, "SELECT count(*) FROM browsers WHERE extension_id='extension-preserved'"])).stdout.trim(), "1")
  assert.equal((await execFileAsync("sqlite3", [world.databasePath, "SELECT status FROM document_sessions WHERE document_id='doc-live'"])).stdout.trim(), "closed")
  assert.equal(world.metrics.startup_kind, "warm")
  assert.equal(world.baseUrl, oldBaseUrl)
  assert.notEqual(world.pid, oldPid)
  assert.equal(await processExists(oldPid), false)
  const preservedRoot = world.root
  worlds.delete(world)
  world = await world.restart({preserveState: false})
  worlds.add(world)
  assert.notEqual(world.root, preservedRoot)
  assert.equal(world.metrics.startup_kind, "cold")
  assert.equal((await execFileAsync("sqlite3", [world.databasePath, "SELECT count(*) FROM browsers WHERE extension_id='extension-preserved'"])).stdout.trim(), "0")
})

test("identity-verified reaping is idempotent and refuses stale manifests", {timeout: 60_000}, async () => {
  const world = await start({scenarioId: "reaper"})
  await assert.rejects(reapProcessGroup({...world.identity, started: "stale"}, world.instanceNonce), /identity mismatch/)
  assert.equal(await processExists(world.pid), true)
  await reapManifest(world.manifestPath)
  assert.equal(await processExists(world.pid), false)
  const second = await reapManifest(world.manifestPath)
  assert.equal(second.alreadyGone, true)
  world.identity = undefined
})

test("reaper empties a process group after its leader exits with a listening descendant", {timeout: 30_000}, async () => {
  const nonce = `descendant-${Date.now()}`
  const leader = spawn(process.execPath, [new URL("../support/process-tree-fixture.js", import.meta.url).pathname, "leader", nonce], {detached: true, stdio: ["pipe", "pipe", "inherit"]})
  const identity = await captureProcessIdentity(leader.pid, nonce)
  const port = Number(await new Promise(resolve => leader.stdout.once("data", chunk => resolve(chunk.toString().trim()))))
  leader.stdin.write("exit\n")
  await new Promise(resolve => leader.once("exit", resolve))
  assert.ok((await processGroupMembers(identity.pgid)).length > 0)
  await reapProcessGroup(identity, nonce)
  assert.deepEqual(await processGroupMembers(identity.pgid), [])
  await assert.rejects(fetch(`http://127.0.0.1:${port}`))
})

test("a separate external reaper cleans a world after controller death", {timeout: 60_000}, async () => {
  const controller = await execFileAsync(process.execPath, [new URL("../support/world-controller.js", import.meta.url).pathname], {cwd: new URL("../..", import.meta.url).pathname, timeout: 45_000})
  const abandoned = JSON.parse(controller.stdout.trim())
  assert.equal((await fetch(`${abandoned.baseUrl}/health`)).status, 200)
  const reaped = await execFileAsync(process.execPath, [new URL("../support/world-reaper.js", import.meta.url).pathname, abandoned.manifestPath])
  assert.equal(JSON.parse(reaped.stdout).alreadyGone, false)
  assert.equal(await processExists(abandoned.pid), false)
  await assert.rejects(fetch(`${abandoned.baseUrl}/health`))
  await removeOwnedWorkspace(abandoned.root)
})

test("manifest reaping rejects symlinks and PID-reuse identity mismatch", {timeout: 60_000}, async () => {
  const world = await start({scenarioId: "reaper-security"})
  const linked = `${world.root}/linked-manifest.json`
  await symlink(world.manifestPath, linked)
  await assert.rejects(reapManifest(linked), /not an owned regular file/)
  const reused = {...world.manifest, pid: process.pid, process_group_id: process.pid, process_started: "reused"}
  const reusedPath = `${world.root}/reused-manifest.json`
  await atomicPrivateWrite(reusedPath, `${JSON.stringify(reused)}\n`)
  await assert.rejects(reapManifest(reusedPath), /identity mismatch/)
  assert.equal(await processExists(world.pid), true)
})

test("startup timeout and forced crash reap partial process state", {timeout: 60_000}, async () => {
  const workspace = await createTempWorkspace("webby-timeout-")
  await assert.rejects(WebbyWorld.start({scenarioId: "timeout", startupTimeoutMs: 1, workspace}), /diagnostics:/)
  const world = await start({scenarioId: "forced-crash"})
  const {baseUrl, identity} = world
  process.kill(-identity.pgid, "SIGKILL")
  while ((await processGroupMembers(identity.pgid)).length > 0) await new Promise(resolve => setImmediate(resolve))
  await world.teardown({remove: false})
  world.identity = undefined
  worlds.delete(world)
  await assert.rejects(fetch(`${baseUrl}/health`))
  await removeOwnedWorkspace(world.root)
  await removeOwnedWorkspace(workspace.root)
})

test("teardown removes listeners and is safe when repeated", {timeout: 60_000}, async () => {
  const world = await start({scenarioId: "cleanup"})
  const {baseUrl, pid, root} = world
  await stop(world)
  assert.equal(await processExists(pid), false)
  await assert.rejects(fetch(`${baseUrl}/health`))
  await assert.rejects(lstat(root), error => error.code === "ENOENT")
  await world.teardown()
})

test("teardown detects an intentionally leaked open file handle before removing the world", {timeout: 60_000}, async () => {
  const world = await start({scenarioId: "leaked-handle"})
  const leakedPath = `${world.workspace.artifacts}/intentional-leak.txt`
  const leakedHandle = await open(leakedPath, "wx", 0o600)
  await leakedHandle.writeFile("held open during teardown")
  const root = world.root
  try {
    await assert.rejects(stop(world), /world root has open file handles/)
    assert.ok((await openFileHandles(root)).some(handle => handle.pid === process.pid && handle.path.endsWith("/artifacts/intentional-leak.txt")))
    assert.equal((await lstat(root)).isDirectory(), true)
  } finally {
    await leakedHandle.close()
    await world.teardown()
    worlds.delete(world)
  }
  await assert.rejects(lstat(root), error => error.code === "ENOENT")
})

test("startup failure retains private timestamped diagnostics", {timeout: 20_000}, async () => {
  const workspace = await createTempWorkspace("webby-failure-")
  await writeFile(`${workspace.data}/webby.db`, "not sqlite", {mode: 0o600})
  await assert.rejects(WebbyWorld.start({scenarioId: "bad-start", startupTimeoutMs: 2_000, workspace}), /diagnostics:/)
  const stderr = await readFile(`${workspace.artifacts}/stderr.log`, "utf8")
  assert.match(stderr, /^\d{4}-\d\d-\d\dT/m)
  assert.equal((await stat(`${workspace.artifacts}/stderr.log`)).mode & 0o777, 0o600)
  await removeOwnedWorkspace(workspace.root)
})
