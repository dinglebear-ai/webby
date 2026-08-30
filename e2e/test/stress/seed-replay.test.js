import assert from "node:assert/strict"
import {mkdtemp, readFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {readReplayManifest, seededRandom, shuffled, writeReplayManifest} from "../../support/seed-replay.js"
import {parseStressOptions} from "../../support/stress-cli.js"
import {runStress} from "../../support/stress-runner.js"

test("seed order and injected failure replay exactly", async () => {
  assert.deepEqual(shuffled([1, 2, 3, 4], "failure-77"), shuffled([1, 2, 3, 4], "failure-77"))
  assert.deepEqual(Array.from({length: 10}, seededRandom("failure-77")), Array.from({length: 10}, seededRandom("failure-77")))
  const root = await mkdtemp(join(tmpdir(), "webby-stress-replay-")); const path = join(root, "replay-manifest.json")
  await writeReplayManifest(path, {seed: "failure-77", scenario_ids: ["e2e-lifecycle-removal"], status: "failed", failure: "injected at lifecycle transition 4"})
  const replay = await readReplayManifest(path)
  assert.equal(replay.seed, "failure-77"); assert.equal(replay.failure, "injected at lifecycle transition 4")
  assert.match(await readFile(path, "utf8"), /failure-77/)
})

test("replay preserves the recorded seed and order verbatim", async () => {
  const root = await mkdtemp(join(tmpdir(), "webby-stress-exact-")); const path = join(root, "replay.json")
  const order = ["e2e-extension-controls", "e2e-shared-vertical-slice"]
  await writeReplayManifest(path, {seed: "exact-seed", scenario_ids: order})
  const options = await parseStressOptions([`--replay=${path}`], {})
  let seen
  await runStress({...options, artifactRoot: join(root, "artifacts"), execute: async input => { seen = input }, leakProbe: async () => ({processes: [], listeners: [], handles: [], workspaces: [], profiles: [], databases: [], pending_calls: [], stale_sessions: []})})
  assert.equal(seen.seed, "exact-seed"); assert.deepEqual(seen.scenarioIds, order)
  await assert.rejects(parseStressOptions([`--replay=${path}`, "--seed=other"], {}), /conflicts/)
})

test("stress input rejects zero-work, fractional, negative, NaN, and empty scenarios", async () => {
  for (const args of [["--repetitions=0"], ["--retries=-1"], ["--retries=1.5"], ["--concurrency=NaN"], ["--scenarios="]]) await assert.rejects(parseStressOptions(args, {}))
})
