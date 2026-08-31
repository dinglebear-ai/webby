import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {promisify} from "node:util"
import {gzipSync} from "node:zlib"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {ChromiumWorld} from "../../support/chromium-world.js"
import {DashboardDriver} from "../../support/dashboard-driver.js"
import {Ed25519Identity} from "../../support/ed25519-identity.js"
import {MCPClient, jsonRpcError} from "../../support/mcp-client.js"
import {HTTP_DENIAL_CASES, ISOLATION_CASES, SECURITY_CASES, WEBSOCKET_DENIAL_CASES, assertUniqueSecurityCases, expandSecurityMatrix, nestedJson, securityMatrixManifest, securityMatrixShard} from "../../support/protocol-security-matrix.js"
import {LogicalHandles} from "../../support/scenario-runner.js"
import {emitLiveTestReceipt} from "../../support/live-test-receipt.js"
import {SimulatedBrowser} from "../../support/simulated-browser.js"
import {WebbyWorld} from "../../support/world.js"

const contractPath = new URL("../../contracts/scenarios/transport-security.json", import.meta.url)
const execFileAsync = promisify(execFile)
const initialize = JSON.stringify({jsonrpc: "2.0", id: 1, method: "initialize", params: {protocolVersion: "2025-06-18", capabilities: {}}})
const ping = JSON.stringify({jsonrpc: "2.0", id: 2, method: "ping", params: {}})
const extensionOrigin = identity => `chrome-extension://${identity.extensionId}`
const envelope = (type, payload, overrides = {}) => ({protocol_version: 1, type, request_id: "security-case", sent_at: new Date(0).toISOString(), payload, ...overrides})
const auditCount = async world => Number((await execFileAsync("sqlite3", [world.databasePath, "SELECT count(*) FROM invocation_audits;"])).stdout.trim())
const objectAtBytes = bytes => {
  const empty = JSON.stringify({padding: ""}); const value = {padding: "x".repeat(bytes - Buffer.byteLength(empty))}
  assert.equal(Buffer.byteLength(JSON.stringify(value)), bytes); return value
}
const rawPhoenixFrameAtBytes = (browser, bytes) => {
  const frame = [browser.joinRef, null, browser.topic, "message", {padding: ""}]
  const empty = JSON.stringify(frame); frame[4].padding = "x".repeat(bytes - Buffer.byteLength(empty))
  const encoded = JSON.stringify(frame); assert.equal(Buffer.byteLength(encoded), bytes); return encoded
}

function websocketPayload(mutate, identity) {
  const observation = {url: "https://fixture.test", title: "Fixture", tab_id: 1, document_id: "document-1", tools: [{name: "tool", inputSchema: {type: "object"}}]}
  const validPairing = identity.pairingPayload({displayName: "Security matrix"})
  const mutations = {
    "null-envelope": null,
    "unsupported-version": envelope("heartbeat", {}, {protocol_version: 2}),
    "unknown-type": envelope("attacker.message", {secret: "attacker_payload_must_not_reflect"}),
    "request-id-at": envelope("heartbeat", {}, {request_id: "x".repeat(128)}),
    "request-id-above": envelope("heartbeat", {}, {request_id: "x".repeat(129)}),
    "empty-display-name": envelope("pairing.request", {...validPairing, display_name: ""}),
    "display-name-above": envelope("pairing.request", {...validPairing, display_name: "x".repeat(81)}),
    "observations-below": envelope("discovery.observed", {observations: [observation]}),
    "observations-at": envelope("discovery.observed", {observations: Array.from({length: 128}, () => observation)}),
    "observations-above": envelope("discovery.observed", {observations: Array.from({length: 129}, () => observation)}),
    "url-at": envelope("discovery.observed", {observations: [{...observation, url: "x".repeat(8192)}]}),
    "url-above": envelope("discovery.observed", {observations: [{...observation, url: `https://fixture.test/${"x".repeat(8192)}` }]}),
    "tools-at": envelope("discovery.observed", {observations: [{...observation, tools: Array.from({length: 64}, () => observation.tools[0])}]}),
    "tools-above": envelope("discovery.observed", {observations: [{...observation, tools: Array.from({length: 65}, () => observation.tools[0])}]}),
    "call-id-at": envelope("tool.result", {call_id: "x".repeat(128), result: {ok: true}}),
    "call-id-above": envelope("tool.result", {call_id: "x".repeat(129), result: {ok: true}}),
    "result-below": envelope("tool.result", {call_id: "call", result: {ok: true}}),
    "result-at": envelope("tool.result", {call_id: "call", result: "x".repeat(131_070)}),
    "result-above": envelope("tool.result", {call_id: "call", result: {padding: "x".repeat(131_073)}}),
    "result-depth-below": envelope("tool.result", {call_id: "call", result: nestedJson(1)}),
    "result-depth-at": envelope("tool.result", {call_id: "call", result: nestedJson(32)}),
    "result-depth-above": envelope("tool.result", {call_id: "call", result: nestedJson(34)}),
  }
  return mutations[mutate]
}

