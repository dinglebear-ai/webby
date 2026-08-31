import {createHash} from "node:crypto"
import {mkdir, writeFile} from "node:fs/promises"
import {join} from "node:path"
import {emitLiveTestReceipt} from "./live-test-receipt.js"

const safe = value => /^[a-z0-9][a-z0-9-]*$/.test(value)
const digest = value => createHash("sha256").update(value).digest("hex")

export function validateProducerRecord(record) {
  if (!record || typeof record !== "object" || !["artifact_attestation", "sqlite_result", "transport_exchange", "chrome_event", "workflow_source"].includes(record.kind) || typeof record.producer !== "string" || !record.producer || typeof record.correlation !== "string" || !record.correlation || !/^[a-f0-9]{64}$/.test(record.payload_sha256 ?? "")) throw new Error("producer record is not native, correlated, and digest-bound")
  if (digest(JSON.stringify(record.payload)) !== record.payload_sha256) throw new Error("producer record payload digest drifted")
  if (record.kind === "transport_exchange" && (!Number.isInteger(record.payload?.status) || !record.payload?.request || !record.payload?.response)) throw new Error("transport exchange record is incomplete")
  if (record.kind === "chrome_event" && (!Number.isInteger(record.payload?.sequence) || !record.payload?.event_name)) throw new Error("Chrome event record is incomplete")
  if (record.kind === "sqlite_result" && !Array.isArray(record.payload?.rows)) throw new Error("SQLite producer record is incomplete")
  if (record.kind === "artifact_attestation" && !/^[a-f0-9]{64}$/.test(record.payload?.attestation_sha256 ?? "")) throw new Error("artifact producer record is incomplete")
  if (record.kind === "workflow_source" && !/^[a-f0-9]{64}$/.test(record.payload?.source_sha256 ?? "")) throw new Error("workflow producer record is incomplete")
  return record
}

export function producerRecord(kind, producer, correlation, payload) {
  const snapshot = structuredClone(payload)
  return Object.freeze({kind, producer, correlation: String(correlation), payload: snapshot, payload_sha256: digest(JSON.stringify(snapshot))})
}

export async function retainLiveProducerEvidence({scenarioId, adapter, receiptId, assertions, producerRecords}) {
  const inbox = process.env.WEBBY_E2E_EVIDENCE_INBOX
  const runNonce = process.env.WEBBY_E2E_RUN_NONCE
  if (!inbox && !runNonce) return undefined
  if (!inbox || !runNonce || ![scenarioId, adapter, receiptId].every(safe) || !Array.isArray(producerRecords) || producerRecords.length === 0) throw new Error("live producer evidence custody is invalid")
  const evidence = {schema_version: 1, kind: "live_test_producer_evidence", scenario_id: scenarioId, adapter, receipt_id: receiptId, run_nonce: runNonce, assertions_sha256: digest(JSON.stringify(assertions)), producer_records: producerRecords.map(validateProducerRecord)}
  const bytes = Buffer.from(`${JSON.stringify(evidence)}\n`)
  const sha256 = digest(bytes)
  await mkdir(inbox, {recursive: true, mode: 0o700})
  const path = join(inbox, `producer-${scenarioId}-${adapter}-${receiptId}-${sha256}.json`)
  await writeFile(path, bytes, {flag: "wx", mode: 0o600})
  return {path, sha256}
}

export async function emitBoundLiveTestReceipt(options) {
  const retained = await retainLiveProducerEvidence(options)
  if (!retained) return undefined
  return emitLiveTestReceipt({...options, evidencePath: retained.path, evidenceSha256: retained.sha256})
}
