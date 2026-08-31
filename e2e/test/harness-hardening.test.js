import assert from "node:assert/strict"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {runHarnessSelfTests} from "../support/harness-self-test.js"
import {buildSuiteTelemetry, parseScenarioTelemetry, writeSuiteTelemetry} from "../support/suite-telemetry.js"
import {loadSurfaceInventory, validateObservedSurfaces, writeSurfaceEvidence} from "../support/surface-evidence.js"
import {readScenarioContract} from "../support/runtime-contracts.js"
import {createBoundaryObservation, validateBoundaryDenominator} from "../support/boundary-surfaces.js"

test("suite telemetry reports non-secret cost and stability measurements", async t => {
  const root = await mkdtemp(join(tmpdir(), "webby-telemetry-")); t.after(() => rm(root, {recursive: true, force: true}))
  const startedAt = new Date("2026-08-31T10:00:00Z"), finishedAt = new Date("2026-08-31T10:00:03Z")
  const path = join(root, "telemetry.json")
  const scenarioRuns = [{scenario_id: "e2e-a", adapter: "protocol", duration_ms: 100, status: "passed"}, {scenario_id: "e2e-b", adapter: "protocol", duration_ms: 20, status: "passed"}]
  const value = await writeSuiteTelemetry(path, {suite: "protocol-full", status: "passed", startedAt, finishedAt, attempts: 1, retries: 0, plannedScenarioIds: ["e2e-b", "e2e-a"], scenarioRuns})
  assert.deepEqual(value.observed_scenario_ids, ["e2e-a", "e2e-b"]); assert.equal(value.elapsed_ms, 3000); assert.equal(value.evidence_complete, true); assert.equal(value.flake, false); assert.equal(value.rerun_rate, 0)
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), value)
  assert.deepEqual(parseScenarioTelemetry(scenarioRuns.map(row => JSON.stringify(row)).join("\n")), scenarioRuns)
  assert.throws(() => buildSuiteTelemetry({suite: "bad suite", status: "passed", startedAt, finishedAt}), /identity/)
  assert.throws(() => buildSuiteTelemetry({suite: "ok", status: "passed", startedAt, finishedAt, plannedScenarioIds: ["missing"]}), /denominator drifted/)
  assert.throws(() => buildSuiteTelemetry({suite: "ok", status: "passed", startedAt, finishedAt, plannedScenarioIds: ["e2e-a"], scenarioRuns: [{scenario_id: "e2e-a", adapter: "protocol", duration_ms: 1, status: "failed"}]}), /contains failed scenario runs/)
  assert.throws(() => buildSuiteTelemetry({suite: "ok", status: "passed", startedAt, finishedAt, infrastructureError: "spawn failed"}), /contains an infrastructure error/)
  const failed = buildSuiteTelemetry({suite: "protocol-full", status: "failed", startedAt, finishedAt, plannedScenarioIds: ["e2e-a"], scenarioRuns: [], infrastructureError: "spawn failed"})
  assert.equal(failed.evidence_complete, false); assert.equal(failed.infrastructure_error, "spawn failed")
  assert.throws(() => parseScenarioTelemetry("{bad"), /malformed/)
})

test("adapter surface evidence must exactly equal declarations and inventory mappings", async t => {
  const inventory = await loadSurfaceInventory()
  const scenario = await readScenarioContract(new URL("../contracts/scenarios/shared-vertical-slice.json", import.meta.url))
  assert.equal(validateBoundaryDenominator(scenario), true)
  assert.throws(() => validateBoundaryDenominator({...scenario, surface_ids: scenario.surface_ids.slice(1)}), /surface denominator drifted/)
  const root = await mkdtemp(join(tmpdir(), "webby-surface-runtime-")); t.after(() => rm(root, {recursive: true, force: true}))
  const path = join(root, "surface-evidence.json")
  const evidence = await writeSurfaceEvidence(path, {scenario, driver: "protocol", observed: scenario.surface_ids, inventory})
  assert.equal(evidence.coverage_percent, 100); assert.equal(evidence.observed_surface_ids.length, scenario.surface_ids.length)
  assert.throws(() => validateObservedSurfaces({scenario, driver: "protocol", observed: scenario.surface_ids.slice(1), inventory}), /missing=/)
  assert.throws(() => validateObservedSurfaces({scenario, driver: "protocol", observed: [...scenario.surface_ids, "surface:invented"], inventory}), /undeclared=.*surface:invented/)
  const unmapped = structuredClone(inventory); unmapped.surfaces.find(row => row.id === scenario.surface_ids[0]).scenarios = []
  assert.throws(() => validateObservedSurfaces({scenario, driver: "protocol", observed: scenario.surface_ids, inventory: unmapped}), /inventory does not map/)
})

test("runtime boundary evidence exists only after the adapter emits verified completion", () => {
  const boundary = createBoundaryObservation("e2e-shared-vertical-slice", "health.request")
  assert.throws(() => boundary.consume(), /completion evidence is missing/)
  const evidence = boundary.complete()
  assert.equal(boundary.consume(), evidence)
  assert.equal(evidence.state, "verified")
  assert.ok(evidence.surface_ids.includes("http:get-health"))
  assert.throws(() => boundary.complete(), /more than once/)
})

test("scheduled self-test executes deliberate fail-closed seams", async () => {
  const report = await runHarnessSelfTests()
  assert.equal(report.status, "passed")
  assert.deepEqual(report.probes.map(probe => probe.name), ["missing-observed-surface", "invented-observed-surface", "invalid-telemetry-attempts", "malformed-scenario-contract"])
  assert.ok(report.probes.every(probe => probe.outcome === "rejected-as-required"))
})
