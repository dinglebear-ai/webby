import assert from "node:assert/strict"
import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"
import test from "node:test"
import {cleanupWorlds, consumeLiveTestReceipts, fullSuiteScenarioDenominators, initializeOwnedTempRoot, persistScenarioRunReceipts, stageAttested, writeShardManifest} from "../support/ci-runner.js"
import {ArtifactRecorder} from "../support/artifacts.js"
import {emitLiveTestReceipt} from "../support/live-test-receipt.js"
import {emitBoundLiveTestReceipt, producerRecord} from "../support/live-producer-evidence.js"

const root = resolve(import.meta.dirname, "../..")
const requiredE2EPaths = ["lib/**", "test/**", "config/**", "priv/**", "assets/**", "e2e/**", "extension/**", "scripts/e2e*", "mix.exs", "mix.lock", ".mise.toml", ".github/workflows/e2e.yml", ".github/workflows/e2e-stress.yml"]
const requiredStressEntries = ["schedule:", "workflow_dispatch:", "npm --prefix e2e run typecheck:stress", "npm --prefix e2e run test:stress", "npm --prefix e2e run test:stress:live", "./scripts/e2e-repeat", "if: always()", "npm --prefix e2e run cleanup"]
const contractsJobBeamSetup = "erlef/setup-beam@0f75c29430f34bb5af4cce5e3b7f6a8860fca236"
const compatibilityBrowserSetup = "npx --prefix e2e playwright install --with-deps chromium"
const fullBrowserCache = "key: playwright-chromium-${{ runner.os }}-1.62.1-${{ hashFiles('e2e/package-lock.json') }}"
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
  assert.ok(fullJob.includes(fullBrowserCache) && fullJob.includes("path: ~/.cache/ms-playwright"), "full job must cache the pinned Playwright Chromium")
  assert.equal(fullJob.match(new RegExp(compatibilityBrowserSetup, "g"))?.length, 1, "every full matrix suite must install Chromium exactly once")
  assert.doesNotMatch(fullJob, /if: matrix\.suite == 'chromium:full'\s*\n\s*run: npx --prefix e2e playwright install/, "protocol full must not skip Chromium installation")
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

test("suite retention independently copies and verifies immutable scenario evidence", async t => {
  const directory = await mkdtemp(join(tmpdir(), "webby-evidence-retention-")); t.after(() => rm(directory, {recursive: true, force: true}))
  const source = join(directory, "surface-evidence.json")
  const bytes = Buffer.from('{"assertion":"live transport completed"}\n')
  await writeFile(source, bytes)
  const digest = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")
  const run = {scenario_id: "e2e-shared-vertical-slice", adapter: "protocol", duration_ms: 1, status: "passed", evidence_kind: "runtime_boundary", evidence_files: [source], evidence_sha256: digest, run_nonce: "nonce-12345678"}
  const [retained] = await persistScenarioRunReceipts("protocol-pr", [run], {runNonce: run.run_nonce, evidenceRoot: join(directory, "retained"), receiptRoot: join(directory, "receipts")})
  assert.equal(retained.evidence_files.length, 2)
  assert.equal(await readFile(join(directory, "retained", retained.evidence_files[1].split("/").at(-1)), "utf8"), bytes.toString())
})

test("suite retention rejects fabricated, mutated, missing, and cleaned scenario evidence", async t => {
  const directory = await mkdtemp(join(tmpdir(), "webby-evidence-adversarial-")); t.after(() => rm(directory, {recursive: true, force: true}))
  const source = join(directory, "evidence.json"); await writeFile(source, "original")
  const base = {scenario_id: "e2e-shared-vertical-slice", adapter: "protocol", duration_ms: 1, status: "passed", evidence_kind: "runtime_boundary", evidence_files: [source], evidence_sha256: "0".repeat(64), run_nonce: "nonce-12345678"}
  const options = suffix => ({runNonce: base.run_nonce, evidenceRoot: join(directory, `retained-${suffix}`), receiptRoot: join(directory, `receipts-${suffix}`)})
  await assert.rejects(persistScenarioRunReceipts("protocol-pr", [base], options("a")), /hash drifted/)
  await rm(source)
  await assert.rejects(persistScenarioRunReceipts("protocol-pr", [{...base, evidence_files: [source]}], options("b")), /missing, cleaned/)
  const target = join(directory, "target.json"); await writeFile(target, "target"); await symlink(target, source)
  const digest = (await import("node:crypto")).createHash("sha256").update("target").digest("hex")
  await assert.rejects(persistScenarioRunReceipts("protocol-pr", [{...base, evidence_files: [source], evidence_sha256: digest}], options("c")), /not a regular file/)
})

