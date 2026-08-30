import assert from "node:assert/strict"
import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"
import test from "node:test"
import {cleanupWorlds, initializeOwnedTempRoot, stageAttested, writeShardManifest} from "../support/ci-runner.js"
import {ArtifactRecorder} from "../support/artifacts.js"

const root = resolve(import.meta.dirname, "../..")

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
  assert.match(primary, /if: failure\(\) && hashFiles\('e2e\/artifacts\/upload\/upload-attestation\.json'\) != ''/)
  assert.doesNotMatch(primary, /pull_request_target|secrets\./)
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

test("cleanup narrowly removes inert run-owned Mix residue", async () => {
  const owned = await initializeOwnedTempRoot(); const uid = process.getuid(); const namespace = "abcdefghijklmnop"
  const lock = join(owned, `mix_lock_user${uid}`, namespace); const pubsub = join(owned, `mix_pubsub_user${uid}`, namespace)
  await mkdir(lock, {recursive: true}); await mkdir(pubsub, {recursive: true})
  await writeFile(join(lock, "lock_0"), "owner metadata"); await writeFile(join(pubsub, "port_1"), "")
  assert.equal(await cleanupWorlds({temporaryRoot: owned}), 0)
  await assert.rejects(stat(owned), error => error.code === "ENOENT")
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
