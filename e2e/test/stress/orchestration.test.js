import assert from "node:assert/strict"
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {runStress, stressScenarios, summarizeAttempts} from "../../support/stress-runner.js"
import {scenarioTimeoutMs, throwStressFailures, validateScenarioEvidence} from "../../support/stress-cli.js"
import {stressScenarioFiles, validateRequiredMeasurements} from "../../support/stress-scenarios.js"

const clean = {processes: [], listeners: [], handles: [], workspaces: [], profiles: [], databases: [], pending_calls: [], stale_sessions: []}

test("randomized existing scenario orchestration isolates workers and records ceilings", async () => {
  const root = await mkdtemp(join(tmpdir(), "webby-stress-orchestrate-")); const seen = []
  const {report, attempts} = await runStress({seed: "qualify-1", repetitions: 6, concurrency: 3, scenarios: stressScenarios, artifactRoot: root,
    execute: async input => { seen.push(input); assert.equal(new Set(input.scenarioIds).size, stressScenarios.length); return input.scenarioIds.map(scenario_id => ({scenario_id, status: "passed", measurements: scenario_id === "e2e-capacity-concurrency" ? [{pending_calls: 100}, {scan_tabs: [10, 100, 1000]}] : []})) }, leakProbe: async () => clean})
  assert.equal(report.runs, 6); assert.equal(report.initial_failures, 0); assert.equal(report.retry_passes, 0)
  assert.equal(report.ceilings.pending_calls, 100); assert.deepEqual(report.ceilings.scan_tabs, [10, 100, 1000]); assert.equal(report.promotion, "blocking-candidate")
  assert.equal(new Set(seen.map(value => value.root)).size, 6); assert.equal(attempts.length, 6)
  assert.equal(JSON.parse(await readFile(attempts[0].replay_manifest, "utf8")).seed, "qualify-1:1")
})

test("first failure is preserved and a retry-pass is never clean", async () => {
  const root = await mkdtemp(join(tmpdir(), "webby-stress-flake-")); let calls = 0
  const {report, attempts} = await runStress({seed: "injected-9", repetitions: 1, concurrency: 1, retries: 1, scenarios: ["e2e-lifecycle-removal"], artifactRoot: root,
    execute: async ({scenarioIds}) => { if (++calls === 1) throw new Error("injected SIGTERM/controller-death failure"); return scenarioIds.map(scenario_id => ({scenario_id, status: "passed"})) }, leakProbe: async () => clean})
  assert.equal(report.initial_failures, 1); assert.equal(report.retry_passes, 1); assert.equal(report.first_failing_seed, "injected-9:1"); assert.equal(report.promotion, "nonblocking-investigation")
  assert.deepEqual(attempts.map(value => value.status), ["failed", "passed"])
  assert.match(await readFile(attempts[0].replay_manifest, "utf8"), /injected SIGTERM\/controller-death failure/)
})

test("qualification summary publishes p50/p95, flake rate, ceilings and tier", () => {
  const report = summarizeAttempts([{run: 1, attempt: 1, seed: "a", status: "passed", duration_ms: 10}, {run: 2, attempt: 1, seed: "b", status: "passed", duration_ms: 30}], {queries: 500, concurrency: 8})
  assert.deepEqual(report.duration_ms, {p50: 10, p95: 30, max: 30}); assert.equal(report.flake_rate, 0); assert.deepEqual(report.ceilings, {queries: 500, concurrency: 8})
})

test("ceilings and executed scenario ledger derive only from attested executions", async () => {
  const root = await mkdtemp(join(tmpdir(), "webby-stress-measured-"))
  const {report, attempts} = await runStress({seed: "measured", scenarios: ["e2e-capacity-concurrency"], artifactRoot: root,
    execute: async ({scenarioIds}) => scenarioIds.map(scenario_id => ({scenario_id, status: "passed", executed_files: ["capacity.js"], measurements: [{pending_calls: 100, scan_tabs: [10, 100, 1000]}], attested_log: `${scenario_id}.log`})), leakProbe: async () => clean})
  assert.deepEqual(report.executed_scenarios, ["e2e-capacity-concurrency"])
  assert.equal(report.ceilings.pending_calls, 100); assert.deepEqual(report.ceilings.scan_tabs, [10, 100, 1000])
  assert.deepEqual(attempts[0].scenario_evidence[0].executed_files, ["capacity.js"])
})

