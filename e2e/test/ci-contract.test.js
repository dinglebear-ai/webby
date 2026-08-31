import assert from "node:assert/strict"
import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"
import test from "node:test"
import {cleanupWorlds, initializeOwnedTempRoot, stageAttested, writeShardManifest} from "../support/ci-runner.js"
import {ArtifactRecorder} from "../support/artifacts.js"

const root = resolve(import.meta.dirname, "../..")
const requiredE2EPaths = ["lib/**", "test/**", "config/**", "priv/**", "assets/**", "e2e/**", "extension/**", "scripts/e2e*", "mix.exs", "mix.lock", ".mise.toml", ".github/workflows/e2e.yml", ".github/workflows/e2e-stress.yml"]
const requiredStressEntries = ["schedule:", "workflow_dispatch:", "npm --prefix e2e run typecheck:stress", "npm --prefix e2e run test:stress", "npm --prefix e2e run test:stress:live", "./scripts/e2e-repeat", "if: always()", "npm --prefix e2e run cleanup"]
const contractsJobBeamSetup = "erlef/setup-beam@0f75c29430f34bb5af4cce5e3b7f6a8860fca236"
const compatibilityBrowserSetup = "npx --prefix e2e playwright install --with-deps chromium"
const fullPullRequestCondition = "github.event_name == 'push' || github.event_name == 'pull_request'"
const fullSuites = '["protocol:full", "chromium:full"]'
const telemetryUpload = "Upload non-secret suite cost and stability telemetry"
const harnessCommand = "npm --prefix e2e run harness:self-test"
const cleanupAttestation = "hashFiles('e2e/artifacts/upload/cleanup/upload-attestation.json') != ''"

function assertTriggerAndStressContracts(primary, stress) {
  for (const path of requiredE2EPaths) assert.ok(primary.includes(`\"${path}\"`), `missing E2E trigger path ${path}`)
  for (const entry of requiredStressEntries) assert.ok(stress.includes(entry), `missing stress workflow entry ${entry}`)
  const contractsJob = primary.slice(primary.indexOf("  contracts:"), primary.indexOf("  protocol-pr:"))
  assert.ok(contractsJob.includes(contractsJobBeamSetup), "contracts job must install pinned Elixir for AST extraction")
  const protocolJob = primary.slice(primary.indexOf("  protocol-pr:"), primary.indexOf("  chromium-pr:"))
  assert.ok(protocolJob.includes(compatibilityBrowserSetup), "protocol job must install Chromium for revocation lifecycle coverage")
  const fullJob = primary.slice(primary.indexOf("  full:"), primary.indexOf("  compatibility:"))
  assert.ok(fullJob.includes(fullPullRequestCondition), "full job must run on pull requests")
  assert.ok(fullJob.includes(fullSuites), "full job must run protocol and Chromium suites")
  assert.ok(fullJob.includes(compatibilityBrowserSetup), "full Chromium suite must install Chromium")
  assert.match(fullJob, /- name: External reaper and leak audit\n\s+if: always\(\)\n\s+run: npm --prefix e2e run cleanup/, "full job must always run cleanup")
  assert.ok(fullJob.includes(telemetryUpload) && fullJob.includes("suite-telemetry.json") && fullJob.includes("retention-days: 30"), "full job must publish telemetry")
  const compatibilityJob = primary.slice(primary.indexOf("  compatibility:"))
  assert.ok(compatibilityJob.includes(compatibilityBrowserSetup), "compatibility job must install Chromium for live browser work")
  const harnessJob = stress.slice(stress.indexOf("  harness-self-test:"), stress.indexOf("  nightly:"))
  for (const entry of [contractsJobBeamSetup, compatibilityBrowserSetup, harnessCommand, "if: always()", "npm --prefix e2e run cleanup"]) assert.ok(harnessJob.includes(entry), `harness self-test must include ${entry}`)
}

test("weighted manifests prove complete disjoint scenario assignment", async t => {
  const directory = await mkdtemp(join(tmpdir(), "webby-ci-contract-")); t.after(() => rm(directory, {recursive: true, force: true}))
  const value = await writeShardManifest({lane: "nightly", driver: "protocol", total: 3, shard: 2, output: join(directory, "manifest.json")})
  const assigned = value.shards.flatMap(shard => shard.scenarios)
  assert.equal(assigned.length, value.inventory.length)
  assert.equal(new Set(assigned).size, value.inventory.length)
  assert.deepEqual(value.selected, value.shards[1].scenarios)
})

