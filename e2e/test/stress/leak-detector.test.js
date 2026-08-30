import assert from "node:assert/strict"
import {execFileSync, spawn} from "node:child_process"
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises"
import {createServer} from "node:net"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {assertNoLeaks, detectLeaks} from "../../support/leak-detector.js"
import {collectStressResources, runStressChild} from "../../support/stress-cli.js"

test("intentional process, listener, profile, database, pending call and session leaks fail closed", async t => {
  const root = await mkdtemp(join(tmpdir(), "webby-stress-leak-")); const profile = join(root, "profile"); const database = join(root, "webby.db")
  await mkdir(profile); await writeFile(database, "sqlite")
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio: "ignore"})
  t.after(async () => { child.kill("SIGKILL"); await new Promise(resolve => server.close(resolve)); await rm(root, {recursive: true, force: true}) })
  const report = await detectLeaks({pids: [child.pid], ports: [server.address().port], profiles: [profile], databases: [database], pendingCalls: ["call-100"], staleSessions: ["session-old"]})
  assert.deepEqual(Object.keys(report), ["processes", "listeners", "handles", "workspaces", "profiles", "databases", "pending_calls", "stale_sessions"])
  assert.throws(() => assertNoLeaks(report), /processes=1.*listeners=1.*profiles=1.*databases=1.*pending_calls=1.*stale_sessions=1/)
})

test("empty resource snapshot passes", async () => assert.deepEqual(assertNoLeaks(await detectLeaks()), {processes: [], listeners: [], handles: [], workspaces: [], profiles: [], databases: [], pending_calls: [], stale_sessions: []}))

test("stress collection records Webby and fixture listeners plus live pending and session ledgers", async t => {
  const worker = await mkdtemp(join(tmpdir(), "webby-stress-worker-ledger-")); const world = join(worker, "webby-e2e-ledger"); await mkdir(world)
  const database = join(world, "webby.db"); execFileSync("sqlite3", [database, "CREATE TABLE invocation_audits(id TEXT,outcome TEXT); CREATE TABLE document_sessions(id TEXT,status TEXT); INSERT INTO invocation_audits VALUES('call-live','started'); INSERT INTO document_sessions VALUES('session-live','active');"])
  const webby = createServer(); const fixture = createServer(); await Promise.all([new Promise(resolve => webby.listen(0, "127.0.0.1", resolve)), new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve))])
  t.after(async () => { await Promise.all([new Promise(resolve => webby.close(resolve)), new Promise(resolve => fixture.close(resolve))]); await rm(worker, {recursive: true, force: true}) })
  await writeFile(join(world, "world.json"), JSON.stringify({manifest_version: 1, world_id: "world-ledger", scenario_id: "stress-ledger", seed: 1, environment_marker: "isolated-e2e", instance_nonce: "n".repeat(32), pid: 999999, process_group_id: 999999, process_started: "now", process_executable: "node", process_cwd: world, base_url: `http://127.0.0.1:${webby.address().port}`, fixture_url: `http://127.0.0.1:${fixture.address().port}`, database_path: database, browser_profile_path: join(world, "profile"), artifact_directory: join(world, "artifacts"), telemetry_path: join(world, "telemetry"), telemetry_capability_path: join(world, "capability"), stdout_path: join(world, "stdout"), stderr_path: join(world, "stderr"), started_at: new Date().toISOString(), versions: {node: process.version, webby: "test"}, metrics: {startup_kind: "cold", startup_ms: 0, migration_ms: 0, peak_rss_kb: 0, disk_bytes: 0}}))
  const resource = {roots: [], workspaces: [], profiles: [], databases: [], pids: [], ports: [], pendingCalls: [], staleSessions: []}; await collectStressResources(worker, resource)
  assert.deepEqual(resource.ports.sort(), [fixture.address().port, webby.address().port].sort()); assert.deepEqual(resource.pendingCalls, ["call-live"]); assert.deepEqual(resource.staleSessions, ["session-live"])
})

test("stress child timeout is nonce-verified and bounded through process-group reaping", {skip: process.platform === "win32"}, async () => {
  const started = Date.now()
  await assert.rejects(runStressChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {cwd: process.cwd(), env: process.env, timeoutMs: 50}), /timed out/)
  assert.ok(Date.now() - started < 5_000)
})
