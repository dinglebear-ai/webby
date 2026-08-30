import assert from "node:assert/strict"
import {mkdtemp, readFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {ParityExecutor, scenarioContractHash, signOutcomeRecord, validateStrictResult, verifyOutcomeRecord} from "../../support/parity-executor.js"
import {contractHash} from "../../support/parity-report.js"

const scenario = JSON.parse(await readFile(new URL("../../contracts/scenarios/lifecycle-removal.json", import.meta.url), "utf8"))
const sourceRevision = "a".repeat(40)
const toolchainFingerprints = {protocol: "b".repeat(64), chromium: "c".repeat(64)}
const seed = "parity-mutation-seed"
const signingKey = "parity-test-signing-key-material-32-bytes-minimum"

function result(adapter, mutate = value => value) {
  const outcomes = Object.fromEntries(scenario.outcomes.map(({key}) => [key, {state: "terminal", terminal: true, field: key}]))
  const raw_observables = scenario.outcomes.map(({key}) => ({key: `${adapter}.${key}`, value: outcomes[key], normalized_as: key}))
  return mutate({scenario_id: scenario.id, outcomes, raw_observables, required_raw_keys: scenario.parity[adapter].required_raw_keys})
}

function record(adapter, payload = result(adapter), overrides = {}) {
  return signOutcomeRecord({record_version: 1, contract_hash: contractHash(), scenario_contract_hash: scenarioContractHash(scenario), source_revision: sourceRevision, toolchain_fingerprint: toolchainFingerprints[adapter], adapter, seed, world_nonce: `${adapter}-` + "w".repeat(32), result: payload, ...overrides}, signingKey)
}

test("signed outcome records bind every cache key and reject tampering", () => {
  const valid = record("protocol")
  assert.deepEqual(verifyOutcomeRecord(valid, {scenario, adapter: "protocol", sourceRevision, toolchainFingerprint: toolchainFingerprints.protocol, seed, signingKey}), {ok: true, errors: []})
  for (const [field, value, expected] of [
    ["contract_hash", "0".repeat(64), "global contract"], ["scenario_contract_hash", "0".repeat(64), "scenario contract"],
    ["source_revision", "d".repeat(40), "source revision"], ["toolchain_fingerprint", "e".repeat(64), "toolchain"], ["seed", "other", "seed"],
  ]) {
    const candidate = structuredClone(valid); candidate[field] = value
    const checked = verifyOutcomeRecord(candidate, {scenario, adapter: "protocol", sourceRevision, toolchainFingerprint: toolchainFingerprints.protocol, seed, signingKey})
    assert.ok(checked.errors.some(error => error.includes(expected)), field)
    assert.ok(checked.errors.includes("outcome signature mismatch"), field)
  }
})

test("strict normalization mutation guards reject deletion addition drift and raw-only terminal fields", () => {
  for (const key of scenario.outcomes.map(row => row.key)) {
    const deleted = result("chromium", value => { delete value.outcomes[key]; return value })
    assert.ok(validateStrictResult(deleted, scenario, "chromium").length, `deleted ${key}`)
  }
  const added = result("chromium", value => { value.outcomes.uncontracted = {state: "terminal"}; return value })
  assert.ok(validateStrictResult(added, scenario, "chromium").some(error => error.includes("outcome fields")))
  const drifted = result("chromium", value => { value.raw_observables[0].value = {...value.raw_observables[0].value, field: "drift"}; return value })
  assert.ok(validateStrictResult(drifted, scenario, "chromium").some(error => error.includes("drifted")))
  for (const name of ["audit", "cancellation", "capacity", "document-identity"]) {
    const rawOnly = result("chromium", value => { value.raw_observables.push({key: `chromium.${name}.terminal`, value: {state: "terminal"}, normalized_as: name}); return value })
    assert.ok(validateStrictResult(rawOnly, scenario, "chromium").some(error => error.includes("unconsumed") || error.includes("denominator")), name)
  }
  const unknownField = result("chromium", value => { value.raw_observables[0].surprise = true; return value })
  assert.ok(validateStrictResult(unknownField, scenario, "chromium").some(error => error.includes("fields are invalid")))
})

test("executor runs every side once, reuses valid records, and reruns only missing or stale sides", async () => {
  const root = await mkdtemp(join(tmpdir(), "webby-parity-executor-"))
  const calls = []
  const execute = () => new ParityExecutor({scenarios: [scenario], sourceRevision, toolchainFingerprints, seed, signingKey, cacheDirectory: join(root, "cache"), outputDirectory: join(root, "artifacts"), runScenario: async ({scenario: selected, adapter, staleErrors}) => {
    calls.push({scenario: selected.id, adapter, staleErrors})
    return {world_nonce: `${adapter}-` + "x".repeat(32), result: result(adapter)}
  }}).execute()
  const first = await execute()
  assert.equal(first.report.ok, true); assert.equal(calls.length, 2)
  assert.deepEqual(first.report.execution.map(row => row.disposition), ["rerun-missing", "rerun-missing"])
  const second = await execute()
  assert.equal(calls.length, 2); assert.deepEqual(second.report.execution.map(row => row.disposition), ["reused", "reused"])

  const chromiumPath = join(root, "cache", `${scenario.id}.chromium.outcome.json`)
  const stale = JSON.parse(await readFile(chromiumPath, "utf8")); stale.source_revision = "f".repeat(40)
  await (await import("node:fs/promises")).writeFile(chromiumPath, JSON.stringify(stale))
  const third = await execute()
  assert.equal(calls.length, 3); assert.deepEqual(third.report.execution.map(row => row.disposition), ["reused", "rerun-stale"])
})

test("executor fails closed for missing adapter execution and normalized terminal drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "webby-parity-fail-"))
  let omitChromium = true
  await assert.rejects(new ParityExecutor({scenarios: [scenario], sourceRevision, toolchainFingerprints, seed, signingKey, cacheDirectory: root, runScenario: async ({adapter}) => {
    if (adapter === "chromium" && omitChromium) return {world_nonce: "w".repeat(32), result: undefined}
    return {world_nonce: "w".repeat(32), result: result(adapter)}
  }}).execute(), /fresh chromium.*invalid/)
  omitChromium = false
  const driftRoot = await mkdtemp(join(tmpdir(), "webby-parity-drift-"))
  await assert.rejects(new ParityExecutor({scenarios: [scenario], sourceRevision, toolchainFingerprints, seed, signingKey, cacheDirectory: driftRoot, runScenario: async ({adapter}) => ({world_nonce: "w".repeat(32), result: result(adapter, value => {
    if (adapter === "chromium") { value.outcomes["caller.terminal"] = {state: "failed", terminal: true, field: "caller.terminal"}; value.raw_observables[0].value = value.outcomes["caller.terminal"] }
    return value
  })})}).execute(), error => error.code === "parity_failed" && error.report.errors.some(message => message.includes("normalized outcomes differ")))
})