test("full protocol and Chromium telemetry cover every authoritative scenario", async () => {
  const denominators = fullSuiteScenarioDenominators()
  const names = await (await import("node:fs/promises")).readdir(join(root, "e2e/contracts/scenarios"))
  const contracts = await Promise.all(names.filter(name => name.endsWith(".json")).map(name => readFile(join(root, "e2e/contracts/scenarios", name), "utf8").then(JSON.parse)))
  assert.deepEqual([...new Set(Object.values(denominators).flat())].sort(), contracts.map(contract => contract.id).sort())
  for (const [suite, ids] of Object.entries(denominators)) {
    const driver = suite.split("-")[0]
    assert.deepEqual([...ids].sort(), contracts.filter(contract => contract.drivers.includes(driver)).map(contract => contract.id).sort())
  }
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
  const sourceSha256 = (await import("node:crypto")).createHash("sha256").update(primary + stress).digest("hex")
  await emitBoundLiveTestReceipt({scenarioId: "e2e-command-ci-entrypoints", adapter: "protocol", receiptId: "ci-entrypoints-contract", assertions: {workflows_checked: 2, full_suites: 2, cleanup_gates: 4, mutation_guards: true}, producerRecords: [producerRecord("workflow_source", "github-workflow-files", "e2e-workflows", {source_sha256: sourceSha256})]})
})

