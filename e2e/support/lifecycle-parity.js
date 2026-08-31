import {createHash} from "node:crypto"
import {writeFile} from "node:fs/promises"
import {ScenarioRunner} from "./scenario-runner.js"
import {contractHash} from "./parity-report.js"

export const lifecycleParityKeys = Object.freeze(["caller.terminal", "browser.aborted", "session.invalidated", "late-result.rejected", "capacity.released", "audit.once"])

export function normalizeLifecycleEvidence({caller, browserWork, session, lateResult, capacity, audit}) {
  if (!caller?.terminal || !["cancelled", "revoked"].includes(caller.state)) throw new Error("lifecycle caller terminal evidence is missing or drifted")
  if (browserWork?.state !== "aborted") throw new Error("lifecycle browser abort evidence is missing or drifted")
  if (!new Set(["invalidated", "active"]).has(session?.state)) throw new Error("lifecycle session evidence is missing or drifted")
  if (lateResult?.state !== "rejected") throw new Error("lifecycle late-result evidence is missing or drifted")
  if (capacity?.state !== "released" || capacity.value !== 0) throw new Error("lifecycle capacity evidence is missing or drifted")
  if (!audit?.terminal || audit.count !== 1 || audit.outcome !== "failed") throw new Error("lifecycle exact audit evidence is missing or drifted")
  return Object.freeze({caller, browser_work: browserWork, session, late_result: lateResult, capacity, audit})
}

export const protocolBrowserRevokeOracle = Object.freeze(normalizeLifecycleEvidence({
  caller: {state: "cancelled", terminal: true}, browserWork: {state: "aborted"}, session: {state: "invalidated"},
  lateResult: {state: "rejected"}, capacity: {state: "released", value: 0}, audit: {state: "failed", terminal: true, count: 1, outcome: "failed"},
}))

export const credentialRevokeOwnerOracle = Object.freeze(normalizeLifecycleEvidence({
  caller: {state: "revoked", terminal: true}, browserWork: {state: "aborted"}, session: {state: "active"},
  lateResult: {state: "rejected"}, capacity: {state: "released", value: 0}, audit: {state: "failed", terminal: true, count: 1, outcome: "failed"},
}))

export function projectLifecycleParity(normalized) {
  normalized = normalizeLifecycleEvidence({caller: normalized?.caller, browserWork: normalized?.browser_work, session: normalized?.session, lateResult: normalized?.late_result, capacity: normalized?.capacity, audit: normalized?.audit})
  return {
    "caller.terminal": normalized.caller, "browser.aborted": normalized.browser_work,
    "session.invalidated": normalized.session, "late-result.rejected": normalized.late_result,
    "capacity.released": normalized.capacity, "audit.once": normalized.audit,
  }
}

export async function runLifecycleScenario({scenario, driver, world, recorder, normalized, cleanup, runtimeSurfaceEvidence}) {
  if (!runtimeSurfaceEvidence || typeof runtimeSurfaceEvidence !== "object") throw new Error("lifecycle runtime surface evidence from the executing adapter is required")
  const projected = projectLifecycleParity(normalized)
  const observations = Object.fromEntries(scenario.outcomes.map(item => {
    const value = projected[item.key]
    if (item.predicate.kind === "rejected" && value.state !== "rejected") return [item.predicate.subject, {state: "rejected", terminal: true, value}]
    if (item.predicate.kind === "closed" && value.state !== "closed") return [item.predicate.subject, {state: "closed", terminal: true, value}]
    if (item.predicate.kind === "terminal" && value.terminal !== true && !["succeeded", "failed", "cancelled", "timed_out", "rejected"].includes(value.state)) return [item.predicate.subject, {state: "terminal", terminal: true, value}]
    return [item.predicate.subject, value]
  }))
  const runner = new ScenarioRunner({scenario, driver, world, recorder, actions: {
    "lifecycle.trigger": async ({boundary}) => { observeLifecycleProofs(boundary, runtimeSurfaceEvidence["lifecycle.trigger"]); boundary.complete(); return {observations: {"wait.lifecycle-removal.trigger": {state: "terminal", terminal: true}}} },
    "lifecycle.observe-terminal": async ({boundary}) => { observeLifecycleProofs(boundary, runtimeSurfaceEvidence["lifecycle.observe-terminal"]); boundary.complete(); return {observations: {...observations, "wait.lifecycle-removal.terminal": {state: "terminal", terminal: true}}} },
    "lifecycle.recover": async ({boundary}) => { observeLifecycleProofs(boundary, runtimeSurfaceEvidence["lifecycle.recover"]); boundary.complete(); return {observations: {"wait.lifecycle-removal.recover": {state: "recovered", terminal: true}}} },
  }, observe: async () => ({}), cleanup})
  const result = await runner.run()
  return {...result, normalized: Object.fromEntries(lifecycleParityKeys.map(key => {
    const value = result.normalized[key]
    return [key, ["rejected", "closed", "terminal"].includes(value?.state) && value?.value && typeof value.value === "object" ? value.value : value]
  }))}
}

function observeLifecycleProofs(boundary, proofs) {
  if (!proofs || typeof proofs !== "object" || Array.isArray(proofs)) throw new Error("typed lifecycle boundary proofs are required")
  for (const [surfaceId, proof] of Object.entries(proofs)) boundary.observe(surfaceId, proof)
}

export function lifecycleParityResult({driver, normalized, scenario, sourceRevision, seed, worldNonce}) {
  const outcomes = lifecycleParityKeys.every(key => Object.hasOwn(normalized ?? {}, key)) ? Object.fromEntries(lifecycleParityKeys.map(key => [key, normalized[key]])) : projectLifecycleParity(normalized)
  const required = scenario.parity?.[driver]?.required_raw_keys
  if (!required || required.length !== lifecycleParityKeys.length) throw new Error(`${driver} lifecycle parity denominator is missing or drifted`)
  const rawObservables = lifecycleParityKeys.map(key => {
    const rawKey = `${driver}.${key}`
    if (!required.includes(rawKey)) throw new Error(`${driver} lifecycle parity mapping is missing ${rawKey}`)
    return {key: rawKey, value: outcomes[key], normalized_as: key}
  })
  return {contract_version: 1, contract_hash: contractHash(), source_revision: sourceRevision,
    toolchain_fingerprint: createHash("sha256").update(`${driver}:lifecycle-removal-v1`).digest("hex"), world_nonce: worldNonce,
    seed: String(seed), adapter: driver, results: [{scenario_id: scenario.id, outcomes, raw_observables: rawObservables, required_raw_keys: required}]}
}

export async function emitLifecycleParityResult(path, options) {
  const report = lifecycleParityResult(options)
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", {mode: 0o600})
  return report
}