async function executeHttpCase(row, {world, valid, read, revoked}) {
  const options = {method: "POST", body: initialize}
  let client = valid
  switch (row.mutate) {
    case "accept-json-only": options.headers = {accept: "application/json"}; break
    case "content-type-text": options.headers = {"content-type": "text/plain"}; break
    case "content-type-missing": options.headers = {"content-type": ""}; break
    case "foreign-origin": options.origin = "https://evil.example"; break
    case "missing-credential": options.authenticate = false; break
    case "wrong-credential": options.token = "webby_attacker-secret"; break
    case "revoked-credential": client = revoked; break
    case "read-call": return read.call({action: "page.call", params: {page: "missing", tool: "missing", catalog_revision: 1}})
    case "empty-version": options.body = ping; options.headers = {"mcp-protocol-version": ""}; break
    case "unsupported-version": options.body = ping; options.headers = {"mcp-protocol-version": "1900-01-01"}; break
    case "incomplete-json": options.body = "{"; break
    case "json-null": options.body = "null"; break
    case "json-array": options.body = "[]"; break
    case "jsonrpc-version": options.body = JSON.stringify({jsonrpc: "1.0", id: 1, method: "ping"}); break
    case "method-missing": options.body = JSON.stringify({jsonrpc: "2.0", id: 1}); break
    case "malformed-arguments": return valid.call({action: "page.call", params: {}})
    case "body-below": options.body = JSON.stringify({jsonrpc: "2.0", id: 3, method: "ping", params: {padding: "x".repeat(1024)}}); options.headers = {"mcp-protocol-version": "2025-06-18"}; break
    case "body-at": {
      const prefix = JSON.stringify({jsonrpc: "2.0", id: 3, method: "ping", params: {padding: ""}})
      options.body = prefix.replace('"}}', `${"x".repeat(1_048_576 - Buffer.byteLength(prefix))}"}}`)
      options.headers = {"mcp-protocol-version": "2025-06-18"}
      break
    }
    case "body-above": {
      const prefix = JSON.stringify({jsonrpc: "2.0", id: 3, method: "ping", params: {padding: ""}})
      options.body = prefix.replace('"}}', `${"x".repeat(1_048_577 - Buffer.byteLength(prefix))}"}}`)
      break
    }
    case "compressed": {
      const response = await fetch(`${world.baseUrl}/mcp`, {method: "POST", headers: {accept: "application/json, text/event-stream", authorization: `Bearer ${valid.token}`, "content-type": "application/json", "content-encoding": "gzip"}, body: gzipSync(initialize)})
      const text = await response.text(); return {status: response.status, text}
    }
    case "segmented-slow": {
      const bytes = new TextEncoder().encode(ping); const midpoint = Math.floor(bytes.length / 2)
      let release; let enteredResolve; const entered = new Promise(resolve => { enteredResolve = resolve }); const gate = new Promise(resolve => { release = resolve })
      const body = new ReadableStream({async start(controller) { controller.enqueue(bytes.slice(0, midpoint)); enteredResolve(); await gate; controller.enqueue(bytes.slice(midpoint)); controller.close() }})
      const pending = fetch(`${world.baseUrl}/mcp`, {method: "POST", headers: {accept: "application/json, text/event-stream", authorization: `Bearer ${valid.token}`, "content-type": "application/json", "mcp-protocol-version": "2025-06-18"}, body, duplex: "half"})
      await entered; assert.equal((await fetch(`${world.baseUrl}/health`)).status, 200); release()
      const response = await pending
      return {status: response.status, body: await response.json()}
    }
    case "incomplete": {
      let streamController; const abort = new AbortController()
      const body = new ReadableStream({start(controller) { streamController = controller; controller.enqueue(new TextEncoder().encode("{")) }})
      const pending = fetch(`${world.baseUrl}/mcp`, {method: "POST", headers: {accept: "application/json, text/event-stream", authorization: `Bearer ${valid.token}`, "content-type": "application/json"}, body, duplex: "half", signal: abort.signal})
      await Promise.resolve(); abort.abort("deterministic-incomplete-body"); streamController.error(new Error("incomplete"))
      await assert.rejects(pending); return {status: 0, aborted: true}
    }
    default: throw new Error(`unknown HTTP mutation ${row.mutate}`)
  }
  return client.raw("/mcp", options)
}

