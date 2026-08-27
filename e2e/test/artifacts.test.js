import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {lstat, mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {promisify} from "node:util"
import test from "node:test"
import {ArtifactRecorder} from "../support/artifacts.js"
import {ArtifactOverflowError, EventJournal} from "../support/event-journal.js"

const execFileAsync = promisify(execFile)

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "webby-artifacts-test-"))
  t.after(() => rm(root, {recursive: true, force: true}))
  return root
}

test("event journal streams versioned correlated records and retains a validated prefix on overflow", async t => {
  const root = await workspace(t)
  const path = join(root, "events.ndjson")
  const journal = await new EventJournal({path, scenarioId: "scenario-a", worldId: "world-a", maxEvents: 3, maxBytes: 4096, maxQueuedBytes: 4096}).open()
  await journal.record("protocol", "connected", {attempt: 1})
  await journal.record("fixture", "ready", {})
  await assert.rejects(journal.record("world", "too-many", {}), error => error instanceof ArtifactOverflowError && error.code === "artifact_overflow")
  await journal.close()
  const records = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(records.length, 3)
  assert.deepEqual(records.map(record => record.sequence), [1, 2, 3])
  assert.ok(records.every(record => record.scenario_id === "scenario-a" && record.world_id === "world-a" && record.journal_version === 1))
  const truncation = JSON.parse(await readFile(`${path}.truncation.json`, "utf8"))
  assert.equal(truncation.code, "artifact_overflow"); assert.equal(truncation.first_failure_preserved, true)
})

test("concurrent producers fail explicitly instead of growing an unbounded write queue", async t => {
  const root = await workspace(t)
  const path = join(root, "events.ndjson")
  const journal = await new EventJournal({path, scenarioId: "backpressure", worldId: "world", maxEvents: 100, maxBytes: 64_000, maxQueuedBytes: 600}).open()
  const writes = await Promise.allSettled(Array.from({length: 1_000}, (_, index) => journal.record("protocol", "burst", {index, payload: "x".repeat(300)})))
  const rejected = writes.filter(result => result.status === "rejected")
  assert.ok(rejected.length > 900)
  assert.ok(rejected.every(result => result.reason instanceof ArtifactOverflowError && result.reason.code === "artifact_overflow" && result.reason.details.reason === "backpressure_limit"))
  assert.equal(new Set(rejected.map(result => result.reason)).size, 1)
  await journal.close()
  const retained = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse)
  assert.ok(retained.length >= 1); assert.ok(retained.length < 11)
})

test("expanded staged output is rechecked against scenario and job quotas before accounting", async t => {
  const root = await workspace(t)
  const source = join(root, "compressed"); await mkdir(source)
  await writeFile(join(source, "large.log"), "diagnostic\n".repeat(20_000))
  const archive = join(root, "large.zip")
  await execFileAsync("zip", ["-q", "-9", archive, "large.log"], {cwd: source})
  const jobBudget = {bytes: 0}
  const recorder = await new ArtifactRecorder({root: join(root, "quota-expanded"), scenarioId: "expanded", worldId: "world", jobBudget, limits: {fileBytes: 1024 * 1024, scenarioBytes: 64 * 1024, jobBytes: 128 * 1024, reserveBytes: 0}}).open()
  await assert.rejects(recorder.ingest(archive, {kind: "trace", essential: true}), error => error.code === "archive_size_limit")
  assert.equal(recorder.items.length, 0); assert.equal(recorder.accountedBytes, 0); assert.equal(jobBudget.bytes, 0)
  assert.deepEqual(await recorder.uploadCandidates(), [])
  await recorder.journal.close()
})

