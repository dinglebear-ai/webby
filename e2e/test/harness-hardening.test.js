import assert from "node:assert/strict"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {runHarnessSelfTests} from "../support/harness-self-test.js"
import {buildSuiteTelemetry, parseScenarioTelemetry, writeSuiteTelemetry} from "../support/suite-telemetry.js"
import {loadSurfaceInventory, validateObservedSurfaces, writeSurfaceEvidence} from "../support/surface-evidence.js"
import {readScenarioContract} from "../support/runtime-contracts.js"
import {createBoundaryObservation, surfaceProof, validateBoundaryDenominator} from "../support/boundary-surfaces.js"

const proofFor = (surfaceId, sequence) => {
  const category = surfaceId.split(":", 1)[0]
  if (category === "http" || category === "behavior") return surfaceProof.http({status: 200, ok: true}, {path: "/health"})
  if (category === "artifact") return {kind: "artifact_attestation", attestation_sha256: "a".repeat(64), file: {path: `${surfaceId}.json`, sha256: "b".repeat(64)}}
  if (category === "world-field" || category === "capability") return {kind: "manifest_field", manifest_path: "world-manifest.json", field: "field", value: true}
  if (category === "dashboard") return surfaceProof.dashboard("test", "entity-1")
  if (category === "chrome-event") return surfaceProof.chrome({sequence}, {eventName: "chrome.test", identity: "tab-1"})
  if (category === "version" || category === "mcp" || category === "action") return surfaceProof.mcp({status: 200}, {method: "tools/call", version: "2025-06-18", action: "status"})
  return surfaceProof.journal({sequence, type: "boundary.test", producer: "test"})
}
const proofMap = surfaceIds => Object.fromEntries(surfaceIds.map((surfaceId, index) => [surfaceId, proofFor(surfaceId, index + 1)]))

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
  const evidence = await writeSurfaceEvidence(path, {scenario, driver: "protocol", observed: scenario.surface_ids, proofs: proofMap(scenario.surface_ids), inventory})
  assert.equal(evidence.coverage_percent, 100); assert.equal(evidence.observed_surface_ids.length, scenario.surface_ids.length)
  assert.throws(() => validateObservedSurfaces({scenario, driver: "protocol", observed: scenario.surface_ids, proofs: Object.fromEntries(scenario.surface_ids.map(id => [id, {source: `forged ${id}`, verified: true}])), inventory}), /invalid proof/)
  assert.throws(() => validateObservedSurfaces({scenario, driver: "protocol", observed: scenario.surface_ids.slice(1), proofs: proofMap(scenario.surface_ids.slice(1)), inventory}), /missing=/)
  assert.throws(() => validateObservedSurfaces({scenario, driver: "protocol", observed: scenario.surface_ids.filter(id => id !== "artifact:manifest"), proofs: proofMap(scenario.surface_ids.filter(id => id !== "artifact:manifest")), inventory}), /missing=artifact:manifest/)
  assert.throws(() => validateObservedSurfaces({scenario, driver: "protocol", observed: scenario.surface_ids.filter(id => id !== "version:2025-03"), proofs: proofMap(scenario.surface_ids.filter(id => id !== "version:2025-03")), inventory}), /missing=version:2025-03/)
  assert.throws(() => validateObservedSurfaces({scenario, driver: "protocol", observed: [...scenario.surface_ids, "surface:invented"], proofs: proofMap([...scenario.surface_ids, "surface:invented"]), inventory}), /undeclared=.*surface:invented/)
  const unmapped = structuredClone(inventory); unmapped.surfaces.find(row => row.id === scenario.surface_ids[0]).scenarios = []
  assert.throws(() => validateObservedSurfaces({scenario, driver: "protocol", observed: scenario.surface_ids, proofs: proofMap(scenario.surface_ids), inventory: unmapped}), /inventory does not map/)
})

test("runtime boundary completion seals only individually proven surfaces", () => {
  const boundary = createBoundaryObservation("e2e-shared-vertical-slice", "health.request")
  assert.throws(() => boundary.consume(), /completion evidence is missing/)
  boundary.observe("http:get-health", surfaceProof.http({status: 200, ok: true}, {path: "/health"}))
  assert.throws(() => boundary.observe("http:get-root", {source: "forged prose", verified: true}), /discriminated producer proof is required/)
  assert.throws(() => boundary.observe("surface:invented", {kind: "journal_event", sequence: 1, type: "invented"}), /undeclared boundary surface/)
  const evidence = boundary.complete()
  assert.equal(boundary.consume(), evidence)
  assert.equal(evidence.state, "verified")
  assert.deepEqual(evidence.surface_ids, ["http:get-health"])
  assert.deepEqual(evidence.proofs["http:get-health"], {kind: "http_response", method: "GET", path: "/health", status: 200, ok: true})
  assert.equal(evidence.surface_ids.includes("http:get-root"), false)
  assert.throws(() => boundary.complete(), /more than once/)
  assert.throws(() => boundary.observe("http:get-root", surfaceProof.http({status: 200, ok: true}, {path: "/"})), /already sealed/)
})

test("scheduled self-test executes deliberate fail-closed seams", async () => {
  const report = await runHarnessSelfTests()
  assert.equal(report.status, "passed")
  assert.deepEqual(report.probes.map(probe => probe.name), ["missing-observed-surface", "invented-observed-surface", "invalid-telemetry-attempts", "malformed-scenario-contract"])
  assert.ok(report.probes.every(probe => probe.outcome === "rejected-as-required"))
})