async function executeHttpPermutation(row, context) {
  const target = {below: 1_048_575, at: 1_048_576, above: 1_048_577}[row.boundary]
  const token = {anonymous: undefined, read: context.read.token, call: context.call.token, revoked: context.revoked.token, "wrong-secret": "webby_wrong-permutation", "second-valid-call": context.second.token}[row.credential]
  const origin = {absent: undefined, loopback: context.world.baseUrl, foreign: "https://evil.example"}[row.origin]
  const base = JSON.stringify({jsonrpc: "2.0", id: row.row_id, method: "ping", params: {padding: ""}})
  const sized = base.replace('"}}', `${"x".repeat(Math.max(0, target - Buffer.byteLength(base)))}"}}`)
  let body = sized; const headers = {accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-06-18"}
  if (token) headers.authorization = `Bearer ${token}`
  if (origin) headers.origin = origin
  if (row.input === "malformed-json") body = `{${" ".repeat(target - 1)}`
  if (row.input === "compressed") { body = gzipSync(sized); headers["content-encoding"] = "gzip" }
  const send = async () => {
    if (row.input === "incomplete") {
      let streamController; const abort = new AbortController(); const stream = new ReadableStream({start(controller) { streamController = controller; controller.enqueue(new TextEncoder().encode("{")) }})
      const pending = fetch(`${context.world.baseUrl}/mcp`, {method: "POST", headers, body: stream, duplex: "half", signal: abort.signal})
      await Promise.resolve(); abort.abort(row.row_id); streamController.error(new Error("incomplete")); await assert.rejects(pending); return {status: "aborted"}
    }
    if (row.input === "segmented") {
      const bytes = Buffer.from(body); const midpoint = Math.floor(bytes.length / 2); let release; let enteredResolve
      const entered = new Promise(resolve => { enteredResolve = resolve }); const gate = new Promise(resolve => { release = resolve })
      const stream = new ReadableStream({async start(controller) { controller.enqueue(bytes.subarray(0, midpoint)); enteredResolve(); await gate; controller.enqueue(bytes.subarray(midpoint)); controller.close() }})
      const pending = fetch(`${context.world.baseUrl}/mcp`, {method: "POST", headers, body: stream, duplex: "half"}); await entered; release(); const response = await pending; await response.body?.cancel(); return {status: response.status}
    }
    const response = await fetch(`${context.world.baseUrl}/mcp`, {method: "POST", headers, body}); await response.body?.cancel(); return {status: response.status}
  }
  if (row.connection === "late") await fetch(`${context.world.baseUrl}/health`).then(response => assert.equal(response.status, 200))
  const result = await send()
  const bodyRejected = row.input !== "compressed" && (row.boundary === "above" || row.input === "segmented" && row.boundary === "at")
  const expected = row.input === "incomplete" ? "aborted" : bodyRejected ? 413 : row.input === "compressed" || row.input === "malformed-json" ? 400 : row.origin === "foreign" ? 403 : ["anonymous", "revoked", "wrong-secret"].includes(row.credential) ? 401 : 200
  assert.equal(result.status, expected, row.row_id)
  return {...result, expected, request_bytes: Buffer.byteLength(body), source_bytes: target}
}

test("security contract selects one complete, unique, deterministic executable matrix", async () => {
  const contract = JSON.parse(await readFile(contractPath, "utf8"))
  assert.equal(contract.owner, "webby-ihb.13")
  assert.equal(contract.security_matrices.length, 4)
  assert.match(contract.security_matrices[3].exclusions[0].rationale, /global capability tokens/)
  assert.equal(assertUniqueSecurityCases(), true)
  const expanded = expandSecurityMatrix(contract)
  assert.ok(expanded.length > 0)
  assert.deepEqual(new Set(expanded.map(row => row.matrix)), new Set(["http-mcp", "browser-websocket-handshake", "browser-websocket-message", "cross-transport-call"]))
  assert.equal(new Set(expanded.map(row => row.row_id)).size, expanded.length)
  const shards = Array.from({length: 7}, (_, index) => securityMatrixShard(expanded, {index, total: 7}))
  assert.deepEqual(new Set(shards.flat().map(row => row.row_id)), new Set(expanded.map(row => row.row_id)))
  assert.equal(shards.flat().length, expanded.length)
  assert.equal(SECURITY_CASES.length, HTTP_DENIAL_CASES.length + WEBSOCKET_DENIAL_CASES.length + ISOLATION_CASES.length)
  assert.deepEqual(securityMatrixManifest(8675309), securityMatrixManifest(8675309))
  assert.notEqual(securityMatrixManifest(8675309).digest, "")
  for (const boundary of ["world", "contract", "browser", "credential", "capability", "session"]) assert.ok(ISOLATION_CASES.some(row => row.boundary === boundary))
})

test("every generated HTTP/MCP row executes as one combined live permutation", {timeout: 120_000}, async t => {
  const contract = JSON.parse(await readFile(contractPath, "utf8")); const rows = expandSecurityMatrix(contract).filter(row => row.matrix === "http-mcp")
  const world = await WebbyWorld.start({scenarioId: "security-http-permutations", seed: 8675309, preserveArtifacts: true}); t.after(() => world.teardown())
  const root = await mkdtemp(join(tmpdir(), "webby-http-permutations-")); t.after(() => rm(root, {recursive: true, force: true}))
  const recorder = await new ArtifactRecorder({root, scenarioId: "security-http-permutations", worldId: world.worldId, seed: world.seed, secrets: [world.secret]}).open()
  const context = {world, read: await world.provisionCredential({scopes: ["read"]}), call: await world.provisionCredential({scopes: ["read", "call"]}), revoked: await world.provisionCredential({scopes: ["read", "call"]}), second: await world.provisionCredential({scopes: ["read", "call"]})}
  for (const credential of [context.read, context.call, context.revoked, context.second]) recorder.registry.add(credential.token)
  await world.revokeCredential(context.revoked.id)
  const executed = new Set()
  for (const row of rows) {
    assert.equal(executed.has(row.row_id), false); const result = await executeHttpPermutation(row, context); executed.add(row.row_id)
    assert.equal(await auditCount(world), 0, row.row_id)
    assert.equal((await fetch(`${world.baseUrl}/health`)).status, 200, row.row_id)
    await recorder.producers.world.event("security.permutation.executed", {row, result, audit_count: 0, admission_probe: "accepted"})
  }
  assert.deepEqual(executed, new Set(rows.map(row => row.row_id)))
  const artifact = await recorder.finalize({cleanup: {executed_rows: executed.size, audits: 0, listener: "admitted"}})
  assert.equal(artifact.replay.seed, 8675309)
})

test("live Bandit MCP rejects every HTTP credential, Origin, scope, parser, version, and size case", {timeout: 120_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "protocol-security-http", seed: 8675309})
  t.after(() => world.teardown())
  const validCredential = await world.provisionCredential({scopes: ["read", "call"]})
  const readCredential = await world.provisionCredential({scopes: ["read"]})
  const revokedCredential = await world.provisionCredential({scopes: ["read", "call"]})
  await world.revokeCredential(revokedCredential.id)
  const limits = {bodyBytes: 2_000_000, decompressedBytes: 2_000_000}
  const valid = new MCPClient({baseUrl: world.baseUrl, token: validCredential.token, version: "2025-06-18", limits})
  const read = new MCPClient({baseUrl: world.baseUrl, token: readCredential.token, version: "2025-06-18", limits})
  const revoked = new MCPClient({baseUrl: world.baseUrl, token: revokedCredential.token, version: "2025-06-18", limits})
  t.after(() => { valid.close(); read.close(); revoked.close() })
  for (const row of HTTP_DENIAL_CASES) {
    const response = await executeHttpCase(row, {world, valid, read, revoked})
    const expected = Array.isArray(row.expected) ? row.expected : [row.expected]
    assert.ok(expected.includes(response.status), `${row.id}: ${response.status}`)
    if (row.rpc !== undefined && response.status === 200) assert.equal(response.body.error.code, row.rpc, row.id)
    if (row.tool !== undefined) assert.equal(jsonRpcError(response).kind, row.tool, row.id)
    const admitted = await valid.ping()
    assert.equal(admitted.status, 200, `${row.id}: valid request was not admitted after denial`)
    assert.deepEqual(admitted.body.result, {}, row.id)
  }
  assert.deepEqual(valid.handles(), {pending: 0, active_requests: 0, closed: false})
  assert.deepEqual(read.handles(), {pending: 0, active_requests: 0, closed: false})
  assert.deepEqual(revoked.handles(), {pending: 0, active_requests: 0, closed: false})
})

test("compressed, segmented, and incomplete request bodies stay within harness ceilings", {timeout: 120_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "protocol-security-streams", seed: 8675309})
  t.after(() => world.teardown())
  const credential = await world.provisionCredential({scopes: ["read"]})
  const headers = {accept: "application/json, text/event-stream", authorization: `Bearer ${credential.token}`, "content-type": "application/json", "content-encoding": "gzip"}
  const compressed = await fetch(`${world.baseUrl}/mcp`, {method: "POST", headers, body: gzipSync(initialize)})
  assert.ok([400, 415].includes(compressed.status))
  await compressed.body?.cancel()

  let controller
  const incomplete = new ReadableStream({start(value) { controller = value; value.enqueue(new TextEncoder().encode("{")) }})
  const abort = new AbortController()
  const request = fetch(`${world.baseUrl}/mcp`, {method: "POST", headers: {...headers, "content-encoding": "identity"}, body: incomplete, duplex: "half", signal: abort.signal})
  await Promise.resolve()
  abort.abort("deterministic-incomplete-body")
  controller.error(new Error("incomplete body closed by harness"))
  await assert.rejects(request, error => error === "deterministic-incomplete-body" || error.name === "AbortError" || error.name === "TypeError")
  assert.equal((await fetch(`${world.baseUrl}/health`)).status, 200)
})

