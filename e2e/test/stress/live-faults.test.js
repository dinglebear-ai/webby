import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {mkdtemp, readFile, rm, stat} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {promisify} from "node:util"
import test from "node:test"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {ChromiumWorld} from "../../support/chromium-world.js"
import {detectLeaks} from "../../support/leak-detector.js"
import {processExists} from "../../support/process-tree.js"
import {startFixtureServer} from "../../fixture/server.js"
import {WebbyWorld, reapManifest} from "../../support/world.js"

const execFileAsync = promisify(execFile)

async function eventually(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`condition was not satisfied within ${timeoutMs}ms`)
}

async function browserProcesses(profile) {
  const {stdout} = await execFileAsync("ps", ["-axo", "pid=,command="])
  return stdout.split("\n").filter(line => line.includes(`--user-data-dir=${profile}`)).map(line => Number(line.trim().split(/\s+/, 1)[0]))
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`live owned Webby ${signal} is bounded, externally reapable, and preserves evidence`, {timeout: 90_000}, async t => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), `webby-live-${signal.toLowerCase()}-`))
    let world = await WebbyWorld.start({scenarioId: `live-${signal.toLowerCase()}`, seed: 1, preserveArtifacts: true})
    const {baseUrl, fixturePort, manifestPath, pid, root} = world
    const recorder = await new ArtifactRecorder({root: evidenceRoot, scenarioId: `live-${signal.toLowerCase()}`, worldId: world.worldId, seed: 1, secrets: [world.secret, world.telemetryCapability]}).open()
    let finalized = false
    t.after(async () => { if (!finalized) await recorder.finalize({status: "failed"}).catch(() => {}); await world?.teardown({remove: true}).catch(() => {}); await rm(evidenceRoot, {recursive: true, force: true}) })

    await recorder.producers.world.diagnostic("termination-evidence.json", {signal, pid, process_group_id: world.identity.pgid, instance_nonce: world.instanceNonce, base_url: baseUrl}, ["signal", "pid", "process_group_id", "instance_nonce", "base_url"])
    process.kill(-world.identity.pgid, signal)
    // Invoke the external nonce-verified reaper while the group leader still
    // provides an authoritative identity. A graceful SIGTERM may otherwise
    // let the Node leader exit before its BEAM descendants have drained.
    const reaped = await reapManifest(manifestPath)
    assert.deepEqual(reaped, {alreadyGone: false}, "external reaper must concretely own and drain the live group")
    await eventually(async () => !(await processExists(pid)))
    await assert.rejects(fetch(`${baseUrl}/health`))
    await world.teardown({remove: true}); world = undefined
    const leaks = await detectLeaks({pids: [pid], ports: [Number(new URL(baseUrl).port), fixturePort], roots: [root], workspaces: [root]})
    assert.deepEqual(leaks, {processes: [], listeners: [], handles: [], workspaces: [], profiles: [], databases: [], pending_calls: [], stale_sessions: []})
    const artifact = await recorder.finalize({status: "passed", cleanup: {external_reaper: "verified", leaked_processes: 0, leaked_ports: 0, leaked_workspaces: 0}}); finalized = true
    assert.ok(artifact.attestation.files.some(file => file.path.endsWith("termination-evidence.json")))
  })
}

test("real Chromium hanging close is bounded, force-closed, and leaves no process or profile residue", {timeout: 180_000}, async t => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "webby-live-chromium-close-"))
  let world = await WebbyWorld.start({scenarioId: "live-chromium-hung-close", seed: 2, preserveArtifacts: true})
  await world.releaseFixturePort()
  let fixture = await startFixtureServer({worldId: world.worldId, port: world.fixturePort})
  const profile = world.workspace.profile; const root = world.root
  const recorder = await new ArtifactRecorder({root: evidenceRoot, scenarioId: "live-chromium-hung-close", worldId: world.worldId, seed: 2, secrets: [world.secret, world.telemetryCapability, fixture.capability]}).open()
  let chromium = await ChromiumWorld.launch({world, recorder, closeTimeoutMs: 1_000})
  let finalized = false
  t.after(async () => { await chromium?.context?.close().catch(() => {}); await fixture?.close().catch(() => {}); if (!finalized) await recorder.finalize({status: "failed"}).catch(() => {}); await world?.teardown({remove: true}).catch(() => {}); await rm(evidenceRoot, {recursive: true, force: true}) })

  assert.ok((await browserProcesses(profile)).length > 0)
  chromium.closeContext = () => new Promise(() => {})
  const started = Date.now()
  await assert.rejects(chromium.close(), error => error.code === "chromium_close_timeout" || (error instanceof AggregateError && error.errors.length === 1 && error.errors[0].code === "chromium_close_timeout"))
  assert.ok(Date.now() - started < 10_000)
  await eventually(async () => (await browserProcesses(profile)).length === 0)
  assert.match(await readFile(recorder.journal.path, "utf8"), /browser\.close_forced/, "forced-close evidence must exist before fallback fixture/world cleanup")
  chromium = undefined
  await fixture.close(); fixture = undefined
  await world.teardown({remove: true}); world = undefined
  await assert.rejects(stat(root), error => error.code === "ENOENT")
  assert.deepEqual(await browserProcesses(profile), [])
  const artifact = await recorder.finalize({status: "passed", cleanup: {forced_browser_close: "verified", leaked_processes: 0, leaked_profiles: 0}}); finalized = true
  assert.ok(artifact.attestation.files.length > 0)
})
