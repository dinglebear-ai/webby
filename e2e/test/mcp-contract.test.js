import assert from "node:assert/strict"
import {createServer} from "node:http"
import test from "node:test"
import {readFile} from "node:fs/promises"
import {MCPClient, MCPClientError, actionCases, createRequestGate, jsonRpcError, waitForHealth} from "../support/mcp-client.js"
import {WebbyWorld} from "../support/world.js"
import {discover, repoRoot} from "../support/validate-contracts.js"

async function withServer(handler, operation) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  try { return await operation(`http://127.0.0.1:${server.address().port}`) }
  finally { await new Promise(resolve => server.close(resolve)) }
}

test("compatibility inventory pins every production version, method, and broker action", async () => {
  const contract = await MCPClient.versions()
  const surfaces = JSON.parse(await readFile(new URL("../contracts/surfaces.json", import.meta.url), "utf8")).surfaces
  const discovered = category => surfaces.filter(surface => surface.category === category).map(surface => surface.symbol).sort()
  const protocolSource = await readFile(`${repoRoot}/lib/webby/mcp/protocol.ex`, "utf8")
  const brokerSource = await readFile(`${repoRoot}/lib/webby/mcp/broker.ex`, "utf8")
  assert.equal(contract.latest, "2026-07-28")
  assert.deepEqual(contract.supported, ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"])
  assert.deepEqual(contract.methods, ["initialize", "notifications/initialized", "ping", "tools/list", "tools/call", "notifications/cancelled"])
  assert.deepEqual(contract.broker_actions, ["status", "browser.list", "discovery.list", "discovery.get", "page.list", "page.get", "page.tools", "page.call"])
  assert.deepEqual([...contract.supported].sort(), discovered("mcp_version"))
  assert.deepEqual([...contract.methods].sort(), discovered("mcp_method"))
  assert.deepEqual([...contract.broker_actions].sort(), discovered("mcp_action"))
  assert.deepEqual([...contract.supported].sort(), discover("mcp-versions", protocolSource))
  assert.deepEqual([...contract.methods].sort(), discover("mcp-methods", protocolSource))
  assert.deepEqual([...contract.broker_actions].sort(), discover("mcp-actions", brokerSource))
})

test("live health and MCP method boundary use real Bandit TCP", {timeout: 60_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "mcp-contract-live"})
  t.after(() => world.teardown())
  const client = new MCPClient({baseUrl: world.baseUrl})
  t.after(() => client.close())
  const health = await client.health()
  assert.equal(health.status, 200)
  assert.equal(health.body.status, "ok")
  assert.equal(health.body.runtime.capabilities.health.instance_nonce, world.instanceNonce)
  const get = await client.raw("/mcp", {method: "GET", authenticate: false})
  assert.equal(get.status, 405)
  assert.equal(get.text, "")
  const missing = await client.initialize("2025-06-18")
  assert.equal(missing.status, 401)
  assert.equal(missing.body.error.message, "invalid_credential")
  assert.equal(missing.headers["www-authenticate"], "Bearer")
})

test("live MCP negotiates every version and exercises every broker action and scope", {timeout: 60_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "mcp-live-actions"})
  t.after(() => world.teardown())
  const read = await world.provisionCredential({scopes: ["read"]})
  const call = await world.provisionCredential({scopes: ["read", "call"]})
  for (const version of (await MCPClient.versions()).supported) {
    const client = new MCPClient({baseUrl: world.baseUrl, token: read.token, version})
    const initialized = await client.initialize(version)
    assert.equal(initialized.status, 200)
    assert.equal(initialized.body.result.protocolVersion, version)
    assert.equal((await client.notify("notifications/initialized")).status, 202)
    assert.deepEqual((await client.ping()).body.result, {})
    const listed = await client.listTools()
    const [tool] = listed.body.result.tools
    assert.equal(tool.name, "webby")
    const cases = actionCases(tool)
    assert.deepEqual(cases.map(item => item.action), (await MCPClient.versions()).broker_actions)
    for (const item of cases.filter(item => item.action !== "page.call")) {
      const response = await client.call(item.positive)
      assert.equal(response.status, 200, item.action)
      assert.equal(typeof response.body.result.isError, "boolean", item.action)
      if (item.business_success_expected) assert.equal(response.body.result.isError, false, item.action)
      else assert.equal(jsonRpcError(response).kind, "not_found", `${item.action} valid business miss`)
      const negative = await client.call(item.negative)
      assert.equal(negative.status, 200, `${item.action} negative`)
      assert.deepEqual(jsonRpcError(negative), {layer: "tool", kind: "invalid_arguments"}, `${item.action} schema negative`)
    }
    assert.equal((await client.call(cases.find(item => item.action === "page.call").positive)).status, 403)
    client.close()
  }
  const caller = new MCPClient({baseUrl: world.baseUrl, token: call.token, version: "2025-06-18"})
  const pageCall = await caller.call({action: "page.call", params: {page: "missing", tool: "missing", catalog_revision: 1}})
  assert.equal(pageCall.status, 200)
  assert.equal(pageCall.body.result.structuredContent.kind, "not_found")
  assert.equal((await caller.cancel("shared-id")).status, 202)
  assert.equal((await caller.request("does/not-exist")).body.error.code, -32601)
  assert.equal((await caller.send({garbage: true})).body.error.code, -32600)
  await world.revokeCredential(call.id)
  assert.equal((await caller.ping()).status, 401)
  caller.close()
})