test("execution evidence rejects forged files, order, measurements, and unattested logs", async t => {
  const root = await mkdtemp(join(tmpdir(), "webby-stress-attested-evidence-")); const log = join(root, "e2e-capacity-concurrency.log")
  t.after(() => rm(root, {recursive: true, force: true})); await writeFile(log, '# WEBBY_STRESS_MEASUREMENT={"pending_calls":100}\n# WEBBY_STRESS_MEASUREMENT={"scan_tabs":[10,100,1000]}\n')
  const ids = ["e2e-capacity-concurrency"]
  const evidence = [{scenario_id: ids[0], status: "passed", executed_files: [...stressScenarioFiles[ids[0]]], duration_ms: 12, measurements: [{pending_calls: 100}, {scan_tabs: [10, 100, 1000]}], attested_log: `${ids[0]}.log`}]
  const artifact = {attestation: {files: [{path: `${ids[0]}.log`}]}, uploadCandidates: [log]}
  assert.equal(await validateScenarioEvidence(evidence, ids, artifact), evidence)
  for (const forged of [
    [{...evidence[0], executed_files: ["forged.test.js"]}],
    [{...evidence[0], scenario_id: "e2e-shared-vertical-slice"}],
    [{...evidence[0], duration_ms: 0}],
    [{...evidence[0], measurements: "100"}],
    [{...evidence[0], measurements: [{pending_calls: 99}]}],
    [{...evidence[0], attested_log: "missing.log"}],
  ]) await assert.rejects(validateScenarioEvidence(forged, ids, artifact))
})

test("primary execution and finalization failures remain ordered in one aggregate", () => {
  const primary = new Error("scenario failed"); const finalize = new Error("finalize failed"); const stage = new Error("stage failed")
  assert.throws(() => throwStressFailures(primary, [finalize, stage]), error => error instanceof AggregateError && error.cause === primary && error.errors[0] === primary && error.errors[1] === finalize && error.errors[2] === stage)
})

test("scenario child timeout contains every registered file ceiling within the nightly job bound", async () => {
  for (const files of Object.values(stressScenarioFiles)) {
    const timeout = await scenarioTimeoutMs(files)
    assert.ok(timeout >= 180_000); assert.ok(timeout <= 30 * 60_000)
  }
  assert.ok(await scenarioTimeoutMs(stressScenarioFiles["e2e-extension-controls"]) > 300_000)
})

test("mandatory capacity measurements reject missing partial below-boundary and malformed observations", () => {
  const id = "e2e-capacity-concurrency"
  assert.equal(validateRequiredMeasurements(id, [{pending_calls: 100}, {scan_tabs: [10, 100, 1000]}]), true)
  for (const invalid of [
    [], [{pending_calls: 100}], [{scan_tabs: [10, 100, 1000]}],
    [{pending_calls: 99}, {scan_tabs: [10, 100, 1000]}],
    [{pending_calls: 100}, {scan_tabs: [10, 100]}],
    [{pending_calls: 100}, {scan_tabs: [10, 100, "1000"]}],
    [{pending_calls: 100}, {scan_tabs: [10, 100, 1000, 1001]}],
    [{pending_calls: 100}, {pending_calls: 100}, {scan_tabs: [10, 100, 1000]}],
  ]) assert.throws(() => validateRequiredMeasurements(id, invalid))
})

test("a clean capacity execution cannot promote when mandatory measurements are absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "webby-stress-required-measurement-"))
  await assert.rejects(runStress({seed: "missing-capacity", scenarios: ["e2e-capacity-concurrency"], artifactRoot: root,
    execute: async ({scenarioIds}) => scenarioIds.map(scenario_id => ({scenario_id, status: "passed", measurements: []})), leakProbe: async () => clean}),
  error => error.report?.promotion === "nonblocking-investigation" && error.report.infrastructure_failures.some(value => value.includes("pending_calls=100")))
})

test("cancellation is bounded before the next randomized run", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"))
  await assert.rejects(runStress({seed: "cancel", repetitions: 2, concurrency: 1, artifactRoot: await mkdtemp(join(tmpdir(), "webby-stress-cancel-")), signal: controller.signal, execute: async () => {}, leakProbe: async () => clean}), /cancelled/)
})

test("a passing executor without one-to-one evidence fails closed", async () => {
  await assert.rejects(runStress({seed: "missing-evidence", scenarios: ["e2e-shared-vertical-slice"], artifactRoot: await mkdtemp(join(tmpdir(), "webby-stress-no-evidence-")), execute: async () => [], leakProbe: async () => clean}), /one-to-one/)
})

test("qualification report is written when cleanup integrity fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "webby-stress-cleanup-failure-"))
  await assert.rejects(runStress({seed: "cleanup-failure", repetitions: 1, scenarios: ["e2e-shared-vertical-slice"], artifactRoot: root, execute: async ({scenarioIds}) => scenarioIds.map(scenario_id => ({scenario_id, status: "passed"})), leakProbe: async () => ({...clean, pending_calls: ["call-leak"]})}), /stress infrastructure failed/)
  const manifest = JSON.parse(await readFile(join(root, "qualification-report.json"), "utf8"))
  assert.equal(manifest.status, "failed"); assert.equal(manifest.report.promotion, "nonblocking-investigation"); assert.match(manifest.report.infrastructure_failures[0], /pending_calls=1/)
})
