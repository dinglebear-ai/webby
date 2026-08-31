import {createHash} from "node:crypto"
import {selectCombinations} from "./validate-contracts.js"

const freezeRows = rows => Object.freeze(rows.map(row => Object.freeze(row)))
const sha256 = value => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export const HTTP_DENIAL_CASES = freezeRows([
  {id: "http.accept.missing-event-stream", expected: 406, mutate: "accept-json-only"},
  {id: "http.content-type.text", expected: 400, mutate: "content-type-text"},
  {id: "http.content-type.missing", expected: 400, mutate: "content-type-missing"},
  {id: "http.origin.foreign", expected: 403, mutate: "foreign-origin"},
  {id: "http.credential.missing", expected: 401, mutate: "missing-credential"},
  {id: "http.credential.wrong", expected: 401, mutate: "wrong-credential"},
  {id: "http.credential.revoked", expected: 401, mutate: "revoked-credential"},
  {id: "http.scope.read-cannot-call", expected: 403, mutate: "read-call"},
  {id: "http.version.empty", expected: 400, mutate: "empty-version"},
  {id: "http.version.unsupported", expected: 400, mutate: "unsupported-version"},
  {id: "http.json.incomplete", expected: 400, mutate: "incomplete-json"},
  {id: "http.json.null", expected: [200, 400], rpc: -32600, mutate: "json-null"},
  {id: "http.json.array", expected: [200, 400], rpc: -32600, mutate: "json-array"},
  {id: "http.jsonrpc.version", expected: [200, 400], rpc: -32600, mutate: "jsonrpc-version"},
  {id: "http.jsonrpc.method-missing", expected: [200, 400], rpc: -32600, mutate: "method-missing"},
  {id: "http.arguments.malformed", expected: 200, tool: "invalid_arguments", mutate: "malformed-arguments"},
  {id: "http.body.below", expected: 200, mutate: "body-below"},
  {id: "http.body.at", expected: 200, mutate: "body-at"},
  {id: "http.body.above", expected: 413, mutate: "body-above"},
  {id: "http.body.compressed", expected: [400, 415], mutate: "compressed"},
  {id: "http.body.segmented-slow", expected: 200, mutate: "segmented-slow"},
  {id: "http.body.incomplete", expected: 0, mutate: "incomplete"},
])

export const WEBSOCKET_DENIAL_CASES = freezeRows([
  {id: "ws.origin.http", phase: "handshake", mutate: "http-origin"},
  {id: "ws.origin.foreign-extension", phase: "handshake", mutate: "foreign-extension-origin"},
  {id: "ws.extension.invalid", phase: "handshake", mutate: "invalid-extension-id"},
  {id: "ws.extension.query-origin-mismatch", phase: "handshake", mutate: "query-origin-mismatch"},
  {id: "ws.envelope.null", phase: "message", kind: "invalid_envelope", mutate: "null-envelope"},
  {id: "ws.envelope.version", phase: "message", kind: "unsupported_protocol_version", mutate: "unsupported-version"},
  {id: "ws.envelope.type", phase: "message", kind: "unknown_message_type", mutate: "unknown-type"},
  {id: "ws.envelope.request-id-at", phase: "message", kind: "not_ready", mutate: "request-id-at"},
  {id: "ws.envelope.request-id-above", phase: "message", kind: "invalid_envelope", mutate: "request-id-above"},
  {id: "ws.pairing.display-name-empty", phase: "message", kind: "invalid_payload", mutate: "empty-display-name"},
  {id: "ws.pairing.display-name-above", phase: "message", kind: "invalid_payload", mutate: "display-name-above"},
  {id: "ws.discovery.observations-below", phase: "message", kind: "not_ready", mutate: "observations-below"},
  {id: "ws.discovery.observations-at", phase: "message", kind: "not_ready", mutate: "observations-at"},
  {id: "ws.discovery.observations-above", phase: "message", kind: "invalid_payload", mutate: "observations-above"},
  {id: "ws.discovery.url-at", phase: "message", kind: "not_ready", mutate: "url-at"},
  {id: "ws.discovery.url-above", phase: "message", kind: "invalid_payload", mutate: "url-above"},
  {id: "ws.discovery.tools-at", phase: "message", kind: "not_ready", mutate: "tools-at"},
  {id: "ws.discovery.tools-above", phase: "message", kind: "invalid_payload", mutate: "tools-above"},
  {id: "ws.result.call-id-at", phase: "message", kind: "not_ready", mutate: "call-id-at"},
  {id: "ws.result.call-id-above", phase: "message", kind: "invalid_payload", mutate: "call-id-above"},
  {id: "ws.result.body-below", phase: "message", kind: "not_ready", mutate: "result-below"},
  {id: "ws.result.body-at", phase: "message", kind: "not_ready", mutate: "result-at"},
  {id: "ws.result.body-above", phase: "message", kind: "invalid_payload", mutate: "result-above"},
  {id: "ws.result.depth-below", phase: "message", kind: "not_ready", mutate: "result-depth-below"},
  {id: "ws.result.depth-at", phase: "message", kind: "not_ready", mutate: "result-depth-at"},
  {id: "ws.result.depth-above", phase: "message", kind: "invalid_payload", mutate: "result-depth-above"},
  {id: "ws.frame.invalid-json", phase: "raw", kind: "closed", mutate: "raw-invalid-json"},
  {id: "ws.frame.invalid-phoenix", phase: "raw", kind: "closed", mutate: "raw-invalid-phoenix"},
  {id: "ws.frame.below", phase: "raw-boundary", kind: "open", mutate: "raw-frame-below", bytes: 262129, raw_frame_bytes: 262143},
  {id: "ws.frame.at", phase: "raw-boundary", kind: "open", mutate: "raw-frame-at", bytes: 262130, raw_frame_bytes: 262144},
  {id: "ws.frame.above", phase: "raw", kind: "closed", mutate: "raw-frame-above", bytes: 262131, raw_frame_bytes: 262145},
])