test("two live clients sharing a credential and JSON-RPC ID isolate responses and cancellation", {timeout: 60_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "mcp-shared-id"})
  t.after(() => world.teardown())
  const credential = await world.provisionCredential({scopes: ["read", "call"]})
  const gate = createRequestGate()
  const first = new MCPClient({baseUrl: world.baseUrl, token: credential.token, version: "2025-06-18", fetchImpl: gate.fetch})
  const second = new MCPClient({baseUrl: world.baseUrl, token: credential.token, version: "2025-06-18"})
  t.after(() => { first.close(); second.close() })
  const pendingPing = first.request("ping", {}, {id: "shared"})
  await gate.entered
  const tools = await second.request("tools/list", {}, {id: "shared"})
  assert.equal((await second.cancel("shared")).status, 202)
  gate.release()
  const ping = await pendingPing
  assert.equal(ping.body.id, "shared")
  assert.deepEqual(ping.body.result, {})
  assert.equal(tools.body.id, "shared")
  assert.equal(tools.body.result.tools[0].name, "webby")
  assert.deepEqual((await second.request("ping", {}, {id: "shared"})).body.result, {})
  assert.deepEqual(first.handles(), {pending: 0, active_requests: 0, closed: false})
  assert.deepEqual(second.handles(), {pending: 0, active_requests: 0, closed: false})
})

test("revocation while a real request is deterministically gated is terminal and closes handles", {timeout: 60_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "mcp-revoke-inflight"})
  t.after(() => world.teardown())
  const credential = await world.provisionCredential()
  const gate = createRequestGate()
  const client = new MCPClient({baseUrl: world.baseUrl, token: credential.token, version: "2025-06-18", fetchImpl: gate.fetch})
  const request = client.request("ping", {}, {id: "revoked-inflight"})
  await gate.entered
  assert.equal(client.handles().active_requests, 1)
  await world.revokeCredential(credential.id)
  gate.release()
  assert.equal((await request).status, 401)
  assert.equal((await client.ping()).status, 401)
  assert.deepEqual(client.handles(), {pending: 0, active_requests: 0, closed: false})
  client.close()
  assert.deepEqual(client.handles(), {pending: 0, active_requests: 0, closed: true})
})