test("repeated fixed-seed live denials are equivalent, leak-free, unaudited, and replayable", {timeout: 120_000}, async t => {
  const summaries = []
  for (const repetition of ["first", "repeat"]) {
    const root = await mkdtemp(join(tmpdir(), `webby-security-${repetition}-`)); t.after(() => rm(root, {recursive: true, force: true}))
    const world = await WebbyWorld.start({scenarioId: `protocol-security-${repetition}`, seed: 8675309, preserveArtifacts: true})
    t.after(() => world.teardown({remove: true}))
    const recorder = await new ArtifactRecorder({root, scenarioId: "e2e-transport-security", worldId: world.worldId, seed: 8675309, secrets: [world.secret, world.telemetryCapability]}).open()
    const callCredential = await world.provisionCredential({scopes: ["read", "call"]}); recorder.registry.add(callCredential.token)
    const readCredential = await world.provisionCredential({scopes: ["read"]}); recorder.registry.add(readCredential.token)
    const revokedCredential = await world.provisionCredential({scopes: ["read", "call"]}); recorder.registry.add(revokedCredential.token); await world.revokeCredential(revokedCredential.id)
    const limits = {bodyBytes: 2_000_000, decompressedBytes: 2_000_000, transcriptBytes: 5_000_000}
    const valid = new MCPClient({baseUrl: world.baseUrl, token: callCredential.token, version: "2025-06-18", limits})
    const read = new MCPClient({baseUrl: world.baseUrl, token: readCredential.token, version: "2025-06-18", limits})
    const revoked = new MCPClient({baseUrl: world.baseUrl, token: revokedCredential.token, version: "2025-06-18", limits})
    t.after(() => { valid.close(); read.close(); revoked.close() })
    const summary = []
    for (const row of HTTP_DENIAL_CASES) {
      const response = await executeHttpCase(row, {world, valid, read, revoked})
      const observation = {case_id: row.id, status: response.status, error: jsonRpcError(response)?.kind, aborted: response.aborted === true}
      summary.push(observation)
      await recorder.producers.world.event("security.live-observation", observation)
      assert.deepEqual(valid.handles(), {pending: 0, active_requests: 0, closed: false}, row.id)
      const admitted = await valid.ping()
      assert.equal(admitted.status, 200, `${row.id}: request capacity was not reusable`)
      assert.deepEqual(valid.handles(), {pending: 0, active_requests: 0, closed: false}, row.id)
      assert.equal(await auditCount(world), 0, `${row.id}: denial unexpectedly created an invocation audit`)
    }
    valid.close(); read.close(); revoked.close()
    assert.deepEqual(valid.handles(), {pending: 0, active_requests: 0, closed: true})
    const serverText = `${await readFile(world.stdoutPath, "utf8")}\n${await readFile(world.stderrPath, "utf8")}`
    assert.doesNotMatch(serverText, /webby_attacker-secret|foreign-session|foreign-page/)
    await world.teardown({remove: false})
    const artifact = await recorder.finalize({cleanup: {clients: "closed", pending_capacity: 0, audits: 0, world: "closed"}})
    const timeline = await readFile(join(recorder.stagingRoot, "events.ndjson"), "utf8")
    for (const row of HTTP_DENIAL_CASES) assert.match(timeline, new RegExp(row.id.replaceAll(".", "\\.")), row.id)
    assert.equal(artifact.replay.seed, 8675309)
    assert.ok(artifact.attestation.files.some(file => file.path.endsWith("events.ndjson")))
    summaries.push(summary)
  }
  assert.deepEqual(summaries[0], summaries[1])
})

test("live browser socket denies every Origin/identity mismatch and malformed protocol envelope", {timeout: 120_000}, async t => {
  const summaries = []
  for (const repetition of ["first", "repeat"]) {
  const world = await WebbyWorld.start({scenarioId: `protocol-security-websocket-${repetition}`, seed: 8675309})
  t.after(() => world.teardown())
  const root = await mkdtemp(join(tmpdir(), `webby-security-websocket-${repetition}-`)); t.after(() => rm(root, {recursive: true, force: true}))
  const recorder = await new ArtifactRecorder({root, scenarioId: "e2e-transport-security-websocket", worldId: world.worldId, seed: 8675309, secrets: [world.secret]}).open()
  const summary = []
  for (const row of WEBSOCKET_DENIAL_CASES.filter(row => row.phase === "handshake")) {
    const identity = new Ed25519Identity()
    const browser = new SimulatedBrowser({baseUrl: world.baseUrl, identity, timeoutMs: 2_000})
    const foreign = new Ed25519Identity()
    const options = {
      "http-origin": {origin: "https://evil.example"},
      "foreign-extension-origin": {origin: extensionOrigin(foreign)},
      "invalid-extension-id": {extensionId: "not-an-extension-id", origin: "chrome-extension://not-an-extension-id"},
      "query-origin-mismatch": {extensionId: foreign.extensionId, origin: extensionOrigin(identity)},
    }[row.mutate]
    await assert.rejects(browser.connect(options), error => error.code === "websocket_handshake_rejected", row.id)
    await browser.close()
    await recorder.producers.world.event("security.live-observation", {case_id: row.id, repetition, outcome: "handshake_rejected"})
    summary.push({case_id: row.id, outcome: "handshake_rejected"})
    assert.equal(await auditCount(world), 0, row.id)
    assert.equal((await fetch(`${world.baseUrl}/health`)).status, 200, `${row.id}: listener admission did not recover`)
  }
  const identity = new Ed25519Identity()
  const browser = new SimulatedBrowser({baseUrl: world.baseUrl, identity})
  await browser.connect()
  t.after(() => browser.close())
  for (const row of WEBSOCKET_DENIAL_CASES.filter(row => row.phase === "message")) {
    await assert.rejects(browser.wire.push(browser.topic, "message", websocketPayload(row.mutate, identity), {joinRef: browser.joinRef}), error => error.code === "channel_reply_error" && error.response?.kind === row.kind, row.id)
    await recorder.producers.world.event("security.live-observation", {case_id: row.id, repetition, outcome: row.kind})
    summary.push({case_id: row.id, outcome: row.kind})
    assert.equal(browser.wire.pending.size, 0, row.id); assert.equal(await auditCount(world), 0, row.id)
    await assert.rejects(browser.message("heartbeat", {}), error => error.code === "channel_reply_error" && error.response?.kind === "not_ready", `${row.id}: valid envelope was not admitted after denial`)
    assert.equal(browser.wire.pending.size, 0, row.id)
  }
  assert.equal(browser.wire.pending.size, 0)
  for (const row of WEBSOCKET_DENIAL_CASES.filter(row => row.phase === "raw")) {
    const raw = new SimulatedBrowser({baseUrl: world.baseUrl, timeoutMs: 2_000})
    const errors = []; raw.on("protocol_error", error => errors.push(error.code))
    await raw.connect()
    const rawPayload = row.mutate === "raw-invalid-json" ? "{" : row.mutate === "raw-frame-above" ? "x".repeat(row.bytes) : JSON.stringify({not: "a Phoenix tuple"})
    raw.wire.rawText(rawPayload)
    await raw.waitFor("disconnect")
    assert.equal(raw.wire.closed, true, `${row.id}: socket remained open; errors=${errors.join(",")}`)
    assert.equal(raw.wire.pending.size, 0)
    await raw.close()
    await recorder.producers.world.event("security.live-observation", {case_id: row.id, repetition, outcome: "closed"})
    summary.push({case_id: row.id, outcome: "closed"})
    assert.equal(await auditCount(world), 0, row.id)
    assert.equal((await fetch(`${world.baseUrl}/health`)).status, 200, `${row.id}: listener capacity was not reusable`)
  }
  for (const row of WEBSOCKET_DENIAL_CASES.filter(row => row.phase === "raw-boundary")) {
    const raw = new SimulatedBrowser({baseUrl: world.baseUrl, timeoutMs: 5_000}); await raw.connect()
    raw.wire.rawText(rawPhoenixFrameAtBytes(raw, row.bytes))
    await raw.wire.heartbeat()
    assert.equal(raw.wire.closed, false, row.id); await raw.close()
    await recorder.producers.world.event("security.live-observation", {case_id: row.id, repetition, outcome: "open", payload_bytes: row.bytes, raw_frame_bytes: row.raw_frame_bytes})
    summary.push({case_id: row.id, outcome: "open", raw_frame_bytes: row.raw_frame_bytes})
  }
  await browser.close()
  const serverText = `${await readFile(world.stdoutPath, "utf8")}\n${await readFile(world.stderrPath, "utf8")}`
  assert.doesNotMatch(serverText, /attacker_payload_must_not_reflect/)
  const artifact = await recorder.finalize({cleanup: {sockets: "closed", pending_capacity: 0, audits: 0}})
  const timeline = await readFile(join(recorder.stagingRoot, "events.ndjson"), "utf8")
  for (const row of WEBSOCKET_DENIAL_CASES) assert.match(timeline, new RegExp(row.id.replaceAll(".", "\\.")), row.id)
  assert.equal(artifact.replay.seed, 8675309)
  summaries.push(summary)
  }
  assert.deepEqual(summaries[0], summaries[1])
})

