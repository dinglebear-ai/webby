import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import {join} from "node:path"
import test from "node:test"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {ChromiumScenarioAdapter, chromiumDeferredInventory, chromiumEvidence, percentile} from "../../support/chromium-scenario-adapter.js"
import {ChromiumWorld} from "../../support/chromium-world.js"
import {runCleanupPlan} from "../../support/cleanup-plan.js"
import {DashboardDriver} from "../../support/dashboard-driver.js"
import {startFixtureServer} from "../../fixture/server.js"
import {ScenarioRunner} from "../../support/scenario-runner.js"
import {diskBytes} from "../../support/temp-workspace.js"
import {WebbyWorld} from "../../support/world.js"

const contractPath = new URL("../../contracts/scenarios/shared-vertical-slice.json", import.meta.url)

test("Chromium inventory rows are delegated without an adapter-specific matrix", () => {
  assert.deepEqual(Object.keys(chromiumDeferredInventory), ["webby-ihb.17", "webby-ihb.18", "webby-ihb.19", "webby-ihb.20"])
  assert.equal(percentile([30, 10, 20], 0.5), 20)
  assert.equal(percentile([30, 10, 20], 0.95), 30)
  assert.throws(() => chromiumEvidence({startupSamples: [1], world: {metrics: {}}, durationMs: 1, artifactBytes: 1}), /overflow evidence/)
})

test("complete shared pair-to-audit slice through Chromium", {timeout: 180_000}, async t => {
  const scenario = JSON.parse(await readFile(contractPath, "utf8"))
  const started = performance.now()
  let world = await WebbyWorld.start({scenarioId: scenario.id, seed: 424242, preserveArtifacts: true})
  await world.releaseFixturePort()
  let fixture = await startFixtureServer({worldId: world.worldId, port: world.fixturePort})
  const recorder = await new ArtifactRecorder({root: join(world.workspace.artifacts, "chromium-slice"), scenarioId: scenario.id, worldId: world.worldId, seed: world.seed, secrets: [world.secret, world.telemetryCapability, fixture.capability]}).open()
  let chromium
  let adapter
  let finalized = false
  t.after(async () => {
    await runCleanupPlan([
      ["mcp", () => adapter?.mcp?.close()],
      ["chromium", () => chromium?.close()],
      ["fixture", () => fixture?.close()],
      ["recorder", () => finalized ? undefined : recorder.finalize({status: "failed"})],
      ["world", () => world?.teardown({remove: true})],
    ], {message: "Chromium vertical-slice fallback cleanup failed"})
  })

  chromium = await ChromiumWorld.launch({world, recorder, broadHostPermissions: true})
  const dashboardPage = await chromium.context.newPage()
  const dashboard = await new DashboardDriver({page: dashboardPage, recorder}).open(world.baseUrl)
  adapter = new ChromiumScenarioAdapter({scenario, world, chromium, dashboard, fixture, recorder})
  await adapter.prepare()
  const runner = new ScenarioRunner({scenario, driver: "chromium", world, recorder, actions: adapter.actions(), observe: async () => ({}), cleanup: () => adapter.cleanup(), defaultTimeoutMs: 45_000})
  const result = await runner.run()
  chromium = undefined; fixture = undefined
  assert.deepEqual(result.normalized["call.succeeded"], {state: "succeeded", terminal: true, value: {probe: "chromium-scenario-effect"}})
  assert.equal(result.handles.get("audit", "audit"), adapter.auditId)

  world.metrics.disk_bytes = await diskBytes(world.root, {symlinkRoots: [world.workspace.profile]})
  const evidence = chromiumEvidence({startupSamples: [world.metrics.startup_ms], world, durationMs: performance.now() - started, artifactBytes: recorder.accountedBytes, overflow: {occurred: Boolean(recorder.journal.truncated), policy: "fail_closed_truncation_latch"}})
  await recorder.producers.world.diagnostic("chromium-evidence.json", evidence, ["workers", "retries", "startup_ms", "peak_rss_kb", "disk_bytes", "artifact_bytes", "duration_ms", "recorder_overflow"])
  const artifact = await recorder.finalize({cleanup: {chromium: "closed", fixture: "closed", mcp: "closed", world: "closed", leaked_ports: 0, leaked_processes: 0, leaked_profiles: 0}})
  finalized = true
  assert.equal(evidence.workers, 1); assert.equal(evidence.retries, 0); assert.ok(evidence.duration_ms > 0)
  assert.equal(evidence.startup_ms.sample_count, 1)
  assert.equal(evidence.startup_ms.p50, world.metrics.startup_ms); assert.equal(evidence.startup_ms.p95, world.metrics.startup_ms)
  assert.ok(artifact.attestation.files.some(file => file.path.endsWith("chromium-evidence.json")))
  assert.ok(artifact.attestation.files.some(file => file.path.endsWith("dashboard-snapshot.png")))
  assert.equal(artifact.replay.omissions.length, 0)
  await world.teardown({remove: true}); world = undefined
})
