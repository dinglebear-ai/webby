import {createHash, createHmac} from "node:crypto"
import {mkdir, readFile, rename, writeFile} from "node:fs/promises"
import {join, resolve} from "node:path"
import {compareParity, contractHash} from "./parity-report.js"

export const OUTCOME_RECORD_VERSION = 1
export const PARITY_REPORT_VERSION = 1
export const PARITY_ADAPTERS = Object.freeze(["protocol", "chromium"])

const recordKeys = Object.freeze(["record_version", "contract_hash", "scenario_contract_hash", "source_revision", "toolchain_fingerprint", "adapter", "seed", "world_nonce", "result", "signature"])
const resultKeys = Object.freeze(["scenario_id", "outcomes", "raw_observables", "required_raw_keys"])
const observableKeys = Object.freeze(["key", "value", "normalized_as"])
const nondeterministic = /(?:^|\.)(?:port|pid|timestamp|uuid|duration|transient-ordering)(?:$|\.)/

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function stable(value) { return JSON.stringify(canonical(value)) }
function sha256(value) { return createHash("sha256").update(value).digest("hex") }
function recordMac(value, signingKey) {
  if (!(typeof signingKey === "string" || Buffer.isBuffer(signingKey)) || Buffer.byteLength(signingKey) < 32) throw new Error("outcome record signing key must contain at least 32 bytes")
  return createHmac("sha256", signingKey).update(value).digest("hex")
}
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (stable(actual) !== stable(wanted)) throw new Error(`${label} fields are invalid: expected ${wanted.join(",")}; got ${actual.join(",")}`)
}

export function scenarioContractHash(scenario) { return sha256(stable(scenario)) }

export function signOutcomeRecord(unsignedRecord, signingKey) {
  exactKeys(unsignedRecord, recordKeys.filter(key => key !== "signature"), "unsigned outcome record")
  return {...unsignedRecord, signature: {algorithm: "hmac-sha256", digest: recordMac(stable(unsignedRecord), signingKey)}}
}

export function verifyOutcomeRecord(record, {scenario, adapter, sourceRevision, toolchainFingerprint, seed, signingKey} = {}) {
  const errors = []
  try { exactKeys(record, recordKeys, "outcome record") } catch (error) { errors.push(error.message); return {ok: false, errors} }
  if (record.record_version !== OUTCOME_RECORD_VERSION) errors.push("unsupported outcome record version")
  if (record.contract_hash !== contractHash()) errors.push("stale global contract hash")
  if (record.scenario_contract_hash !== scenarioContractHash(scenario)) errors.push("stale scenario contract hash")
  if (record.source_revision !== sourceRevision) errors.push("stale source revision")
  if (record.toolchain_fingerprint !== toolchainFingerprint) errors.push("stale toolchain fingerprint")
  if (record.adapter !== adapter) errors.push("adapter mismatch")
  if (String(record.seed) !== String(seed)) errors.push("seed mismatch")
  if (record.result?.scenario_id !== scenario?.id) errors.push("scenario ID mismatch")
  if (!record.world_nonce || String(record.world_nonce).length < 32) errors.push("world nonce is absent")
  try {
    exactKeys(record.signature, ["algorithm", "digest"], "outcome signature")
    if (record.signature.algorithm !== "hmac-sha256") errors.push("unsupported outcome signature algorithm")
    const {signature: _signature, ...unsigned} = record
    if (record.signature.digest !== recordMac(stable(unsigned), signingKey)) errors.push("outcome signature mismatch")
  } catch (error) { errors.push(error.message) }
  errors.push(...validateStrictResult(record.result, scenario, adapter))
  return {ok: errors.length === 0, errors}
}

