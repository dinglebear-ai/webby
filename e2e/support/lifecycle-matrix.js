import {readFile, writeFile} from "node:fs/promises"
import {assertLifecycleVocabulary} from "./assertions.js"

const lifecyclePath = new URL("../contracts/lifecycle-matrix.json", import.meta.url)
const scenarioPath = new URL("../contracts/scenarios/lifecycle-removal.json", import.meta.url)
export const PROTOCOL_PHASES = Object.freeze(["idle", "in-flight"])
export const LIFECYCLE_EVIDENCE = Object.freeze(["caller", "browser_work", "session", "late_result", "capacity", "audit"])

export async function protocolLifecycleRows({lifecycle = lifecyclePath, scenario = scenarioPath, owner = "webby-ihb.16"} = {}) {
  const [matrix, contract] = await Promise.all([
    readFile(lifecycle, "utf8").then(JSON.parse),
    readFile(scenario, "utf8").then(JSON.parse),
  ])
  const declared = new Set(contract.combinations.dimensions.transition)
  const transitions = matrix.transitions.filter(row => row.drivers.includes("protocol") && row.owner === owner)
  for (const row of transitions) {
    if (!declared.has(row.id)) throw Object.assign(new Error(`lifecycle transition is absent from scenario combinations: ${row.id}`), {code: "unmapped_lifecycle_transition"})
  }
  return transitions.flatMap(transition => (transition.phases ?? PROTOCOL_PHASES).map(phase => Object.freeze({
    id: `${contract.id}:protocol:${transition.id}:${phase}`,
    scenario_id: contract.id,
    transition: transition.id,
    phase,
    trigger: transition.trigger,
    recovery: transition.recovery,
    contract_version: contract.contract_version,
  })))
}

function exactAudit(audit, row) {
  if (row.phase === "idle") {
    if (audit?.state !== "absent" || audit.count !== 0) throw Object.assign(new Error(`${row.id}: idle transition must not fabricate an audit`), {code: "invalid_lifecycle_audit", audit})
    return
  }
  if (audit?.terminal !== true || audit.count !== 1 || typeof audit.outcome !== "string") {
    throw Object.assign(new Error(`${row.id}: audit must contain exactly one terminal outcome`), {code: "invalid_lifecycle_audit", audit})
  }
}

export function assertProtocolLifecycleOutcome(row, outcome, expected = {}) {
  if (outcome?.scenario_id !== row.scenario_id || outcome?.transition !== row.transition || outcome?.phase !== row.phase) {
    throw Object.assign(new Error(`${row.id}: outcome identity does not match its contract row`), {code: "stale_lifecycle_outcome"})
  }
  if (!outcome.world_nonce || !outcome.document_generation || !outcome.socket_generation) {
    throw Object.assign(new Error(`${row.id}: live boundary identity is incomplete`), {code: "missing_lifecycle_identity"})
  }
  if (expected.world_nonce && outcome.world_nonce !== expected.world_nonce) throw Object.assign(new Error(`${row.id}: outcome belongs to another world`), {code: "stale_lifecycle_outcome"})
  if (expected.document_generation && outcome.document_generation !== expected.document_generation) throw Object.assign(new Error(`${row.id}: document generation evidence is stale`), {code: "stale_lifecycle_outcome"})
  if (expected.socket_generation !== undefined && outcome.socket_generation !== expected.socket_generation) throw Object.assign(new Error(`${row.id}: socket generation evidence is stale`), {code: "stale_lifecycle_outcome"})
  for (const key of ["pending_calls_measured", "sessions_measured", "resources_measured", "audit_measured", "browser_work_measured", "late_result_measured"]) {
    if (outcome.evidence?.[key] !== true) throw Object.assign(new Error(`${row.id}: ${key} evidence is missing`), {code: "unmeasured_lifecycle_evidence"})
  }
  if (!Array.isArray(outcome.artifact_refs) || outcome.artifact_refs.length === 0 || outcome.artifact_refs.some(ref => typeof ref !== "string" || ref.length === 0)) {
    throw Object.assign(new Error(`${row.id}: machine-readable artifact references are required`), {code: "missing_lifecycle_artifacts"})
  }
  if (outcome.artifacts_attested !== true) throw Object.assign(new Error(`${row.id}: artifacts were not attested before cleanup`), {code: "missing_lifecycle_artifacts"})
  if (row.phase === "idle") {
    for (const subject of LIFECYCLE_EVIDENCE) if (!(subject in outcome.normalized)) throw Object.assign(new Error(`missing lifecycle outcome: ${subject}`), {code: "missing_lifecycle_outcome"})
    if (outcome.normalized.caller.state !== "absent" || outcome.normalized.browser_work.state !== "prevented" || outcome.normalized.late_result.state !== "prevented") {
      throw Object.assign(new Error(`${row.id}: idle outcomes must prove absence/prevention`), {code: "invalid_idle_lifecycle_outcome"})
    }
    if (!new Set(["invalidated", "absent"]).has(outcome.normalized.session.state)) throw Object.assign(new Error(`${row.id}: idle session must be invalidated or provably absent`), {code: "invalid_idle_lifecycle_outcome"})
    if (outcome.normalized.capacity.state !== "released") throw Object.assign(new Error(`${row.id}: idle capacity must remain released`), {code: "invalid_idle_lifecycle_outcome"})
  } else {
    assertLifecycleVocabulary(outcome.normalized)
  }
  exactAudit(outcome.normalized.audit, row)
  if (outcome.pending_calls !== 0 || outcome.active_sessions !== 0 || outcome.open_resources !== 0) {
    throw Object.assign(new Error(`${row.id}: lifecycle resources did not drain`), {code: "lifecycle_resource_leak", outcome})
  }
  if (outcome.old_result_accepted !== false) {
    throw Object.assign(new Error(`${row.id}: an old document/socket result was accepted`), {code: "late_result_accepted"})
  }
  return outcome
}

export function assertCompleteProtocolLifecycle(rows, outcomes) {
  const expected = new Map(rows.map(row => [row.id, row]))
  const actual = new Map()
  for (const outcome of outcomes) {
    const row = expected.get(outcome.id)
    if (!row) throw Object.assign(new Error(`unexpected lifecycle outcome: ${outcome.id}`), {code: "unexpected_lifecycle_outcome"})
    if (actual.has(outcome.id)) throw Object.assign(new Error(`duplicate lifecycle outcome: ${outcome.id}`), {code: "duplicate_lifecycle_outcome"})
    actual.set(outcome.id, assertProtocolLifecycleOutcome(row, outcome))
  }
  const missing = [...expected.keys()].filter(id => !actual.has(id))
  if (missing.length) throw Object.assign(new Error(`missing lifecycle outcomes: ${missing.join(", ")}`), {code: "incomplete_lifecycle_matrix", missing})
  return [...actual.values()]
}

export async function publishProtocolLifecycleOracle(path, rows, outcomes) {
  const checked = assertCompleteProtocolLifecycle(rows, outcomes)
  const report = {
    schema_version: 1,
    adapter: "protocol",
    scenario_id: rows[0]?.scenario_id,
    rows: checked.map(({id, transition, phase, world_nonce, document_generation, socket_generation, artifact_refs, normalized}) => ({
      id, transition, phase, world_nonce, document_generation, socket_generation, artifact_refs, normalized,
    })),
  }
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", {mode: 0o600})
  return report
}
