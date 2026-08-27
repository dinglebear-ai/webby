import assert from "node:assert/strict"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {
  assertCompleteProtocolLifecycle,
  assertProtocolLifecycleOutcome,
  LIFECYCLE_EVIDENCE,
  protocolLifecycleRows,
  publishProtocolLifecycleOracle,
} from "../../support/lifecycle-matrix.js"

function outcome(row, changes = {}) {
  const idle = row.phase === "idle"
  return {
    id: row.id,
    scenario_id: row.scenario_id,
    transition: row.transition,
    phase: row.phase,
    world_nonce: "live-world-nonce",
    document_generation: "document-2",
    socket_generation: 2,
    artifact_refs: ["world-manifest.json", "events.ndjson"],
    artifacts_attested: true,
    normalized: {
      caller: idle ? {state: "absent"} : {state: "cancelled", terminal: true},
      browser_work: idle ? {state: "prevented"} : {state: "aborted"},
      session: {state: "invalidated"},
      late_result: idle ? {state: "prevented"} : {state: "rejected"},
      capacity: {state: "released", value: 0},
      audit: idle ? {state: "absent", count: 0} : {state: "failed", terminal: true, count: 1, outcome: "failed"},
    },
    pending_calls: 0,
    active_sessions: 0,
    open_resources: 0,
    old_result_accepted: false,
    evidence: {pending_calls_measured: true, sessions_measured: true, resources_measured: true, audit_measured: true, browser_work_measured: true, late_result_measured: true},
    ...changes,
  }
}

test("authoritative matrix expands every protocol transition into idle and in-flight rows", async () => {
  const rows = await protocolLifecycleRows()
  const transitions = new Set(rows.map(row => row.transition))
  const authoritative = JSON.parse(await readFile(new URL("../../contracts/lifecycle-matrix.json", import.meta.url), "utf8"))
  assert.equal(transitions.size, authoritative.transitions.filter(row => row.drivers.includes("protocol") && row.owner === "webby-ihb.16").length)
  assert.deepEqual(authoritative.transitions.filter(row => row.drivers.includes("protocol") && row.owner !== "webby-ihb.16").map(row => [row.id, row.owner]), [["server-restart", "webby-ihb.15"], ["retention", "webby-ihb.15"]])
  assert.equal(rows.length, 18)
  for (const transition of transitions) {
    const expected = new Set(["ignore", "credential-revoke"]).has(transition) ? ["idle"] : ["idle", "in-flight"]
    assert.deepEqual(rows.filter(row => row.transition === transition).map(row => row.phase), expected)
  }
  assert.deepEqual(authoritative.transitions.filter(row => row.in_flight_exclusion).map(row => [row.id, row.in_flight_owner]), [["ignore", "webby-ihb.16"], ["credential-revoke", "webby-ihb.14"]])
  assert.deepEqual(LIFECYCLE_EVIDENCE, ["caller", "browser_work", "session", "late_result", "capacity", "audit"])
})

test("matrix coverage fails closed for a missing row, duplicate, assertion cell, or live identity", async () => {
  const rows = await protocolLifecycleRows()
  const outcomes = rows.map(outcome)
  assert.equal(assertCompleteProtocolLifecycle(rows, outcomes).length, rows.length)
  assert.throws(() => assertCompleteProtocolLifecycle(rows, outcomes.slice(1)), error => error.code === "incomplete_lifecycle_matrix")
  assert.throws(() => assertCompleteProtocolLifecycle(rows, [...outcomes, outcomes[0]]), error => error.code === "duplicate_lifecycle_outcome")
  const {browser_work: _removed, ...incomplete} = outcomes[0].normalized
  assert.throws(() => assertProtocolLifecycleOutcome(rows[0], outcome(rows[0], {normalized: incomplete})), error => error.code === "missing_lifecycle_outcome")
  assert.throws(() => assertProtocolLifecycleOutcome(rows[0], outcome(rows[0], {world_nonce: undefined})), error => error.code === "missing_lifecycle_identity")
  assert.throws(() => assertProtocolLifecycleOutcome(rows[0], outcome(rows[0], {artifact_refs: []})), error => error.code === "missing_lifecycle_artifacts")
  assert.throws(() => assertProtocolLifecycleOutcome(rows[0], outcome(rows[0], {evidence: {}})), error => error.code === "unmeasured_lifecycle_evidence")
  assert.throws(() => assertProtocolLifecycleOutcome(rows[0], outcome(rows[0]), {world_nonce: "another-world"}), error => error.code === "stale_lifecycle_outcome")
})

test("late results, non-exact audits, and application or OS resource leaks are release blockers", async () => {
  const row = (await protocolLifecycleRows()).find(item => item.phase === "in-flight")
  assert.throws(() => assertProtocolLifecycleOutcome(row, outcome(row, {old_result_accepted: true})), error => error.code === "late_result_accepted")
  assert.throws(() => assertProtocolLifecycleOutcome(row, outcome(row, {normalized: {...outcome(row).normalized, audit: {state: "failed", terminal: true, count: 2, outcome: "failed"}}})), error => error.code === "invalid_lifecycle_audit")
  for (const field of ["pending_calls", "active_sessions", "open_resources"]) assert.throws(() => assertProtocolLifecycleOutcome(row, outcome(row, {[field]: 1})), error => error.code === "lifecycle_resource_leak")
})

test("normalized protocol outcomes are published as the Chromium parity oracle", async t => {
  const rows = await protocolLifecycleRows()
  const root = await mkdtemp(join(tmpdir(), "webby-lifecycle-oracle-")); t.after(() => rm(root, {recursive: true, force: true}))
  const path = join(root, "protocol-lifecycle.json")
  const report = await publishProtocolLifecycleOracle(path, rows, rows.map(outcome))
  assert.equal(report.rows.length, rows.length)
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), report)
  assert.equal(report.rows.find(row => row.phase === "in-flight").normalized.audit.count, 1)
  assert.equal(report.rows.find(row => row.phase === "idle").normalized.audit.count, 0)
})