test("explicit live test receipts require the exact nonce-bound assertion denominator", async t => {
  const directory = await mkdtemp(join(tmpdir(), "webby-live-receipts-")); t.after(() => rm(directory, {recursive: true, force: true}))
  const previous = {inbox: process.env.WEBBY_E2E_EVIDENCE_INBOX, nonce: process.env.WEBBY_E2E_RUN_NONCE}
  process.env.WEBBY_E2E_EVIDENCE_INBOX = directory; process.env.WEBBY_E2E_RUN_NONCE = "receipt-run-nonce"
  t.after(() => {
    if (previous.inbox === undefined) delete process.env.WEBBY_E2E_EVIDENCE_INBOX; else process.env.WEBBY_E2E_EVIDENCE_INBOX = previous.inbox
    if (previous.nonce === undefined) delete process.env.WEBBY_E2E_RUN_NONCE; else process.env.WEBBY_E2E_RUN_NONCE = previous.nonce
  })
  for (const [scenarioId, receiptId, assertions] of [
    ["e2e-capacity-concurrency", "capacity-matrix-live", {rows_executed: 1, pending_calls: 0, audit_delta_per_row: 1}],
    ["e2e-capacity-concurrency", "concurrency-live", {scan_tabs: [10], peak_batch_limit: 128, active_sessions: 10}],
    ["e2e-command-ci-entrypoints", "ci-entrypoints-contract", {workflows_checked: 2, full_suites: 2, cleanup_gates: 4, mutation_guards: true}],
    ["e2e-fixture-tool-outcomes", "fixture-protocol-live", {tool_outcomes: 8, transport_exchanges: 8, side_effects: 1}],
    ["e2e-persistence-retention", "persistence-matrix-live", {restart_combinations: 1, schema_generation: 7}],
    ["e2e-persistence-retention", "retention-erasure-live", {retention_batches: 3, rows_deleted: 6, anonymized_browser: "a", deleted_browser: "b"}],
    ["e2e-transport-security", "transport-security-live", {cross_world_replays_rejected: 2, cross_contract_replays_rejected: 2, cleanup_audits: 0}],
  ]) await emitBoundLiveTestReceipt({scenarioId, adapter: "protocol", receiptId, assertions, producerRecords: [producerRecord("workflow_source", "adversarial-fixture", `${scenarioId}:${receiptId}`, {source_sha256: "a".repeat(64)})]})
  const runs = await consumeLiveTestReceipts("protocol-full", "protocol", [], {runNonce: "receipt-run-nonce", inbox: directory})
  assert.equal(runs.find(run => run.scenario_id === "e2e-command-ci-entrypoints").evidence_kind, "runtime_boundary")
  await assert.rejects(consumeLiveTestReceipts("protocol-full", "protocol", [], {runNonce: "wrong-nonce", inbox: directory}), /invalid or unbound/)
  await assert.rejects(consumeLiveTestReceipts("protocol-full", "chromium", [], {runNonce: "receipt-run-nonce", inbox: directory}), /invalid or unbound/)
  await assert.rejects(emitLiveTestReceipt({scenarioId: "e2e-capacity-concurrency", adapter: "protocol", receiptId: "capacity-matrix-live", assertions: {rows_executed: 1}}), /assertions do not match schema/)
  await assert.rejects(emitLiveTestReceipt({scenarioId: "e2e-capacity-concurrency", adapter: "protocol", receiptId: "capacity-matrix-live", assertions: {rows_executed: 1, pending_calls: 0, audit_delta_per_row: 1}}), /pre-existing producer artifact/)
  const producerName = (await (await import("node:fs/promises")).readdir(directory)).find(name => name.startsWith("producer-e2e-capacity-concurrency-protocol-capacity-matrix-live-"))
  const producerBytes = await readFile(join(directory, producerName))
  const producerSha = (await import("node:crypto")).createHash("sha256").update(producerBytes).digest("hex")
  const crossDirectory = await mkdtemp(join(tmpdir(), "webby-cross-receipt-")); t.after(() => rm(crossDirectory, {recursive: true, force: true}))
  await writeFile(join(crossDirectory, producerName), producerBytes)
  const crossReceipt = {schema_version: 1, kind: "live_test_assertion_receipt", scenario_id: "e2e-persistence-retention", adapter: "protocol", receipt_id: "persistence-matrix-live", run_nonce: "receipt-run-nonce", assertions: {restart_combinations: 1, schema_generation: 7}, producer_evidence_sha256: producerSha, producer_evidence_file: producerName}
  await writeFile(join(crossDirectory, "live-cross-receipt.json"), `${JSON.stringify(crossReceipt)}\n`)
  await assert.rejects(consumeLiveTestReceipts("protocol-full", "protocol", [], {runNonce: "receipt-run-nonce", inbox: crossDirectory}), /cross-bound/)
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
  assert.throws(() => assertTriggerAndStressContracts(primary.replace(fullJob, fullJob.replace(fullBrowserCache, "removed browser cache")), stress), /full job must cache the pinned Playwright Chromium/)
  assert.throws(() => assertTriggerAndStressContracts(primary.replace(fullJob, fullJob.replace(compatibilityBrowserSetup, "removed browser setup")), stress), /every full matrix suite must install Chromium/)
  assert.throws(() => assertTriggerAndStressContracts(primary.replace(fullJob, fullJob.replace(`- run: ${compatibilityBrowserSetup}`, `- if: matrix.suite == 'chromium:full'\n        run: ${compatibilityBrowserSetup}`)), stress), /protocol full must not skip Chromium installation/)
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

test("contracts-only and already-removed recorded roots produce a successful empty cleanup audit", {skip: process.env.WEBBY_E2E_RUN_NONCE ? "suite owns the live artifact root" : false}, async t => {
  const artifactDirectory = join(root, "e2e", "artifacts"); await rm(artifactDirectory, {recursive: true, force: true})
  await mkdir(join(artifactDirectory, "upload", "cleanup"), {recursive: true})
  await mkdir(join(artifactDirectory, "cleanup-attested"), {recursive: true})
  await writeFile(join(artifactDirectory, "upload", "cleanup", "upload-attestation.json"), "stale")
  await writeFile(join(artifactDirectory, "cleanup-attested", "stale.json"), "stale")
  assert.equal(await cleanupWorlds(), 0)
  await assert.rejects(stat(join(artifactDirectory, "upload")), error => error.code === "ENOENT")
  await assert.rejects(stat(join(artifactDirectory, "cleanup-attested")), error => error.code === "ENOENT")
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
