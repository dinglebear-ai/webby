import assert from "node:assert/strict"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {emitFixtureOutcomeParityReport, runSharedFixtureOutcome} from "../../support/fixture-outcome-parity.js"
import {compareParity} from "../../support/parity-report.js"

const scenarioPath = new URL("../../contracts/scenarios/fixture-outcomes.json", import.meta.url)

async function runAdapter(t, scenario, driver) {
  const root = await mkdtemp(join(tmpdir(), `webby-fixture-parity-${driver}-`))
  t.after(() => rm(root, {recursive: true, force: true}))
  const recorder = await new ArtifactRecorder({root, scenarioId: scenario.id, worldId: `${driver}-world`, seed: 731}).open()
  const cleanup = async () => ({
    "cleanup.fixture.has.no.pending.tool.promises": {state: "absent"},
    "cleanup.fixture.listener.closes": {state: "closed"},
    "cleanup.browser.resources.close": {state: "closed"},
    "cleanup.temporary.world.is.removable": {state: "removable"},
  })
  const result = await runSharedFixtureOutcome({scenario, driver, world: {worldId: `${driver}-world`, instanceNonce: `${driver}-` + "n".repeat(32), seed: 731}, recorder, cleanup})
  await recorder.finalize({cleanup: {shared_fixture_model: "closed"}})
  return result
}

test("shared semantics execute through ScenarioRunner and emitted adapter reports fail closed on drift", async t => {
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8"))
  const protocol = await runAdapter(t, scenario, "protocol")
  const chromium = await runAdapter(t, scenario, "chromium")
  // This is an adapter-contract test, not a claim that Chromium launched. The
  // live Chromium suite supplies its own observed outcomes to the same emitter.
  assert.deepEqual(protocol.normalized, chromium.normalized)
  assert.equal(protocol.normalized["results.normalized"].value.success.state, "succeeded")
  assert.equal(protocol.normalized["results.normalized"].value.tool_error.value.error_kind, "tool_error")
  assert.equal(protocol.normalized["results.normalized"].value.delayed.value.released, true)
  assert.equal(protocol.normalized["results.normalized"].value.timed_out.state, "timed_out")
  assert.equal(protocol.normalized["results.normalized"].value.result_too_large.value.error_kind, "result_too_large")
  assert.equal(protocol.normalized["results.normalized"].value.result_too_deep.value.error_kind, "result_too_large")
  assert.equal(protocol.normalized["abort.observed"].value.caller, "cancelled")
  assert.equal(protocol.normalized["abort.observed"].value.browser_work, "aborted")
  assert.equal(protocol.normalized["abort.observed"].value.late_result, "rejected")
  assert.equal(protocol.normalized["abort.observed"].value.lifecycle.capacity.state, "released")
  assert.equal(protocol.normalized["abort.observed"].value.lifecycle.audit.terminal, true)
  assert.deepEqual(protocol.normalized["stale.rejected"].value, {error_kind: "stale_document", late_result: "rejected", side_effects: 0})

  const reportRoot = await mkdtemp(join(tmpdir(), "webby-fixture-parity-reports-"))
  t.after(() => rm(reportRoot, {recursive: true, force: true}))
  const common = {scenario, sourceRevision: "a".repeat(40), seed: "fixture-parity-seed", worldNonce: "w".repeat(32)}
  const protocolPath = join(reportRoot, "protocol.json")
  const chromiumPath = join(reportRoot, "chromium.json")
  const protocolReport = await emitFixtureOutcomeParityReport(protocolPath, {...common, driver: "protocol", normalized: protocol.normalized})
  const chromiumReport = await emitFixtureOutcomeParityReport(chromiumPath, {...common, driver: "chromium", normalized: chromium.normalized})
  assert.deepEqual(JSON.parse(await readFile(protocolPath, "utf8")), protocolReport)
  assert.deepEqual(JSON.parse(await readFile(chromiumPath, "utf8")), chromiumReport)
  const parity = compareParity(protocolReport, chromiumReport, [scenario])
  assert.deepEqual(parity, {ok: true, errors: [], compared: [scenario.id]})

  const missing = structuredClone(chromiumReport)
  missing.results[0].raw_observables.pop()
  assert.ok(compareParity(protocolReport, missing, [scenario]).errors.some(error => error.includes("no raw observable provenance") || error.includes("required raw observable")))
  const drift = structuredClone(chromiumReport)
  drift.results[0].outcomes["results.normalized"].value.success = "failed"
  assert.ok(compareParity(protocolReport, drift, [scenario]).errors.some(error => error.includes("normalized outcomes differ")))
})