export function validateStrictResult(result, scenario, adapter) {
  const errors = []
  try { exactKeys(result, resultKeys, `${adapter}/${scenario?.id} result`) } catch (error) { return [error.message] }
  const expectedOutcomeKeys = scenario.outcomes.map(row => row.key).sort()
  const actualOutcomeKeys = Object.keys(result.outcomes ?? {}).sort()
  if (stable(actualOutcomeKeys) !== stable(expectedOutcomeKeys)) errors.push(`${adapter}/${scenario.id}: outcome fields do not exactly match the scenario contract`)
  const committed = scenario.parity?.[adapter]
  if (!committed) return [...errors, `${adapter}/${scenario.id}: missing committed adapter contract`]
  const required = [...committed.required_raw_keys].sort()
  if (stable([...(result.required_raw_keys ?? [])].sort()) !== stable(required)) errors.push(`${adapter}/${scenario.id}: required raw denominator drifted`)
  const rawKeys = []
  const normalized = []
  for (const observable of result.raw_observables ?? []) {
    try { exactKeys(observable, observableKeys, `${adapter}/${scenario.id} raw observable`) } catch (error) { errors.push(error.message); continue }
    rawKeys.push(observable.key); normalized.push(observable.normalized_as)
    if (!Object.hasOwn(result.outcomes ?? {}, observable.normalized_as)) errors.push(`${adapter}/${scenario.id}: raw observable ${observable.key} is unconsumed`)
    else if (stable(observable.value) !== stable(result.outcomes[observable.normalized_as])) errors.push(`${adapter}/${scenario.id}: raw observable ${observable.key} drifted during normalization`)
  }
  if (new Set(rawKeys).size !== rawKeys.length) errors.push(`${adapter}/${scenario.id}: duplicate raw observable`)
  if (new Set(normalized).size !== normalized.length) errors.push(`${adapter}/${scenario.id}: multiple raw observables consume one normalized field`)
  if (stable([...rawKeys].sort()) !== stable(required)) errors.push(`${adapter}/${scenario.id}: raw observable fields do not exactly match the committed denominator`)
  if (stable([...normalized].sort()) !== stable(expectedOutcomeKeys)) errors.push(`${adapter}/${scenario.id}: normalized fields are not consumed exactly once`)
  for (const exclusion of committed.raw_exclusions ?? []) {
    if (!nondeterministic.test(exclusion.key)) errors.push(`${adapter}/${scenario.id}: unsupported parity exclusion ${exclusion.key}`)
    for (const field of ["owner", "rationale", "approved_by", "reviewed_on", "expires_on"]) if (!exclusion[field]) errors.push(`${adapter}/${scenario.id}: parity exclusion ${exclusion.key} lacks ${field}`)
  }
  return errors
}

function cacheName(scenarioId, adapter) { return `${scenarioId}.${adapter}.outcome.json` }
async function readRecord(path) {
  try { return JSON.parse(await readFile(path, "utf8")) }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined; throw error }
}
async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {mode: 0o600})
  await rename(temporary, path)
}

export class ParityExecutor {
  constructor({scenarios, sourceRevision, toolchainFingerprints, seed, cacheDirectory, outputDirectory = cacheDirectory, runScenario, recorder, signingKey} = {}) {
    if (!Array.isArray(scenarios) || !scenarios.length) throw new Error("parity scenarios are required")
    if (!/^[a-f0-9]{7,64}$/.test(sourceRevision ?? "")) throw new Error("a source revision is required")
    if (PARITY_ADAPTERS.some(adapter => !/^[a-f0-9]{64}$/.test(toolchainFingerprints?.[adapter] ?? ""))) throw new Error("both adapter toolchain fingerprints are required")
    if (!cacheDirectory || typeof runScenario !== "function") throw new Error("parity cache directory and scenario runner are required")
    recordMac("parity-key-validation", signingKey)
    this.scenarios = scenarios.filter(scenario => PARITY_ADAPTERS.every(adapter => scenario.drivers?.includes(adapter)))
    if (!this.scenarios.length) throw new Error("no both-adapter scenarios were selected")
    this.sourceRevision = sourceRevision; this.toolchainFingerprints = toolchainFingerprints; this.seed = String(seed)
    this.cacheDirectory = resolve(cacheDirectory); this.outputDirectory = resolve(outputDirectory); this.runScenario = runScenario; this.recorder = recorder; this.signingKey = signingKey
  }