test("live MCP transport rejects invalid headers, origins, credentials, versions, parsers, and sizes", {timeout: 60_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "mcp-live-rejections"})
  t.after(() => world.teardown())
  const credential = await world.provisionCredential()
  const client = new MCPClient({baseUrl: world.baseUrl, token: credential.token, version: "2025-06-18", limits: {bodyBytes: 2_000_000, decompressedBytes: 2_000_000}})
  t.after(() => client.close())
  const initialize = JSON.stringify({jsonrpc: "2.0", id: 1, method: "initialize", params: {protocolVersion: "2025-06-18", capabilities: {}}})
  assert.equal((await client.raw("/mcp", {method: "POST", body: initialize, headers: {accept: "application/json"}})).status, 406)
  assert.equal((await client.raw("/mcp", {method: "POST", body: initialize, headers: {"content-type": "text/plain"}})).status, 400)
  assert.equal((await client.raw("/mcp", {method: "POST", body: initialize, headers: {"content-type": ""}})).status, 400)
  assert.equal((await client.raw("/mcp", {method: "POST", body: initialize, origin: "https://evil.example"})).status, 403)
  assert.equal((await client.raw("/mcp", {method: "POST", body: initialize, token: "wrong"})).status, 401)
  assert.equal((await client.raw("/mcp", {method: "POST", body: "{", headers: {"content-type": "application/json"}})).status, 400)
  for (const malformed of ["null", "[]", JSON.stringify({jsonrpc: "1.0", id: 1, method: "ping"}), JSON.stringify({jsonrpc: "2.0", id: 1})]) {
    const response = await client.raw("/mcp", {method: "POST", body: malformed})
    assert.ok([200, 400].includes(response.status))
    if (response.status === 200) assert.equal(response.body.error.code, -32600)
  }
  const request = JSON.stringify({jsonrpc: "2.0", id: 2, method: "ping", params: {}})
  assert.equal((await client.raw("/mcp", {method: "POST", body: request, headers: {"mcp-protocol-version": ""}})).status, 400)
  assert.equal((await client.raw("/mcp", {method: "POST", body: request, headers: {"mcp-protocol-version": "unsupported"}})).status, 400)
  const latestWithoutMetadata = new MCPClient({baseUrl: world.baseUrl, token: credential.token, version: "2026-07-28"})
  assert.equal((await latestWithoutMetadata.raw("/mcp", {method: "POST", body: request, headers: {"mcp-protocol-version": "2026-07-28", "mcp-method": "ping"}})).status, 400)
  latestWithoutMetadata.close()
  const conflict = JSON.stringify({jsonrpc: "2.0", id: 3, method: "ping", params: {_meta: {"io.modelcontextprotocol/protocolVersion": "2025-06-18", "io.modelcontextprotocol/clientInfo": {}, "io.modelcontextprotocol/clientCapabilities": {}}}})
  assert.equal((await client.raw("/mcp", {method: "POST", body: conflict, headers: {"mcp-protocol-version": "2026-07-28", "mcp-method": "ping"}})).status, 400)
  const unsupportedInitialize = JSON.stringify({jsonrpc: "2.0", id: 4, method: "initialize", params: {protocolVersion: "1900-01-01", capabilities: {}}})
  const negotiated = await client.raw("/mcp", {method: "POST", body: unsupportedInitialize})
  assert.equal(negotiated.body.result.protocolVersion, "2026-07-28")
  const requestPrefix = JSON.stringify({jsonrpc: "2.0", id: 5, method: "ping", params: {padding: ""}})
  const marker = '"}}'
  const maxBody = requestPrefix.replace(marker, `${"x".repeat(1_048_576 - Buffer.byteLength(requestPrefix))}${marker}`)
  assert.equal(Buffer.byteLength(maxBody), 1_048_576)
  const versionHeader = {"mcp-protocol-version": "2025-06-18"}
  assert.equal((await client.raw("/mcp", {method: "POST", body: maxBody, headers: versionHeader})).status, 200)
  assert.equal((await client.raw("/mcp", {method: "POST", body: `${maxBody} `, headers: versionHeader})).status, 413)
})

test("isolated dependency fault drives live health to 503 and recovers", {timeout: 60_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "health-degraded"})
  t.after(() => world.teardown())
  const client = new MCPClient({baseUrl: world.baseUrl})
  t.after(() => client.close())
  await world.setHealthDegraded(true)
  const degraded = await waitForHealth(client, 503)
  assert.equal(degraded.body.status, "error")
  assert.equal(degraded.body.database.kind, "database_unavailable")
  await world.setHealthDegraded(false)
  assert.equal((await waitForHealth(client, 200)).body.status, "ok")
})

test("latest-version requests mirror method, name, and stateless metadata", async () => {
  const captured = []
  await withServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk
    captured.push({headers: request.headers, body: JSON.parse(body)})
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({jsonrpc: "2.0", id: captured.length, result: {}}))
  }, async baseUrl => {
    const client = new MCPClient({baseUrl, token: "webby_secret", version: "2026-07-28"})
    await client.listTools()
    await client.call({action: "status"})
    client.close()
  })
  assert.equal(captured[0].headers["mcp-method"], "tools/list")
  assert.equal(captured[1].headers["mcp-method"], "tools/call")
  assert.equal(captured[1].headers["mcp-name"], "webby")
  for (const request of captured) {
    assert.equal(request.headers.connection, "close")
    assert.equal(request.headers.authorization, "Bearer webby_secret")
    assert.equal(request.headers["mcp-protocol-version"], "2026-07-28")
    assert.equal(request.body.params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28")
  }
})