export const ISOLATION_CASES = freezeRows([
  {id: "isolation.cross-world-handle", boundary: "world", expected: "stale_handle"},
  {id: "isolation.cross-contract-handle", boundary: "contract", expected: "stale_handle"},
  {id: "isolation.cross-browser-identity", boundary: "browser", expected: "browser_identity_mismatch"},
  {id: "isolation.cross-credential-revoked", boundary: "credential", expected: 401},
  {id: "isolation.capability-replay", boundary: "capability", expected: "rejected"},
  {id: "isolation.cross-session-call", boundary: "session", expected: "not_found"},
  {id: "isolation.catalog.below", boundary: "catalog", expected: "stale_catalog"},
  {id: "isolation.catalog.at", boundary: "catalog", expected: "succeeded"},
  {id: "isolation.catalog.above", boundary: "catalog", expected: "stale_catalog"},
  {id: "isolation.arguments.below", boundary: "arguments", expected: "succeeded"},
  {id: "isolation.arguments.at", boundary: "arguments", expected: "succeeded"},
  {id: "isolation.arguments.above", boundary: "arguments", expected: "invalid_arguments"},
])

export const SECURITY_CASES = Object.freeze([...HTTP_DENIAL_CASES, ...WEBSOCKET_DENIAL_CASES, ...ISOLATION_CASES])
export const SECURITY_MATRIX_VERSION = 1
export const securityMatrixManifest = seed => Object.freeze({version: SECURITY_MATRIX_VERSION, seed, case_ids: SECURITY_CASES.map(row => row.id), digest: sha256(SECURITY_CASES)})

export function expandSecurityMatrix(contract) {
  const expected = ["http-mcp", "browser-websocket-handshake", "browser-websocket-message", "cross-transport-call"]
  if (JSON.stringify(contract?.security_matrices?.map(matrix => matrix.id)) !== JSON.stringify(expected)) throw new Error("security operation matrices are missing or reordered")
  return Object.freeze(contract.security_matrices.flatMap(matrix => {
    const rows = selectCombinations({...matrix, cartesian_driver: "none"}, "protocol")
    for (const [dimension, values] of Object.entries(matrix.dimensions)) for (const value of values) if (!rows.some(row => row[dimension] === value)) throw new Error(`${matrix.id} inventory value is uncovered: ${dimension}=${value}`)
    return rows.map((row, index) => Object.freeze({matrix: matrix.id, row_id: `${matrix.id}-${String(index + 1).padStart(3, "0")}`, ...row}))
  }))
}

export function securityMatrixShard(rows, {index = 0, total = 1} = {}) {
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(index) || index < 0 || index >= total) throw new Error("invalid security matrix shard")
  return Object.freeze(rows.filter(row => Number.parseInt(sha256(row.row_id).slice(0, 8), 16) % total === index))
}

export function nestedJson(depth) {
  let value = true
  for (let index = 0; index < depth; index++) value = {nested: value}
  return value
}

export function assertUniqueSecurityCases() {
  const ids = SECURITY_CASES.map(row => row.id)
  if (new Set(ids).size !== ids.length) throw new Error("duplicate security matrix case id")
  return true
}