test("every generated browser message row executes as one combined live permutation", {timeout: 120_000}, async t => {
  const contract = JSON.parse(await readFile(contractPath, "utf8")); const rows = expandSecurityMatrix(contract).filter(row => row.matrix === "browser-websocket-message")
  const world = await WebbyWorld.start({scenarioId: "security-browser-message-permutations", seed: 8675309}); t.after(() => world.teardown())
  const root = await mkdtemp(join(tmpdir(), "webby-browser-message-permutations-")); t.after(() => rm(root, {recursive: true, force: true}))
  const recorder = await new ArtifactRecorder({root, scenarioId: "security-browser-message-permutations", worldId: world.worldId, seed: world.seed, secrets: [world.secret]}).open()
  const chromium = await ChromiumWorld.launch({world, recorder}); t.after(() => chromium.close())
  const page = await chromium.context.newPage(); const dashboard = await new DashboardDriver({page, recorder}).open(world.baseUrl)
  const fixtures = {}
  for (const [state, name] of [["authenticated-owner", "Matrix owner"], ["authenticated-other", "Matrix peer"]]) {
    const browser = new SimulatedBrowser({baseUrl: world.baseUrl}); await browser.connect(); const pairing = await browser.pair({displayName: name}); await dashboard.refresh()
    const browserId = await dashboard.approvePairing(pairing.pairing_id, name); await browser.authenticate(browserId); await browser.close()
    fixtures[state] = {identity: browser.identity, browserId}
  }
  const executed = new Set()
  for (const row of rows) {
    const fixture = fixtures[row.browser_state]; const candidate = new SimulatedBrowser({baseUrl: world.baseUrl, identity: fixture?.identity, browserId: fixture?.browserId, timeoutMs: 4_000})
    const establish = async () => fixture ? candidate.authenticate(fixture.browserId) : candidate.connect()
    if (row.connection === "late") { await establish(); await candidate.close() }
    await establish()
    let result
    if (row.surface === "frame") {
      const totalBytes = {below: 262_143, at: 262_144, above: 262_145}[row.boundary]
      candidate.wire.rawText(rawPhoenixFrameAtBytes(candidate, totalBytes - 14))
      if (row.boundary === "above") { await candidate.waitFor("disconnect"); result = {outcome: "closed", raw_frame_bytes: totalBytes} }
      else { await candidate.wire.heartbeat(); result = {outcome: "open", raw_frame_bytes: totalBytes} }
    } else {
      const observation = candidate.observation(1)
      const payload = row.surface === "observation"
        ? envelope("discovery.observed", {observations: Array.from({length: {below: 1, at: 128, above: 129}[row.boundary]}, () => observation)}, {browser_id: candidate.browserId})
        : row.surface === "result"
          ? websocketPayload(`result-${row.boundary}`, candidate.identity)
          : websocketPayload(`result-depth-${row.boundary}`, candidate.identity)
      try {
        const reply = await candidate.wire.push(candidate.topic, "message", payload, {joinRef: candidate.joinRef})
        result = {outcome: "accepted", type: reply?.type, received: reply?.payload?.received}
      } catch (error) { result = {outcome: "rejected", code: error.code, kind: error.response?.kind} }
      const above = row.boundary === "above"
      const notReady = row.browser_state === "unpaired" && !above
      assert.equal(result.outcome, above || notReady ? "rejected" : "accepted", `${row.row_id}: ${JSON.stringify(result)}`)
      if (above) assert.equal(result.kind, "invalid_payload", row.row_id)
      if (notReady) assert.equal(result.kind, "not_ready", row.row_id)
    }
    await candidate.close(); executed.add(row.row_id)
    assert.equal(await auditCount(world), 0, row.row_id); assert.equal((await fetch(`${world.baseUrl}/health`)).status, 200, row.row_id)
    await recorder.producers.world.event("security.permutation.executed", {row, result, audit_count: 0, admission_probe: "accepted"})
  }
  assert.deepEqual(executed, new Set(rows.map(row => row.row_id)))
  await chromium.close(); const artifact = await recorder.finalize({cleanup: {executed_rows: executed.size, sockets: "closed", audits: 0}}); assert.equal(artifact.replay.seed, 8675309)
})