test("cumulative expanded quota omits a later compressed archive while preserving attestable first evidence", async t => {
  const root = await workspace(t)
  const source = join(root, "cumulative"); await mkdir(source)
  const expanded = Array.from({length: 3_000}, (_, index) => `diagnostic-${index}-surface-${index % 17}`).join("\n")
  const archives = []
  for (const name of ["first", "second"]) {
    await writeFile(join(source, `${name}.log`), expanded)
    const archive = join(root, `${name}.zip`)
    await execFileAsync("zip", ["-q", "-9", archive, `${name}.log`], {cwd: source})
    archives.push(archive)
  }
  const recorder = await new ArtifactRecorder({root: join(root, "cumulative-bundle"), scenarioId: "cumulative", worldId: "world", limits: {fileBytes: 256 * 1024, scenarioBytes: 100 * 1024, jobBytes: 256 * 1024, reserveBytes: 0}}).open()
  const first = await recorder.ingest(archives[0], {name: "first.zip", kind: "trace"})
  assert.ok(first.expanded_bytes > first.bytes)
  assert.deepEqual(await recorder.ingest(archives[1], {name: "second.zip", kind: "trace"}), {omitted: true})
  assert.equal(recorder.items.length, 1)
  assert.equal(recorder.accountedBytes, first.expanded_bytes)
  assert.equal(recorder.omissions.at(-1).reason, "scenario_quota")
  const result = await recorder.finalize({status: "failed", cleanup: {resources: "released"}})
  assert.ok(result.uploadCandidates.includes(first.staged))
  assert.equal(result.replay.items.filter(item => item.kind === "trace").length, 1)
  assert.equal(result.replay.omissions.at(-1).reason, "scenario_quota")
})

