import {createHash, randomUUID} from "node:crypto"
import {lstat, mkdir, readFile, writeFile} from "node:fs/promises"
import {basename, join, resolve} from "node:path"

const safe = value => /^[a-z0-9][a-z0-9-]*$/.test(value)

const schemas = Object.freeze({
  "capacity-matrix-live": ["rows_executed", "pending_calls", "audit_delta_per_row"],
  "concurrency-live": ["scan_tabs", "peak_batch_limit", "active_sessions"],
  "ci-entrypoints-contract": ["workflows_checked", "full_suites", "cleanup_gates", "mutation_guards"],
  "persistence-matrix-live": ["restart_combinations", "schema_generation"],
  "retention-erasure-live": ["retention_batches", "rows_deleted", "anonymized_browser", "deleted_browser"],
  "transport-security-live": ["cross_world_replays_rejected", "cross_contract_replays_rejected", "cleanup_audits"],
  "extension-controls-live": ["commands_executed", "chrome_events_observed", "dashboard_operations_observed"],
  "chromium-persistence-live": ["retention_batches", "durable_identity", "startup_reconciled", "browser_erased"],
  "chromium-fresh-profile-live": ["public_key_rotated", "browser_identity_absent", "database_browser_rows"],
  "fixture-protocol-live": ["tool_outcomes", "transport_exchanges", "side_effects"],
  "lifecycle-removal-live": ["rows_executed", "pending_calls", "open_resources"],
})

export function validateLiveReceiptAssertions(receiptId, assertions) {
  const required = schemas[receiptId]
  if (!required || !assertions || typeof assertions !== "object" || Array.isArray(assertions) || Object.keys(assertions).sort().join(",") !== [...required].sort().join(",")) throw new Error(`live test receipt assertions do not match schema: ${receiptId}`)
  if (Object.values(assertions).some(value => value === undefined || value === null)) throw new Error(`live test receipt assertions are incomplete: ${receiptId}`)
  const numbers = Object.values(assertions).filter(value => typeof value === "number")
  if (numbers.some(value => !Number.isInteger(value) || value < 0)) throw new Error(`live test receipt numeric assertions are invalid: ${receiptId}`)
  if (["capacity-matrix-live", "concurrency-live", "persistence-matrix-live", "retention-erasure-live", "transport-security-live", "extension-controls-live", "chromium-persistence-live", "fixture-protocol-live"].includes(receiptId) && numbers.length === 0) throw new Error(`live test receipt requires measured numeric assertions: ${receiptId}`)
  if (receiptId === "capacity-matrix-live" && (assertions.rows_executed < 1 || assertions.pending_calls !== 0 || assertions.audit_delta_per_row !== 1)) throw new Error("capacity receipt measurements are not terminal")
  if (receiptId === "fixture-protocol-live" && (assertions.tool_outcomes !== 8 || assertions.transport_exchanges !== 8 || assertions.side_effects !== 1)) throw new Error("fixture receipt denominator is incomplete")
  if (receiptId === "lifecycle-removal-live" && (assertions.rows_executed !== 18 || assertions.pending_calls !== 0 || assertions.open_resources !== 0)) throw new Error("lifecycle receipt denominator is incomplete or nonterminal")
  if (receiptId === "extension-controls-live" && (assertions.commands_executed < 1 || assertions.chrome_events_observed < 1 || assertions.dashboard_operations_observed < 1)) throw new Error("extension control receipt has no live measurements")
  return true
}

export async function emitLiveTestReceipt({scenarioId, adapter, receiptId, assertions, evidencePath, evidenceSha256}) {
  const inbox = process.env.WEBBY_E2E_EVIDENCE_INBOX
  const runNonce = process.env.WEBBY_E2E_RUN_NONCE
  if (!inbox && !runNonce) return undefined
  if (!inbox || !runNonce) throw new Error("live test receipt custody is only partially configured")
  if (![scenarioId, adapter, receiptId].every(safe) || !["protocol", "chromium"].includes(adapter)) throw new Error("invalid live test receipt identity")
  validateLiveReceiptAssertions(receiptId, assertions)
  if (typeof evidencePath !== "string" || !/^[a-f0-9]{64}$/.test(evidenceSha256 ?? "")) throw new Error("live test receipt requires a pre-existing producer artifact path and digest")
  const source = resolve(evidencePath)
  const info = await lstat(source).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error("live test receipt producer artifact is missing or unsafe")
  const evidenceBytes = await readFile(source)
  if (createHash("sha256").update(evidenceBytes).digest("hex") !== evidenceSha256) throw new Error("live test receipt producer artifact digest drifted")
  let evidence
  try { evidence = JSON.parse(evidenceBytes) } catch { throw new Error("live test receipt producer artifact must be typed JSON") }
  if (evidence.schema_version !== 1 || evidence.kind !== "live_test_producer_evidence" || evidence.scenario_id !== scenarioId || evidence.adapter !== adapter || evidence.receipt_id !== receiptId || evidence.run_nonce !== runNonce || evidence.assertions_sha256 !== createHash("sha256").update(JSON.stringify(assertions)).digest("hex") || !Array.isArray(evidence.producer_records) || evidence.producer_records.length === 0) throw new Error("live test receipt producer artifact is unbound or untyped")
  await mkdir(inbox, {recursive: true, mode: 0o700})
  const receipt = {
    schema_version: 1,
    kind: "live_test_assertion_receipt",
    scenario_id: scenarioId,
    adapter,
    receipt_id: receiptId,
    run_nonce: runNonce,
    assertions,
    producer_evidence_sha256: evidenceSha256,
    producer_evidence_file: basename(source),
  }
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`)
  const digest = createHash("sha256").update(bytes).digest("hex")
  const path = join(inbox, `live-${scenarioId}-${adapter}-${receiptId}-${digest}.json`)
  await writeFile(path, bytes, {flag: "wx", mode: 0o600})
  return {path, digest, receipt}
}
