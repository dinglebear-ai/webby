import assert from "node:assert/strict"
import {mkdtemp, readFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {runStress, stressScenarios, summarizeAttempts} from "../../support/stress-runner.js"

const clean = {processes: [], listeners: [], handles: [], workspaces: [], profiles: [], databases: [], pending_calls: [], stale_sessions: []}

test("randomized existing scenario orchestration isolates workers and records ceilings", async () => {
  const root = await mkdtemp(join(tmpdir(), "webby-stress-orchestrate-")); const seen = []
  const {report, attempts} = await runStress({seed: "qualify-1", repetitions: 6, concurrency: 3, scenarios: stressScenarios, artifactRoot: root,
    execute: async input => { seen.push(input); assert.equal(new Set(input.scenarioIds).size, stressScenarios.length) }, leakProbe: async () => clean})
  assert.equal(report.runs, 6); assert.equal(report.initial_failures, 0); assert.equal(report.retry_passes, 0)
  assert.equal(report.ceilings.pending_calls, 100); assert.deepEqual(report.ceilings.scan_tabs, [10, 100, 1000]); assert.equal(report.promotion, "blocking-candidate")
  assert.equal(new Set(seen.map(value => value.root)).size, 6); assert.equal(attempts.length, 6)
  assert.equal(JSON.parse(await readFile(attempts[0].replay_manifest, "utf8")).seed, "qualify-1:1")
})

test("first failure is preserved and a retry-pass is never clean", async () => {
  const root = await mkdtemp(join(tmpdir(), "webby-stress-flake-")); let calls = 0
  const {report, attempts} = await runStress({seed: "injected-9", repetitions: 1, concurrency: 1, retries: 1, scenarios: ["e2e-lifecycle-removal"], artifactRoot: root,
    execute: async () => { if (++calls === 1) throw new Error("injected SIGTERM/controller-death failure") }, leakProbe: async () => clean})
  assert.equal(report.initial_failures, 1); assert.equal(report.retry_passes, 1); assert.equal(report.first_failing_seed, "injected-9:1"); assert.equal(report.promotion, "nonblocking-investigation")
  assert.deepEqual(attempts.map(value => value.status), ["failed", "passed"])
  assert.match(await readFile(attempts[0].replay_manifest, "utf8"), /injected SIGTERM\/controller-death failure/)
})

test("qualification summary publishes p50/p95, flake rate, ceilings and tier", () => {
  const report = summarizeAttempts([{run: 1, attempt: 1, seed: "a", status: "passed", duration_ms: 10}, {run: 2, attempt: 1, seed: "b", status: "passed", duration_ms: 30}], {queries: 500, concurrency: 8})
  assert.deepEqual(report.duration_ms, {p50: 10, p95: 30, max: 30}); assert.equal(report.flake_rate, 0); assert.deepEqual(report.ceilings, {queries: 500, concurrency: 8})
})

test("cancellation is bounded before the next randomized run", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"))
  await assert.rejects(runStress({seed: "cancel", repetitions: 2, concurrency: 1, artifactRoot: await mkdtemp(join(tmpdir(), "webby-stress-cancel-")), signal: controller.signal, execute: async () => {}, leakProbe: async () => clean}), /cancelled/)
})

test("qualification report is written when cleanup integrity fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "webby-stress-cleanup-failure-"))
  await assert.rejects(runStress({seed: "cleanup-failure", repetitions: 1, scenarios: ["e2e-shared-vertical-slice"], artifactRoot: root, execute: async () => {}, leakProbe: async () => ({...clean, pending_calls: ["call-leak"]})}), /stress infrastructure failed/)
  const manifest = JSON.parse(await readFile(join(root, "qualification-report.json"), "utf8"))
  assert.equal(manifest.status, "failed"); assert.equal(manifest.report.promotion, "nonblocking-investigation"); assert.match(manifest.report.infrastructure_failures[0], /pending_calls=1/)
})
