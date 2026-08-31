import {createHash, randomUUID} from "node:crypto"
import {mkdir, writeFile} from "node:fs/promises"
import {join} from "node:path"

const safe = value => /^[a-z0-9][a-z0-9-]*$/.test(value)

export async function emitLiveTestReceipt({scenarioId, adapter, receiptId, assertions}) {
  const inbox = process.env.WEBBY_E2E_EVIDENCE_INBOX
  const runNonce = process.env.WEBBY_E2E_RUN_NONCE
  if (!inbox && !runNonce) return undefined
  if (!inbox || !runNonce) throw new Error("live test receipt custody is only partially configured")
  if (![scenarioId, adapter, receiptId].every(safe) || !["protocol", "chromium"].includes(adapter)) throw new Error("invalid live test receipt identity")
  if (!assertions || typeof assertions !== "object" || Array.isArray(assertions) || Object.keys(assertions).length === 0) throw new Error("live test receipt requires measured assertions")
  const receipt = {
    schema_version: 1,
    kind: "live_test_assertion_receipt",
    scenario_id: scenarioId,
    adapter,
    receipt_id: receiptId,
    run_nonce: runNonce,
    assertions,
  }
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`)
  const digest = createHash("sha256").update(bytes).digest("hex")
  await mkdir(inbox, {recursive: true, mode: 0o700})
  const path = join(inbox, `live-${scenarioId}-${adapter}-${receiptId}-${digest}.json`)
  await writeFile(path, bytes, {flag: "wx", mode: 0o600})
  return {path, digest, receipt}
}