test("every generated cross-transport row executes as one combined live permutation", {timeout: 120_000}, async t => {
  const contract = JSON.parse(await readFile(contractPath, "utf8")); const rows = expandSecurityMatrix(contract).filter(row => row.matrix === "cross-transport-call")
  const world = await WebbyWorld.start({scenarioId: "security-cross-transport-permutations", seed: 8675309}); t.after(() => world.teardown())
  const root = await mkdtemp(join(tmpdir(), "webby-cross-transport-permutations-")); t.after(() => rm(root, {recursive: true, force: true}))
  const recorder = await new ArtifactRecorder({root, scenarioId: "security-cross-transport-permutations", worldId: world.worldId, seed: world.seed, secrets: [world.secret]}).open()
  const chromium = await ChromiumWorld.launch({world, recorder}); t.after(() => chromium.close())
  const page = await chromium.context.newPage(); const dashboard = await new DashboardDriver({page, recorder}).open(world.baseUrl)
  const browsers = []
  for (const name of ["Transport owner", "Transport peer"]) {
    const browser = new SimulatedBrowser({baseUrl: world.baseUrl}); await browser.connect(); const pairing = await browser.pair({displayName: name}); await dashboard.refresh()
    const browserId = await dashboard.approvePairing(pairing.pairing_id, name); await browser.authenticate(browserId); browsers.push({browser, browserId})
  }
  t.after(async () => { for (const {browser} of browsers) await browser.close() })
  const observation = browsers[0].browser.observation(88, {origin: "https://matrix.fixture", toolCount: 1})
  await browsers[0].browser.observe([observation]); await dashboard.refresh()
  const discoveryRow = await dashboard.rowByText("discoveries", "discovery", "Fixture 88"); const discoveryId = (await discoveryRow.getAttribute("id")).slice("discovery-".length)
  const registrationId = await dashboard.registerDiscovery(discoveryId, "Fixture 88")
  await browsers[0].browser.observe([observation]); await browsers[1].browser.observe([observation])
  const credentials = {}
  for (const label of ["read", "call", "second-valid-call", "revoked"]) for (const scope of ["read", "call"]) {
    const key = `${label}:${scope}`; credentials[key] = await world.provisionCredential({scopes: scope === "read" ? ["read"] : ["read", "call"]})
    if (label === "revoked") await world.revokeCredential(credentials[key].id)
  }
  for (const credential of Object.values(credentials)) recorder.registry.add(credential.token)
  const clients = Object.fromEntries(Object.entries(credentials).map(([label, credential]) => [label, new MCPClient({baseUrl: world.baseUrl, token: credential.token, version: "2025-06-18", limits: {requestMs: 1_500}})]))
  t.after(() => { for (const client of Object.values(clients)) client.close() })
  const sessionsResponse = await clients["call:call"].call({action: "page.tools", params: {page: registrationId}})
  const sessions = sessionsResponse.body.result.structuredContent.sessions
  const byBrowser = new Map(sessions.map(session => [session.browser_id, session])); assert.ok(byBrowser.get(browsers[0].browserId)); assert.ok(byBrowser.get(browsers[1].browserId))
  const executed = new Set()
  for (const row of rows) {
    const client = clients[`${row.credential}:${row.scope}`]
    let session = row.session === "owner" ? byBrowser.get(browsers[0].browserId) : row.session === "other-browser" ? byBrowser.get(browsers[1].browserId) : undefined
    if (row.session === "late") {
      session = byBrowser.get(browsers[1].browserId)
      await browsers[1].browser.closeSession(observation.tab_id, observation.document_id)
    }
    if (row.session === "missing") session = {id: "missing-session", catalog_revision: 1}
    const revision = row.surface === "catalog" ? session.catalog_revision + {below: -1, at: 0, above: 1}[row.boundary] : session.catalog_revision
    const args = row.surface === "arguments" ? objectAtBytes({below: 65_535, at: 65_536, above: 65_537}[row.boundary]) : {row: row.row_id}
    if (row.connection === "late") assert.equal((await client.ping()).status, row.credential === "revoked" ? 401 : 200)
    const params = {page: registrationId, session: session.id, tool: "tool_0", catalog_revision: revision, arguments: args}
    const before = await auditCount(world); let response; let resultReply
    const canDispatch = row.scope === "call" && row.credential !== "revoked" && !["missing", "late"].includes(row.session) && (row.surface !== "catalog" || row.boundary === "at") && (row.surface !== "arguments" || row.boundary !== "above")
    if (canDispatch) {
      const target = row.session === "other-browser" ? browsers[1].browser : browsers[0].browser
      const invocationPromise = target.waitFor("tool.call"); const pending = client.call({action: "page.call", params}); const invocation = await invocationPromise
      if (row.surface === "result" && row.boundary === "above") {
        await assert.rejects(target.result(invocation.call_id, {padding: "x".repeat(131_073)}), error => error.response?.kind === "invalid_payload")
        client.close(); await assert.rejects(pending); response = {status: "aborted", kind: "invalid_payload"}
      } else {
        const resultValue = row.surface === "result" && row.boundary === "at" ? "x".repeat(131_070) : row.surface === "result" ? {ok: true} : {row: row.row_id}
        resultReply = await target.result(invocation.call_id, resultValue); response = await pending; assert.equal(response.body.result.isError, false, row.row_id)
      }
    } else response = await client.call({action: "page.call", params})
    const kind = response.status === 401 || response.status === 403 || response.status === "aborted" ? response.status : jsonRpcError(response)?.kind ?? "succeeded"
    if (row.credential === "revoked") assert.equal(response.status, 401, row.row_id)
    else if (row.scope === "read") assert.equal(response.status, 403, row.row_id)
    else if (["missing", "late"].includes(row.session)) assert.ok(["not_found", "page_offline"].includes(kind), `${row.row_id}: ${kind}`)
    else if (row.surface === "catalog" && row.boundary !== "at") assert.equal(kind, "stale_catalog", row.row_id)
    else if (row.surface === "arguments" && row.boundary === "above") assert.equal(kind, "invalid_arguments", row.row_id)
    else if (row.surface === "result" && row.boundary === "above") assert.equal(kind, "aborted", row.row_id)
    else assert.equal(kind, "succeeded", row.row_id)
    const after = await auditCount(world); executed.add(row.row_id)
    const admission = await clients["second-valid-call:call"].ping(); assert.equal(admission.status, 200, row.row_id)
    await recorder.producers.world.event("security.permutation.executed", {row, result: {status: response.status, kind, result_reply: resultReply?.type}, audit_before: before, audit_after: after, admission_probe: "accepted"})
    if (row.session === "late") {
      await browsers[1].browser.observe([observation])
      const refreshed = await clients["call:call"].call({action: "page.tools", params: {page: registrationId}})
      for (const active of refreshed.body.result.structuredContent.sessions) byBrowser.set(active.browser_id, active)
    }
  }
  assert.deepEqual(executed, new Set(rows.map(row => row.row_id)))
  for (const client of Object.values(clients)) client.close(); await chromium.close()
  const artifact = await recorder.finalize({cleanup: {executed_rows: executed.size, clients: "closed", browsers: "closed"}}); assert.equal(artifact.replay.seed, 8675309)
})