test("advertised schemas mechanically generate positive and negative action cases", () => {
  const actions = ["status", "browser.list", "discovery.list", "discovery.get", "page.list", "page.get", "page.tools", "page.call"]
  const oneOf = actions.map(action => ({properties: {action: {const: action}, params: {required: action === "page.call" ? ["page", "tool", "catalog_revision"] : action.endsWith(".get") || action === "page.tools" ? [action === "discovery.get" ? "id" : "page"] : []}}}))
  const cases = actionCases({inputSchema: {oneOf}})
  assert.deepEqual(cases.map(item => item.action), actions)
  assert.deepEqual(cases.at(-1).positive, {action: "page.call", params: {page: "missing", tool: "missing", catalog_revision: 1}})
  assert.deepEqual(cases[0].negative, {action: "status.invalid"})
})

test("client bounds bodies, JSON depth, pending IDs, rates, lifetime, transcripts, and closes handles", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({nested: {again: {too: "deep"}}}))
  }, async baseUrl => {
    const client = new MCPClient({baseUrl, limits: {jsonDepth: 2}})
    await assert.rejects(client.health(), error => error.code === "json_depth")
    client.close()
    assert.equal(client.closed, true)
    assert.equal(client.pending.size, 0)
    await assert.rejects(client.health(), error => error.code === "client_closed")
  })
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({padding: "x".repeat(256)}))
  }, async baseUrl => {
    const client = new MCPClient({baseUrl, limits: {bodyBytes: 64, decompressedBytes: 64}})
    await assert.rejects(client.health(), error => error.code === "body_too_large")
    client.close()
  })
  const outgoing = new MCPClient({baseUrl: "http://127.0.0.1:1", limits: {bodyBytes: 32, jsonDepth: 2}})
  await assert.rejects(outgoing.raw("/mcp", {method: "POST", body: JSON.stringify({padding: "x".repeat(64)})}), error => error.code === "request_too_large")
  await assert.rejects(outgoing.raw("/mcp", {method: "POST", body: JSON.stringify({a: {b: {c: true}}})}), error => error.code === "json_depth")
  outgoing.close()
  const never = () => new Promise(() => {})
  const pending = new MCPClient({baseUrl: "http://127.0.0.1:1", fetchImpl: never, limits: {pendingRequests: 1}})
  void pending.request("ping", {}, {id: 7})
  await assert.rejects(pending.request("ping", {}, {id: 8}), error => error.code === "pending_limit")
  pending.close()
  const rate = new MCPClient({baseUrl: "http://127.0.0.1:1", fetchImpl: never, limits: {notificationRate: 1}})
  void rate.notify("notifications/initialized")
  assert.throws(() => rate.notify("notifications/initialized"), error => error.code === "notification_rate")
  rate.close()
  const transcript = new MCPClient({baseUrl: "http://127.0.0.1:1", recorder: {record: async () => {}}, limits: {transcriptBytes: 4}})
  await assert.rejects(transcript.health(), error => error.code === "transcript_limit")
  transcript.close()
  const expired = new MCPClient({baseUrl: "http://127.0.0.1:1", limits: {lifetimeMs: -1}})
  await assert.rejects(expired.ping(), error => error.code === "lifetime_exceeded")
  const abortingFetch = (_url, {signal}) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new DOMException("closed", "AbortError"))
    else signal.addEventListener("abort", () => reject(new DOMException("closed", "AbortError")), {once: true})
  })
  const shutdown = new MCPClient({baseUrl: "http://127.0.0.1:1", fetchImpl: abortingFetch})
  const active = shutdown.ping()
  assert.equal(shutdown.handles().active_requests, 1)
  shutdown.close()
  await assert.rejects(active, error => error.code === "aborted")
  assert.deepEqual(shutdown.handles(), {pending: 0, active_requests: 0, closed: true})
})

test("transcripts redact authorization and token-shaped structured fields", async () => {
  const events = []
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({jsonrpc: "2.0", id: 1, result: {token: "server-secret"}}))
  }, async baseUrl => {
    const client = new MCPClient({baseUrl, token: "webby_client-secret", recorder: {record: async (type, data) => events.push({type, data})}})
    await client.initialize("2025-06-18")
    client.close()
  })
  const text = JSON.stringify(events)
  assert.doesNotMatch(text, /client-secret|server-secret/)
  assert.match(text, /\[REDACTED\]/)
})

test("loopback and abort protections fail closed", async () => {
  assert.throws(() => new MCPClient({baseUrl: "https://example.com"}), /loopback/)
  await withServer(() => {}, async baseUrl => {
    const client = new MCPClient({baseUrl, limits: {requestMs: 20}})
    await assert.rejects(client.health(), error => error instanceof MCPClientError && error.code === "aborted")
    client.close()
  })
})