test("secret zones mechanically prohibit browser capture and never invoke capture callbacks", async t => {
  const root = await workspace(t)
  const journal = await new EventJournal({path: join(root, "events.ndjson"), scenarioId: "secret-zone", worldId: "world"}).open()
  const chromium = journal.producer("chromium")
  let invoked = false
  await chromium.secretZone("credential-creation", async () => {
    for (const kind of ["trace", "screenshot", "video", "dom", "clipboard", "attachment", "extension-storage"]) {
      await assert.rejects(chromium.capture(kind, async () => { invoked = true }), error => error.code === "secret_zone_capture_prohibited")
    }
  })
  assert.equal(invoked, false)
  assert.equal(await chromium.capture("log", async () => "safe"), "safe")
  await journal.close()
  const events = (await readFile(join(root, "events.ndjson"), "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(events.filter(event => event.type === "capture.prohibited").length, 7)
})

test("central recorder serves all producers and emits replayable attested sanitized staging", async t => {
  const root = await workspace(t)
  const input = join(root, "protocol.log")
  const secret = "one-time-dashboard-token-8675309"
  await writeFile(input, `Authorization: Bearer ${secret}\nrequest_id=abc failure=timeout`)
  const recorder = await new ArtifactRecorder({root: join(root, "bundle"), scenarioId: "vertical-slice", worldId: "world-1", seed: 42, versions: {webby: "0.1.0", node: process.version}, secrets: [secret]}).open()
  for (const producer of ["protocol", "chromium", "fixture", "world", "mcp", "dashboard"]) await recorder.producers[producer].event("producer.ready", {producer})
  await recorder.producers.chromium.diagnostic("browser.json", {url: "https://fixture.test", status: "failed"}, ["url", "status"])
  await assert.rejects(recorder.producers.chromium.diagnostic("invalid.json", {url: "safe", privateStorage: secret}, ["url"]), error => error.code === "diagnostic_schema_violation")
  await recorder.producers.protocol.artifact(input, {kind: "protocol", essential: true})
  await recorder.producers.chromium.failure({summary: "tool timeout", detail: secret})
  const result = await recorder.finalize({status: "failed", cleanup: {processes: "gone", listeners: "closed", files: "removable"}})
  assert.equal(result.replay.scenario_id, "vertical-slice"); assert.equal(result.replay.seed, 42)
  assert.equal(result.replay.first_failure.details.summary, "tool timeout")
  assert.ok(result.uploadCandidates.length >= 4)
  const joined = (await Promise.all(result.uploadCandidates.map(path => readFile(path)))).map(bytes => bytes.toString()).join("\n")
  assert.doesNotMatch(joined, /one-time-dashboard-token|8675309/)
  assert.match(joined, /request_id=abc/); assert.match(joined, /processes/)
})

test("sanitizer failure and post-attestation tampering produce zero upload candidates", async t => {
  const root = await workspace(t)
  const unknown = join(root, "trace.bin"); await writeFile(unknown, "opaque")
  const failed = await new ArtifactRecorder({root: join(root, "failed"), scenarioId: "fail-closed", worldId: "world"}).open()
  await assert.rejects(failed.ingest(unknown, {kind: "trace"}), error => error.code === "unsupported_format")
  assert.deepEqual(await failed.uploadCandidates(), [])
  await failed.journal.close()

  const log = join(root, "safe.log"); await writeFile(log, "diagnostic")
  const recorder = await new ArtifactRecorder({root: join(root, "tamper"), scenarioId: "tamper", worldId: "world"}).open()
  const item = await recorder.ingest(log, {kind: "log"})
  const result = await recorder.finalize()
  assert.ok(result.uploadCandidates.length > 0)
  assert.equal(result.retention.raw_quarantine, "deleted")
  await assert.rejects(lstat(recorder.rawRoot), error => error.code === "ENOENT")
  await writeFile(item.staged, "changed after attestation")
  assert.deepEqual(await recorder.uploadCandidates(), [])

  const attestationRecorder = await new ArtifactRecorder({root: join(root, "attestation"), scenarioId: "attestation", worldId: "world"}).open()
  await attestationRecorder.ingest(log, {kind: "log"})
  await attestationRecorder.finalize()
  await writeFile(attestationRecorder.attestationPath, JSON.stringify({...attestationRecorder.attestation, scenario_id: "substituted"}))
  assert.deepEqual(await attestationRecorder.uploadCandidates(), [])

  const archiveSource = join(root, "archive-source"); await mkdir(archiveSource)
  await writeFile(join(archiveSource, "trace.log"), "safe")
  const safeArchive = join(root, "safe.zip")
  await execFileAsync("zip", ["-q", "-r", safeArchive, "."], {cwd: archiveSource})
  const recursive = await new ArtifactRecorder({root: join(root, "recursive"), scenarioId: "recursive", worldId: "world", secrets: ["nested-secret-canary"]}).open()
  const archiveItem = await recursive.ingest(safeArchive, {kind: "trace"})
  await writeFile(join(archiveSource, "trace.log"), "nested-secret-canary")
  await execFileAsync("zip", ["-q", "-r", "-FS", archiveItem.staged, "."], {cwd: archiveSource})
  await assert.rejects(recursive.finalize(), error => error.code === "secret_survived")
  assert.deepEqual(await recursive.uploadCandidates(), [])
})

test("a shared job budget bounds recorders across scenarios", async t => {
  const root = await workspace(t)
  const evidence = join(root, "evidence.log"); await writeFile(evidence, "x".repeat(32))
  const jobBudget = {bytes: 0}
  const first = await new ArtifactRecorder({root: join(root, "one"), scenarioId: "one", worldId: "one", jobBudget, limits: {jobBytes: 48, reserveBytes: 0}}).open()
  await first.ingest(evidence, {kind: "log"})
  const second = await new ArtifactRecorder({root: join(root, "two"), scenarioId: "two", worldId: "two", jobBudget, limits: {jobBytes: 48, reserveBytes: 0}}).open()
  assert.deepEqual(await second.ingest(evidence, {kind: "log"}), {omitted: true})
  assert.equal(second.omissions[0].reason, "job_quota")
  await first.journal.close(); await second.journal.close()
})

test("free-space reserve fails closed before retaining optional evidence", async t => {
  const root = await workspace(t)
  const evidence = join(root, "evidence.log"); await writeFile(evidence, "diagnostic")
  const recorder = await new ArtifactRecorder({root: join(root, "space"), scenarioId: "space", worldId: "world", limits: {reserveBytes: Number.MAX_SAFE_INTEGER}}).open()
  assert.deepEqual(await recorder.ingest(evidence, {kind: "log"}), {omitted: true})
  assert.equal(recorder.omissions[0].reason, "free_space")
  await recorder.journal.close()
})

test("nonessential quota overflow is deterministically omitted while first failure remains", async t => {
  const root = await workspace(t)
  const first = join(root, "first.log"); const second = join(root, "second.log")
  await writeFile(first, "x".repeat(3_000)); await writeFile(second, "y".repeat(3_000))
  const recorder = await new ArtifactRecorder({root: join(root, "quota"), scenarioId: "quota", worldId: "world", limits: {fileBytes: 4_096, scenarioBytes: 5_000, reserveBytes: 0}}).open()
  await recorder.recordFailure("world", {summary: "first failure"})
  await recorder.ingest(first, {kind: "log"})
  assert.deepEqual(await recorder.ingest(second, {kind: "log"}), {omitted: true})
  const result = await recorder.finalize({status: "failed"})
  assert.equal(result.replay.first_failure.details.summary, "first failure")
  assert.equal(result.replay.omissions[0].reason, "scenario_quota")
})
