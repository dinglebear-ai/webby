import assert from "node:assert/strict"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {ArtifactRecorder} from "../support/artifacts.js"
import {credentialRevokeOwnerOracle, emitLifecycleParityResult, lifecycleParityKeys, lifecycleParityResult, normalizeLifecycleEvidence, projectLifecycleParity, protocolBrowserRevokeOracle, runLifecycleScenario} from "../support/lifecycle-parity.js"
import {compareParity} from "../support/parity-report.js"

const scenario = JSON.parse(await readFile(new URL("../contracts/scenarios/lifecycle-removal.json", import.meta.url), "utf8"))
const cleanup = async () => ({
  "cleanup.no.calls.remain.pending": {state: "absent"}, "cleanup.no.removed.session.remains.active": {state: "closed"},
  "cleanup.all.driver.resources.close": {state: "closed"}, "cleanup.temporary.world.is.removable": {state: "removable"},
})

test("authoritative lifecycle owners and measured Chromium projection fail closed", async () => {
  assert.deepEqual(Object.keys(projectLifecycleParity(protocolBrowserRevokeOracle)), lifecycleParityKeys)
  assert.deepEqual(Object.keys(projectLifecycleParity(credentialRevokeOwnerOracle)), lifecycleParityKeys)
  assert.equal(credentialRevokeOwnerOracle.caller.state, "revoked")
  assert.equal(credentialRevokeOwnerOracle.session.state, "active")
  assert.throws(() => normalizeLifecycleEvidence({...protocolBrowserRevokeOracle, browserWork: undefined}), /browser abort evidence/)
  assert.throws(() => projectLifecycleParity({...protocolBrowserRevokeOracle, capacity: {state: "released", value: 1}}), /capacity evidence/)

  const root = await mkdtemp(join(tmpdir(), "webby-lifecycle-parity-"))
  try {
    const world = {worldId: "world-lifecycle-parity", instanceNonce: "w".repeat(43), seed: 19019}
    const recorder = await new ArtifactRecorder({root: join(root, "runner"), scenarioId: scenario.id, worldId: world.worldId, seed: world.seed}).open()
    await assert.rejects(runLifecycleScenario({scenario, driver: "chromium", world, recorder, normalized: protocolBrowserRevokeOracle, cleanup}), /runtime surface evidence/)
    await recorder.finalize({status: "passed"})
    const common = {scenario, sourceRevision: "a".repeat(40), seed: world.seed, worldNonce: world.instanceNonce}
    const protocol = lifecycleParityResult({...common, driver: "protocol", normalized: protocolBrowserRevokeOracle})
    const chromiumPath = join(root, "chromium-lifecycle-parity.json")
    const chromium = await emitLifecycleParityResult(chromiumPath, {...common, driver: "chromium", normalized: protocolBrowserRevokeOracle})
    assert.deepEqual(JSON.parse(await readFile(chromiumPath, "utf8")), chromium)
    assert.deepEqual(compareParity(protocol, chromium, [scenario]), {ok: true, errors: [], compared: [scenario.id]})
    const missing = structuredClone(chromium); missing.results[0].raw_observables.pop()
    assert.ok(compareParity(protocol, missing, [scenario]).errors.some(error => error.includes("required raw observable")))
    const drift = structuredClone(chromium); drift.results[0].outcomes["capacity.released"] = {state: "held", value: 1}
    assert.ok(compareParity(protocol, drift, [scenario]).errors.some(error => error.includes("normalized outcomes differ") || error.includes("projected into a different")))
  } finally { await rm(root, {recursive: true, force: true}) }
})
