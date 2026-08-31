import assert from "node:assert/strict"

export const TERMINAL_STATES = Object.freeze(["succeeded", "failed", "cancelled", "timed_out", "rejected"])
export const LIFECYCLE_SUBJECTS = Object.freeze(["caller", "browser_work", "session", "late_result", "capacity", "audit"])

export function normalizeObservation(value) {
  if (value === undefined) return {state: "absent", value: undefined}
  if (value === null) return {state: "absent", value: null}
  if (typeof value !== "object" || Array.isArray(value)) return {state: value === true ? "present" : value === false ? "absent" : "present", value}
  return {state: value.state ?? (value.value === undefined ? "present" : "present"), ...value}
}

export function assertPredicate(predicate, observations, label = predicate.subject) {
  const actual = normalizeObservation(observations[predicate.subject])
  const expected = predicate.expected
  const checks = {
    ready: () => actual.state === "ready" || actual.value === true,
    present: () => actual.state !== "absent" && actual.value !== false,
    absent: () => actual.state === "absent" || actual.value === false,
    terminal: () => actual.terminal === true || actual.state === "terminal" || TERMINAL_STATES.includes(actual.state),
    rejected: () => actual.state === "rejected",
    closed: () => actual.state === "closed",
    released: () => actual.state === "released" || actual.value === 0,
    removable: () => actual.state === "removable" || actual.value === true,
    unchanged: () => actual.state === "unchanged",
    drained: () => actual.state === "drained" || actual.value === 0,
    redacted: () => actual.state === "redacted" || actual.value === true,
    stopped: () => actual.state === "stopped",
    authenticated: () => actual.state === "authenticated" || actual.value === true,
    available: () => actual.state === "available" || actual.value === true,
    invalidated: () => actual.state === "invalidated",
    aborted: () => actual.state === "aborted",
    recovered: () => actual.state === "recovered" || actual.value === true,
    equals: () => { assert.deepEqual(actual.value, expected); return true },
  }
  const check = checks[predicate.kind]
  if (!check) throw Object.assign(new Error(`unknown assertion kind: ${predicate.kind}`), {code: "unknown_assertion_kind"})
  let passed = false
  try { passed = check() }
  catch (error) { throw Object.assign(new Error(`${label}: expected ${predicate.kind}, got ${JSON.stringify(actual)}`, {cause: error}), {code: "scenario_assertion_failed", predicate, actual}) }
  assert.ok(passed, `${label}: expected ${predicate.kind}, got ${JSON.stringify(actual)}`)
  return actual
}

export function assertLifecycleVocabulary(outcomes) {
  for (const subject of LIFECYCLE_SUBJECTS) {
    if (!(subject in outcomes)) throw Object.assign(new Error(`missing lifecycle outcome: ${subject}`), {code: "missing_lifecycle_outcome"})
  }
  assertPredicate({kind: "terminal", subject: "caller"}, outcomes)
  assertPredicate({kind: "aborted", subject: "browser_work"}, outcomes)
  assertPredicate({kind: "invalidated", subject: "session"}, outcomes)
  assertPredicate({kind: "rejected", subject: "late_result"}, outcomes)
  assertPredicate({kind: "released", subject: "capacity"}, outcomes)
  assertPredicate({kind: "terminal", subject: "audit"}, outcomes)
}