test("live isolation boundaries deny cross-browser, cross-session, and replayed capabilities", {timeout: 120_000}, async t => {
  const securityContract = JSON.parse(await readFile(contractPath, "utf8")); const generatedRows = expandSecurityMatrix(securityContract)
  const first = await WebbyWorld.start({scenarioId: "protocol-security-isolation-a", seed: 41})
  const second = await WebbyWorld.start({scenarioId: "protocol-security-isolation-b", seed: 42})
  t.after(async () => { await first.teardown(); await second.teardown() })

  const artifactRoot = await mkdtemp(join(tmpdir(), "webby-security-isolation-artifacts-")); t.after(() => rm(artifactRoot, {recursive: true, force: true}))
  const recorder = await new ArtifactRecorder({root: artifactRoot, scenarioId: "protocol-security-isolation", worldId: first.worldId, seed: 41, secrets: [first.secret]}).open()
  const chromium = await ChromiumWorld.launch({world: first, recorder}); t.after(() => chromium.close())
  const page = await chromium.context.newPage(); const dashboard = await new DashboardDriver({page, recorder}).open(first.baseUrl)
  const browser = new SimulatedBrowser({baseUrl: first.baseUrl})
  await browser.connect(); const pairing = await browser.pair({displayName: "Isolation victim"}); await dashboard.refresh()
  const browserId = await dashboard.approvePairing(pairing.pairing_id, "Isolation victim"); await browser.authenticate(browserId)
  t.after(() => browser.close())
  const otherBrowser = new SimulatedBrowser({baseUrl: first.baseUrl})
  await otherBrowser.connect(); const otherPairing = await otherBrowser.pair({displayName: "Isolation peer"}); await dashboard.refresh()
  const otherBrowserId = await dashboard.approvePairing(otherPairing.pairing_id, "Isolation peer"); await otherBrowser.authenticate(otherBrowserId)
  t.after(() => otherBrowser.close())

  const handshakeExecuted = new Set()
  for (const row of generatedRows.filter(item => item.matrix === "browser-websocket-handshake")) {
    const identity = row.browser_claim === "owner-id" ? browser.identity : row.browser_claim === "other-id" ? otherBrowser.identity : new Ed25519Identity()
    const claimedId = row.browser_claim === "owner-id" ? browserId : row.browser_claim === "other-id" ? otherBrowserId : undefined
    const connectOptions = row.origin === "valid-extension" ? {browserId: claimedId} : row.origin === "foreign-extension" ? {browserId: claimedId, origin: extensionOrigin(new Ed25519Identity())} : {browserId: claimedId, origin: "https://evil.example"}
    const attempt = async () => {
      const candidate = new SimulatedBrowser({baseUrl: first.baseUrl, identity, browserId: claimedId, timeoutMs: 3_000})
      try { const response = await candidate.connect(connectOptions); await candidate.close(); return {outcome: "accepted", response_type: response?.type ?? "joined"} }
      catch (error) { await candidate.close(); return {outcome: "rejected", code: error.code, kind: error.response?.kind} }
    }
    if (row.connection === "late") await attempt()
    const result = await attempt(); const shouldAccept = row.origin === "valid-extension"
    assert.equal(result.outcome, shouldAccept ? "accepted" : "rejected", row.row_id)
    handshakeExecuted.add(row.row_id); await recorder.producers.world.event("security.permutation.executed", {row, result, audit_count: await auditCount(first)})
  }
  assert.deepEqual(handshakeExecuted, new Set(generatedRows.filter(item => item.matrix === "browser-websocket-handshake").map(row => row.row_id)))
  await browser.authenticate(browserId); await otherBrowser.authenticate(otherBrowserId)

  for (const repetition of ["first", "repeat"]) {
    const attacker = new SimulatedBrowser({baseUrl: first.baseUrl})
    await assert.rejects(attacker.connect({browserId}), error => error.code === "channel_reply_error", repetition)
    await attacker.close()
    assert.equal(await auditCount(first), 0, repetition)
    assert.equal((await browser.message("heartbeat", {})).payload.received, "heartbeat")
    await recorder.producers.world.event("security.live-observation", {case_id: "isolation.cross-browser-identity", repetition, outcome: "rejected", admission_probe: "accepted", audit_count: 0})
  }

  const lateConnection = new SimulatedBrowser({baseUrl: first.baseUrl, identity: browser.identity, browserId})
  await lateConnection.authenticate(browserId)
  assert.equal(lateConnection.browserId, browserId)
  await lateConnection.close()
  await browser.authenticate(browserId)
  const observation = browser.observation(77, {origin: "https://security.fixture", toolCount: 1})
  await browser.observe([observation]); await dashboard.refresh()
  const discoveryRow = await dashboard.rowByText("discoveries", "discovery", "Fixture 77")
  const discoveryId = (await discoveryRow.getAttribute("id")).slice("discovery-".length)
  const registrationId = await dashboard.registerDiscovery(discoveryId, "Fixture 77")
  await browser.observe([observation])

  for (const repetition of ["first", "repeat"]) {
    await assert.rejects(second.telemetry(first.telemetryCapability), /invalid telemetry capability/, repetition)
    assert.equal((await fetch(`${second.baseUrl}/health`)).status, 200)
    await recorder.producers.world.event("security.live-observation", {case_id: "isolation.capability-replay", repetition, outcome: "rejected", admission_probe: "accepted", audit_count: await auditCount(first)})
  }
  const credential = await first.provisionCredential({scopes: ["read", "call"]})
  const secondCredential = await first.provisionCredential({scopes: ["read", "call"]})
  const caller = new MCPClient({baseUrl: first.baseUrl, token: credential.token, version: "2025-06-18"})
  const secondCaller = new MCPClient({baseUrl: first.baseUrl, token: secondCredential.token, version: "2025-06-18"})
  t.after(() => { caller.close(); secondCaller.close() })
  for (const repetition of ["first", "repeat"]) {
    const crossSession = await caller.call({action: "page.call", params: {page: "foreign-page", session: "foreign-session", tool: "tool", catalog_revision: 1, arguments: {}}})
    assert.equal(crossSession.status, 200, repetition)
    assert.equal(crossSession.body.result.structuredContent.kind, "not_found", repetition)
    assert.equal((await caller.ping()).status, 200)
    await recorder.producers.world.event("security.live-observation", {case_id: "isolation.cross-session-call", repetition, outcome: "not_found", admission_probe: "accepted", audit_count: await auditCount(first)})
  }
  const toolsResponse = await caller.call({action: "page.tools", params: {page: registrationId}})
  const ownedSession = toolsResponse.body.result.structuredContent.sessions[0]
  assert.ok(ownedSession)
  const globallyVisible = await secondCaller.call({action: "page.tools", params: {page: registrationId}})
  assert.equal(globallyVisible.body.result.structuredContent.sessions[0].id, ownedSession.id)
  await recorder.producers.world.event("security.reviewed-exclusion-observed", {case_id: "global-credential-no-principal-ownership", first_credential: credential.id, second_credential: secondCredential.id, session_id: ownedSession.id, outcome: "globally_visible_by_design"})
  for (const [label, revision] of [["below", ownedSession.catalog_revision - 1], ["above", ownedSession.catalog_revision + 1]]) {
    const stale = await caller.call({action: "page.call", params: {page: registrationId, session: ownedSession.id, tool: "tool_0", catalog_revision: revision, arguments: {}}})
    assert.equal(jsonRpcError(stale).kind, "stale_catalog", label)
    await recorder.producers.world.event("security.live-observation", {case_id: `isolation.catalog.${label}`, outcome: "stale_catalog", audit_count: await auditCount(first)})
  }
  const toolCall = browser.waitFor("tool.call")
  const current = caller.call({action: "page.call", params: {page: registrationId, session: ownedSession.id, tool: "tool_0", catalog_revision: ownedSession.catalog_revision, arguments: {boundary: "at"}}})
  const call = await toolCall; await browser.result(call.call_id, {ok: true})
  assert.equal((await current).body.result.isError, false)
  await recorder.producers.world.event("security.live-observation", {case_id: "isolation.catalog.at", outcome: "succeeded", audit_count: await auditCount(first)})
  for (const [label, bytes] of [["below", 65_535], ["at", 65_536]]) {
    const nextCall = browser.waitFor("tool.call")
    const pending = caller.call({action: "page.call", params: {page: registrationId, session: ownedSession.id, tool: "tool_0", catalog_revision: ownedSession.catalog_revision, arguments: objectAtBytes(bytes)}})
    const invocation = await nextCall; await browser.result(invocation.call_id, {boundary: label})
    assert.equal((await pending).body.result.isError, false, label)
    await recorder.producers.world.event("security.live-observation", {case_id: `isolation.arguments.${label}`, outcome: "succeeded", audit_count: await auditCount(first)})
  }
  const oversizedArguments = await caller.call({action: "page.call", params: {page: registrationId, session: ownedSession.id, tool: "tool_0", catalog_revision: ownedSession.catalog_revision, arguments: objectAtBytes(65_537)}})
  assert.equal(jsonRpcError(oversizedArguments).kind, "invalid_arguments")
  await recorder.producers.world.event("security.live-observation", {case_id: "isolation.arguments.above", outcome: "invalid_arguments", audit_count: await auditCount(first)})
  await first.revokeCredential(credential.id)
  assert.equal((await caller.ping()).status, 401)
  assert.equal((await secondCaller.ping()).status, 200)
  await recorder.producers.world.event("security.live-observation", {case_id: "isolation.cross-credential-revoked", outcome: "rejected", admission_probe: "accepted", audit_count: await auditCount(first)})
  assert.deepEqual(caller.handles(), {pending: 0, active_requests: 0, closed: false})
  caller.close(); secondCaller.close()
  assert.deepEqual(secondCaller.handles(), {pending: 0, active_requests: 0, closed: true})
  await chromium.close()
  const artifact = await recorder.finalize({cleanup: {victim: "closed", attacker: "closed", late_connection: "closed", chromium: "closed"}})
  assert.equal(artifact.replay.seed, 41)
})