  async execute() {
    await mkdir(this.cacheDirectory, {recursive: true, mode: 0o700})
    await mkdir(this.outputDirectory, {recursive: true, mode: 0o700})
    const records = {protocol: [], chromium: []}; const execution = []
    for (const scenario of this.scenarios) for (const adapter of PARITY_ADAPTERS) {
      const path = join(this.cacheDirectory, cacheName(scenario.id, adapter))
      let record = await readRecord(path)
      const validation = record && verifyOutcomeRecord(record, {scenario, adapter, sourceRevision: this.sourceRevision, toolchainFingerprint: this.toolchainFingerprints[adapter], seed: this.seed, signingKey: this.signingKey})
      let disposition = "reused"
      if (!validation?.ok) {
        disposition = record ? "rerun-stale" : "rerun-missing"
        const produced = await this.runScenario({scenario, adapter, seed: this.seed, staleErrors: validation?.errors ?? []})
        const result = produced?.result ?? produced
        const unsigned = {record_version: OUTCOME_RECORD_VERSION, contract_hash: contractHash(), scenario_contract_hash: scenarioContractHash(scenario), source_revision: this.sourceRevision, toolchain_fingerprint: this.toolchainFingerprints[adapter], adapter, seed: this.seed, world_nonce: produced?.world_nonce ?? produced?.worldNonce, result}
        record = signOutcomeRecord(unsigned, this.signingKey)
        const fresh = verifyOutcomeRecord(record, {scenario, adapter, sourceRevision: this.sourceRevision, toolchainFingerprint: this.toolchainFingerprints[adapter], seed: this.seed, signingKey: this.signingKey})
        if (!fresh.ok) throw new Error(`fresh ${adapter}/${scenario.id} outcome record is invalid: ${fresh.errors.join("; ")}`)
        await atomicWrite(path, record)
      }
      records[adapter].push(record); execution.push({scenario_id: scenario.id, adapter, disposition})
    }
    const runs = Object.fromEntries(PARITY_ADAPTERS.map(adapter => [adapter, this.aggregate(adapter, records[adapter])]))
    const parity = compareParity(runs.protocol, runs.chromium, this.scenarios)
    const report = {report_version: PARITY_REPORT_VERSION, ok: parity.ok, contract_hash: contractHash(), source_revision: this.sourceRevision, seed: this.seed, expected_scenarios: this.scenarios.map(row => row.id).sort(), execution, compared: parity.compared, errors: parity.errors}
    await this.emitArtifacts(report, runs)
    if (!report.ok) throw Object.assign(new Error(`adapter parity failed: ${report.errors.join("; ")}`), {code: "parity_failed", report})
    return {report, runs, records}
  }

  aggregate(adapter, records) {
    const nonces = records.map(record => record.world_nonce).sort()
    return {contract_version: 1, contract_hash: contractHash(), source_revision: this.sourceRevision, toolchain_fingerprint: sha256(records.map(record => record.toolchain_fingerprint).sort().join("\0")), world_nonce: `parity-${sha256(nonces.join("\0"))}`, seed: this.seed, adapter, results: records.map(record => record.result)}
  }

  async emitArtifacts(report, runs) {
    const files = []
    for (const adapter of PARITY_ADAPTERS) {
      const path = join(this.outputDirectory, `${adapter}-outcomes.json`)
      await atomicWrite(path, runs[adapter]); files.push({adapter, path})
    }
    const reportPath = join(this.outputDirectory, "parity-report.json")
    await atomicWrite(reportPath, report)
    if (this.recorder?.producers?.world) {
      for (const {adapter, path} of files) await this.recorder.producers.world.artifact(path, {name: `${adapter}-outcomes.json`, kind: "report", essential: true})
      await this.recorder.producers.world.artifact(reportPath, {name: "parity-report.json", kind: "report", essential: true})
      await this.recorder.producers.world.diagnostic("parity-coverage.json", {schema_version: 1, expected: report.expected_scenarios, compared: report.compared, ok: report.ok}, ["schema_version", "expected", "compared", "ok"])
    }
  }
}