test("workflows pin actions and enforce failure-only attested uploads plus always cleanup", async () => {
  for (const name of ["e2e.yml", "e2e-stress.yml"]) {
    const workflow = await readFile(join(root, ".github/workflows", name), "utf8")
    for (const use of workflow.matchAll(/uses:\s+([^\s]+)/g)) assert.match(use[1], /@[0-9a-f]{40}$/)
    assert.match(workflow, /permissions:\n\s+contents: read/)
    assert.match(workflow, /if: always\(\)/)
    assert.match(workflow, /npm --prefix e2e run cleanup/)
  }
  const primary = await readFile(join(root, ".github/workflows/e2e.yml"), "utf8")
  const stress = await readFile(join(root, ".github/workflows/e2e-stress.yml"), "utf8")
  assertTriggerAndStressContracts(primary, stress)
  assert.equal((primary.match(/hashFiles\('e2e\/artifacts\/upload\/upload-attestation\.json'\) != ''/g) ?? []).length, 4)
  assert.equal((primary.match(new RegExp(cleanupAttestation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 4)
  assert.doesNotMatch(primary, /pull_request_target|secrets\./)
})

test("every E2E trigger path and deterministic, seam, live, and cleanup command is mutation guarded", async () => {
  const primary = await readFile(join(root, ".github/workflows/e2e.yml"), "utf8")
  const stress = await readFile(join(root, ".github/workflows/e2e-stress.yml"), "utf8")
  for (const path of requiredE2EPaths) assert.throws(() => assertTriggerAndStressContracts(primary.replace(`\"${path}\"`, "\"removed/**\""), stress), /missing E2E trigger path/)
  for (const entry of requiredStressEntries) assert.throws(() => assertTriggerAndStressContracts(primary, stress.replaceAll(entry, "removed-entry")), /missing stress workflow entry/)
  assert.throws(() => assertTriggerAndStressContracts(primary.replace(contractsJobBeamSetup, "removed/setup-beam@0000000000000000000000000000000000000000"), stress), /contracts job must install pinned Elixir/)
  const protocolJob = primary.slice(primary.indexOf("  protocol-pr:"), primary.indexOf("  chromium-pr:"))
  assert.throws(() => assertTriggerAndStressContracts(primary.replace(protocolJob, protocolJob.replace(compatibilityBrowserSetup, "removed browser setup")), stress), /protocol job must install Chromium/)
  const fullJob = primary.slice(primary.indexOf("  full:"), primary.indexOf("  compatibility:"))
  assert.throws(() => assertTriggerAndStressContracts(primary.replace(fullJob, fullJob.replace(fullPullRequestCondition, "github.event_name == 'push'")), stress), /full job must run on pull requests/)
  assert.throws(() => assertTriggerAndStressContracts(primary.replace(fullJob, fullJob.replace(fullSuites, '["protocol:full"]')), stress), /full job must run protocol and Chromium suites/)
  assert.throws(() => assertTriggerAndStressContracts(primary.replace(fullJob, fullJob.replace(compatibilityBrowserSetup, "removed browser setup")), stress), /full Chromium suite must install Chromium/)
  assert.throws(() => assertTriggerAndStressContracts(primary.replace(fullJob, fullJob.replace("if: always()", "if: success()")), stress), /full job must always run cleanup/)
  assert.throws(() => assertTriggerAndStressContracts(primary.replace(fullJob, fullJob.replace(telemetryUpload, "removed telemetry")), stress), /full job must publish telemetry/)
  const harnessJob = stress.slice(stress.indexOf("  harness-self-test:"), stress.indexOf("  nightly:"))
  for (const entry of [contractsJobBeamSetup, compatibilityBrowserSetup, harnessCommand, "npm --prefix e2e run cleanup"]) assert.throws(() => assertTriggerAndStressContracts(primary, stress.replace(harnessJob, harnessJob.replace(entry, "removed seam"))), /harness self-test must include/)
  const compatibilityJob = primary.slice(primary.indexOf("  compatibility:"))
  assert.throws(() => assertTriggerAndStressContracts(primary.replace(compatibilityJob, compatibilityJob.replace(compatibilityBrowserSetup, "removed browser setup")), stress), /compatibility job must install Chromium/)
})

test("failure staging copies only candidates verified by the sanitizer attestation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "webby-ci-artifact-")); t.after(() => rm(directory, {recursive: true, force: true}))
  const input = join(directory, "failure.log"); await writeFile(input, "bounded failure evidence\n")
  const recorder = await new ArtifactRecorder({root: join(directory, "recorder"), scenarioId: "ci-failure", worldId: "ci-world"}).open()
  await recorder.ingest(input, {kind: "log", essential: true}); await recorder.finalize({status: "failed", cleanup: {reaper: "complete"}})
  const upload = join(directory, "upload"); await stageAttested(recorder, upload)
  assert.equal((await stat(join(upload, "upload-attestation.json"))).isFile(), true)
  assert.equal((await stat(join(upload, "replay-manifest.json"))).isFile(), true)
})

test("external cleanup refuses arbitrary and unowned roots and removes an empty owned root", async t => {
  const arbitrary = await mkdtemp(join(tmpdir(), "webby-arbitrary-")); await writeFile(join(arbitrary, "keep.txt"), "keep")
  const unowned = await mkdtemp(join(tmpdir(), "webby-ci-run-"))
  t.after(() => Promise.all([rm(arbitrary, {recursive: true, force: true}), rm(unowned, {recursive: true, force: true})]))
  await assert.rejects(cleanupWorlds({temporaryRoot: arbitrary}), /refused/)
  await assert.rejects(cleanupWorlds({temporaryRoot: unowned}), /ownership marker/)
  assert.equal(await readFile(join(arbitrary, "keep.txt"), "utf8"), "keep")
  const owned = await initializeOwnedTempRoot(); assert.equal(await cleanupWorlds({temporaryRoot: owned}), 0)
  await assert.rejects(stat(owned), error => error.code === "ENOENT")
})

test("contracts-only and already-removed recorded roots produce a successful empty cleanup audit", async t => {
  const artifactDirectory = join(root, "e2e", "artifacts"); await rm(artifactDirectory, {recursive: true, force: true})
  assert.equal(await cleanupWorlds(), 0)
  let report = JSON.parse(await readFile(join(artifactDirectory, "cleanup-report.json"), "utf8")); assert.equal(report.empty_audit, true)
  const removed = await initializeOwnedTempRoot(); await rm(removed, {recursive: true, force: true})
  assert.equal(await cleanupWorlds({recordedRoot: removed}), 0)
  report = JSON.parse(await readFile(join(artifactDirectory, "cleanup-report.json"), "utf8")); assert.equal(report.recorded_root_absent, true)
  t.after(() => rm(artifactDirectory, {recursive: true, force: true}))
})

test("structured scenario telemetry is consumed before the external residual audit", async () => {
  const runner = await readFile(join(root, "e2e/support/ci-runner.js"), "utf8")
  assert.match(runner, /finally \{ await rm\(scenarioTelemetryPath, \{force: true\}\) \}/)
})

test("cleanup narrowly removes inert run-owned Mix residue", async () => {
  const owned = await initializeOwnedTempRoot(); const uid = process.getuid(); const namespace = "abcdefghijklmnop"
  const lock = join(owned, `mix_lock_user${uid}`, namespace); const pubsub = join(owned, `mix_pubsub_user${uid}`, namespace)
  await mkdir(lock, {recursive: true}); await mkdir(pubsub, {recursive: true})
  await writeFile(join(lock, "lock_0"), "owner metadata"); await writeFile(join(lock, "port_2"), "owner metadata"); await writeFile(join(pubsub, "port_1"), "")
  assert.equal(await cleanupWorlds({temporaryRoot: owned}), 0)
  await assert.rejects(stat(owned), error => error.code === "ENOENT")
  const report = JSON.parse(await readFile(join(root, "e2e/artifacts/cleanup-report.json"), "utf8"))
  assert.deepEqual(report.failures, [])
  assert.deepEqual(report.roots.map(value => value.root).sort(), [`mix_lock_user${uid}`, `mix_pubsub_user${uid}`])
})

test("late cleanup failures are persisted and staged as attested evidence", async t => {
  const owned = await initializeOwnedTempRoot()
  const residue = join(owned, "unattested.txt")
  await writeFile(residue, "preserve and report")
  t.after(() => rm(owned, {recursive: true, force: true}))

  assert.equal(await cleanupWorlds({temporaryRoot: owned}), 1)
  const report = JSON.parse(await readFile(join(root, "e2e/artifacts/cleanup-report.json"), "utf8"))
  assert.match(report.failures.at(-1).error, /unattested residue remains: unattested\.txt/)
  const upload = join(root, "e2e/artifacts/upload/cleanup")
  assert.equal((await stat(join(upload, "upload-attestation.json"))).isFile(), true)
  const attestation = JSON.parse(await readFile(join(upload, "upload-attestation.json"), "utf8"))
  const reportArtifact = attestation.files.find(file => file.path !== "cleanup-report.json" && file.path.endsWith("-cleanup-report.json"))
  assert.ok(reportArtifact, "attestation must include the finalized cleanup report")
  const staged = JSON.parse(await readFile(join(upload, reportArtifact.path), "utf8"))
  assert.deepEqual(staged, report)
})

test("cleanup preserves malicious, similarly named, and symlinked Mix residue", async t => {
  const roots = []
  for (const variant of ["malicious", "wrong-user", "symlink"]) {
    const owned = await initializeOwnedTempRoot(); roots.push(owned); const uid = process.getuid(); const name = variant === "wrong-user" ? `mix_lock_user${uid + 1}` : `mix_lock_user${uid}`
    const target = join(owned, name); await mkdir(target)
    if (variant === "malicious") await writeFile(join(target, "payload"), "do not delete")
    else if (variant === "wrong-user") await mkdir(join(target, "abcdefghijklmnop"))
    else { const outside = await mkdtemp(join(tmpdir(), "webby-mix-outside-")); roots.push(outside); await symlink(outside, join(target, "abcdefghijklmnop")) }
    assert.equal(await cleanupWorlds({temporaryRoot: owned}), 1)
    assert.equal((await stat(target)).isDirectory(), true)
  }
  t.after(() => Promise.all(roots.map(path => rm(path, {recursive: true, force: true}))))
})