test("cross-world and cross-contract logical handle replay fails closed", async t => {
  const contract = JSON.parse(await readFile(contractPath, "utf8"))
  const firstWorld = {worldId: "world-a", instanceNonce: "nonce-a"}
  const source = new LogicalHandles({world: firstWorld, contract})
  const handle = source.bind("credential", "credential", "credential-a")
  const root = await mkdtemp(join(tmpdir(), "webby-security-handles-")); t.after(() => rm(root, {recursive: true, force: true}))
  const recorder = await new ArtifactRecorder({root, scenarioId: "security-handle-replay", worldId: firstWorld.worldId, seed: 8675309}).open()
  for (const repetition of ["first", "repeat"]) {
    const otherWorld = new LogicalHandles({world: {worldId: `world-b-${repetition}`, instanceNonce: `nonce-b-${repetition}`}, contract})
    let worldError; try { otherWorld.import("credential", handle) } catch (error) { worldError = error }
    assert.equal(worldError?.code, "stale_handle")
    await recorder.producers.world.event("security.live-observation", {case_id: "isolation.cross-world-handle", repetition, outcome: worldError.code, handle_count: otherWorld.values.size, audit_count: 0})
    const otherContract = new LogicalHandles({world: firstWorld, contract: {...contract, id: `e2e-other-contract-${repetition}`}})
    let contractError; try { otherContract.import("credential", handle) } catch (error) { contractError = error }
    assert.equal(contractError?.code, "stale_handle")
    await recorder.producers.world.event("security.live-observation", {case_id: "isolation.cross-contract-handle", repetition, outcome: contractError.code, handle_count: otherContract.values.size, audit_count: 0})
  }
  const artifact = await recorder.finalize({cleanup: {handles: "released", pending_capacity: 0, audits: 0}})
  assert.equal(artifact.replay.seed, 8675309)
  await emitLiveTestReceipt({scenarioId: "e2e-transport-security", adapter: "protocol", receiptId: "transport-security-live", assertions: {cross_world_replays_rejected: 2, cross_contract_replays_rejected: 2, cleanup_audits: 0}})
})
