import {performance} from "node:perf_hooks"
import {mkdir} from "node:fs/promises"
import {join, resolve} from "node:path"
import {assertNoLeaks} from "./leak-detector.js"
import {shuffled, writeReplayManifest} from "./seed-replay.js"
import {measuredCeilings, requiredStressMeasurements, stressScenarios, validateRequiredMeasurements, validateStressScenarios} from "./stress-scenarios.js"
export {stressScenarios} from "./stress-scenarios.js"

const percentile = (values, fraction) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] : 0

export function summarizeAttempts(attempts, ceilings = {}) {
  const durations = attempts.map(value => value.duration_ms).sort((a, b) => a - b)
  const initialFailures = attempts.filter(value => value.attempt === 1 && value.status === "failed")
  const retryPasses = attempts.filter(value => value.attempt > 1 && value.status === "passed" && attempts.some(first => first.run === value.run && first.attempt === 1 && first.status === "failed"))
  return {
    schema_version: 1, runs: new Set(attempts.map(value => value.run)).size, attempts: attempts.length,
    initial_failures: initialFailures.length, retry_passes: retryPasses.length,
    flake_rate: attempts.length ? initialFailures.length / new Set(attempts.map(value => value.run)).size : 0,
    duration_ms: {p50: percentile(durations, 0.50), p95: percentile(durations, 0.95), max: durations.at(-1) ?? 0},
    ceilings, promotion: initialFailures.length === 0 && retryPasses.length === 0 ? "blocking-candidate" : "nonblocking-investigation",
    first_failing_seed: initialFailures[0]?.seed ?? null,
  }
}

export async function runStress({seed, repetitions = 1, concurrency = 1, scenarios = stressScenarios, artifactRoot, execute, leakProbe, retries = 0, signal, exactReplay = false} = {}) {
  if (!seed || !Number.isInteger(repetitions) || repetitions < 1 || !Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(retries) || retries < 0) throw new Error("seed, repetitions, concurrency, and retries must be non-negative integers with positive work counts")
  if (typeof execute !== "function" || typeof leakProbe !== "function") throw new Error("execute and leakProbe are required")
  scenarios = validateStressScenarios(scenarios)
  const root = resolve(artifactRoot); await mkdir(root, {recursive: true, mode: 0o700})
  const jobs = Array.from({length: repetitions}, (_, index) => ({run: index + 1, seed: exactReplay ? String(seed) : `${seed}:${index + 1}`}))
  const attempts = []; let cursor = 0
  async function worker(workerIndex) {
    while (cursor < jobs.length) {
      if (signal?.aborted) throw signal.reason ?? new Error("stress run cancelled")
      const job = jobs[cursor++]; const workerRoot = join(root, `webby-stress-worker-${workerIndex}-run-${job.run}`)
      await mkdir(workerRoot, {recursive: true, mode: 0o700})
      const order = exactReplay ? [...scenarios] : shuffled(scenarios, job.seed); let passed = false
      for (let attempt = 1; attempt <= retries + 1 && !passed; attempt++) {
        const attemptRoot = join(workerRoot, `attempt-${attempt}`); await mkdir(attemptRoot, {recursive: true, mode: 0o700})
        const replayPath = join(attemptRoot, "replay-manifest.json")
        const started = performance.now(); let error
        let evidence = []
        try {
          evidence = await execute({run: job.run, attempt, seed: job.seed, scenarioIds: order, root: attemptRoot, signal}) ?? []
          if (!Array.isArray(evidence) || evidence.length !== order.length || evidence.some((value, index) => value?.scenario_id !== order[index] || value.status !== "passed")) throw new Error("selected scenario IDs did not bind one-to-one to passed execution evidence")
          passed = true
        }
        catch (caught) { error = caught }
        const duration_ms = Math.round(performance.now() - started)
        const status = error ? "failed" : "passed"
        await writeReplayManifest(replayPath, {seed: job.seed, scenario_ids: order, run: job.run, attempt, status, failure: error?.message ?? null})
        attempts.push({run: job.run, attempt, seed: job.seed, status, duration_ms, replay_manifest: replayPath, failure: error?.message ?? null, scenario_evidence: evidence})
        if (error?.message.includes("one-to-one to passed execution evidence")) throw error
      }
      assertNoLeaks(await leakProbe({run: job.run, root: workerRoot}))
      // Every attempt manifest is immutable evidence, including successful runs.
    }
  }
  const workerOutcomes = await Promise.allSettled(Array.from({length: Math.min(concurrency, repetitions)}, (_, index) => worker(index + 1)))
  attempts.sort((left, right) => left.run - right.run || left.attempt - right.attempt)
  const executedEvidence = attempts.flatMap(value => value.scenario_evidence ?? [])
  const report = summarizeAttempts(attempts, {workers: Math.min(concurrency, repetitions), ...measuredCeilings(executedEvidence)})
  report.executed_scenarios = [...new Set(executedEvidence.filter(value => value.status === "passed").map(value => value.scenario_id))].sort()
  const infrastructureFailures = workerOutcomes.filter(value => value.status === "rejected").map(value => value.reason?.message ?? String(value.reason))
  for (const attempt of attempts.filter(value => value.status === "passed")) for (const scenarioId of scenarios.filter(id => requiredStressMeasurements[id])) {
    const evidence = attempt.scenario_evidence?.find(value => value.scenario_id === scenarioId)
    try { validateRequiredMeasurements(scenarioId, evidence?.measurements) }
    catch (error) { infrastructureFailures.push(`run ${attempt.run} attempt ${attempt.attempt}: ${error.message}`) }
  }
  report.infrastructure_failures = infrastructureFailures
  if (infrastructureFailures.length) report.promotion = "nonblocking-investigation"
  await writeReplayManifest(join(root, "qualification-report.json"), {seed: String(seed), scenario_ids: scenarios, status: report.initial_failures || infrastructureFailures.length ? "failed" : "passed", report, attempts})
  if (infrastructureFailures.length) throw Object.assign(new Error(`stress infrastructure failed: ${infrastructureFailures.join("; ")}`), {report, attempts})
  return {report, attempts}
}
