import {readFile} from "node:fs/promises"

const DEFAULT_LIMITS = Object.freeze({
  bodyBytes: 1_048_576,
  decompressedBytes: 1_048_576,
  jsonDepth: 64,
  pendingRequests: 32,
  notificationRate: 128,
  lifetimeMs: 30_000,
  requestMs: 5_000,
  transcriptBytes: 1_048_576,
})

export class MCPClientError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = "MCPClientError"
    this.code = code
    this.details = details
  }
}

function byteLength(value) { return Buffer.byteLength(value) }

function jsonDepth(value, depth = 0) {
  if (value === null || typeof value !== "object") return depth
  return Object.values(value).reduce((maximum, child) => Math.max(maximum, jsonDepth(child, depth + 1)), depth)
}

function redactHeaders(headers) {
  return Object.fromEntries([...headers.entries()].map(([key, value]) =>
    [key, key.toLowerCase() === "authorization" ? "[REDACTED]" : value]))
}

function redactBody(value) {
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(redactBody)
  return Object.fromEntries(Object.entries(value).map(([key, child]) =>
    /token|authorization|cookie|signature|session/i.test(key) ? [key, "[REDACTED]"] : [key, redactBody(child)]))
}

async function boundedBody(response, limits) {
  const advertised = Number(response.headers.get("content-length"))
  if (Number.isFinite(advertised) && advertised > limits.bodyBytes) {
    await response.body?.cancel()
    throw new MCPClientError("body_too_large", "response content-length exceeds client limit")
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limits.decompressedBytes) throw new MCPClientError("body_too_large", "response body exceeds client limit")
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), bytes).toString("utf8")
}

export class MCPClient {
  constructor({baseUrl, token, version, recorder, fetchImpl = fetch, limits = {}, clientInfo = {name: "webby-e2e", version: "1"}}) {
    if (!baseUrl) throw new Error("baseUrl is required")
    this.baseUrl = new URL(baseUrl)
    if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(this.baseUrl.hostname)) throw new Error("MCP client only permits loopback")
    this.token = token
    this.version = version
    this.recorder = recorder
    this.fetchImpl = fetchImpl
    this.clientInfo = clientInfo
    this.limits = {...DEFAULT_LIMITS, ...limits}
    this.pending = new Map()
    this.activeRequests = new Map()
    this.notifications = []
    this.transcriptBytes = 0
    this.closed = false
    this.startedAt = Date.now()
    this.nextId = 1
    this.controller = new AbortController()
  }

  static async versions(path = new URL("../contracts/mcp-versions.json", import.meta.url)) {
    return JSON.parse(await readFile(path, "utf8"))
  }

  assertUsable() {
    if (this.closed) throw new MCPClientError("client_closed", "MCP client is closed")
    if (Date.now() - this.startedAt > this.limits.lifetimeMs) {
      this.close("lifetime_exceeded")
      throw new MCPClientError("lifetime_exceeded", "MCP client lifetime exceeded")
    }
  }

  metadata(version = this.version) {
    return {
      "io.modelcontextprotocol/protocolVersion": version,
      "io.modelcontextprotocol/clientInfo": this.clientInfo,
      "io.modelcontextprotocol/clientCapabilities": {},
    }
  }

  request(method, params = {}, options = {}) {
    return this.send({jsonrpc: "2.0", id: options.id ?? this.nextId++, method, params}, options)
  }

  notify(method, params = {}, options = {}) {
    const now = Date.now()
    this.notifications = this.notifications.filter(at => now - at < 1_000)
    if (this.notifications.length >= this.limits.notificationRate) throw new MCPClientError("notification_rate", "notification rate exceeded")
    this.notifications.push(now)
    return this.send({jsonrpc: "2.0", method, params}, options)
  }

  initialize(version = this.version, options = {}) {
    return this.request("initialize", {protocolVersion: version, capabilities: {}, clientInfo: this.clientInfo}, options)
  }

  ping(options) { return this.request("ping", {}, options) }
  listTools(options) { return this.request("tools/list", {}, options) }
  call(arguments_, options = {}) { return this.request("tools/call", {name: "webby", arguments: arguments_}, options) }
  cancel(requestId, options = {}) { return this.notify("notifications/cancelled", {requestId}, options) }

  async health({signal, timeoutMs = this.limits.requestMs} = {}) {
    return this.raw("/health", {method: "GET", signal, timeoutMs, authenticate: false})
  }

  async send(message, options = {}) {
    this.assertUsable()
    if (message.id !== undefined) {
      if (this.pending.size >= this.limits.pendingRequests) throw new MCPClientError("pending_limit", "pending request limit exceeded")
      if (this.pending.has(message.id)) throw new MCPClientError("duplicate_id", `request ID ${message.id} is already pending`)
      this.pending.set(message.id, true)
    }
    try {
      const headers = {...options.headers}
      if (this.version && message.method !== "initialize") headers["mcp-protocol-version"] = this.version
      if (this.version === "2026-07-28" && message.method !== "initialize") {
        message = {...message, params: {...message.params, _meta: {...message.params?._meta, ...this.metadata()}}}
        headers["mcp-method"] = message.method
        if (message.method === "tools/call") headers["mcp-name"] = message.params.name
      }
      return await this.raw("/mcp", {method: "POST", body: JSON.stringify(message), headers, requestKey: message.id, ...options})
    } finally {
      if (message.id !== undefined) this.pending.delete(message.id)
    }
  }

  async raw(path, {method = "GET", body, headers = {}, token = this.token, origin, authenticate = true, signal, timeoutMs = this.limits.requestMs, requestKey = Symbol("request")} = {}) {
    this.assertUsable()
    if (body !== undefined && byteLength(body) > this.limits.bodyBytes) throw new MCPClientError("request_too_large", "request body exceeds client limit")
    if (body !== undefined) {
      const parsed = safeJson(body)
      if (parsed !== "[INVALID JSON]" && jsonDepth(parsed) > this.limits.jsonDepth) throw new MCPClientError("json_depth", "request JSON exceeds client depth limit")
    }
    const requestHeaders = new Headers(headers)
    if (path === "/mcp") {
      if (!requestHeaders.has("accept")) requestHeaders.set("accept", "application/json, text/event-stream")
      if (body !== undefined && !requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json")
    }
    if (authenticate && token) requestHeaders.set("authorization", `Bearer ${token}`)
    if (origin !== undefined) requestHeaders.set("origin", origin)
    const timeout = AbortSignal.timeout(timeoutMs)
    const requestController = new AbortController()
    const combinedSignals = [timeout, this.controller.signal, requestController.signal]
    if (signal) combinedSignals.push(signal)
    const combined = AbortSignal.any(combinedSignals)
    this.activeRequests.set(requestKey, requestController)
    try {
      await this.record("mcp.request", {method, path, headers: redactHeaders(requestHeaders), body: redactBody(body && safeJson(body))})
      let response
      try { response = await this.fetchImpl(new URL(path, this.baseUrl), {method, headers: requestHeaders, body, signal: combined, redirect: "error"}) }
      catch (error) { throw new MCPClientError(error.name === "AbortError" || error.name === "TimeoutError" ? "aborted" : "transport", error.message) }
      const text = await boundedBody(response, this.limits)
      let json
      if (text && response.headers.get("content-type")?.includes("json")) {
        try { json = JSON.parse(text) } catch { throw new MCPClientError("invalid_json", "response was not valid JSON", {status: response.status}) }
        if (jsonDepth(json) > this.limits.jsonDepth) throw new MCPClientError("json_depth", "response JSON exceeds client depth limit")
      }
      const result = {status: response.status, headers: Object.fromEntries(response.headers), body: json, text}
      await this.record("mcp.response", {status: result.status, body: redactBody(result.body)})
      return result
    } finally {
      this.activeRequests.delete(requestKey)
    }
  }

  async record(type, data) {
    if (!this.recorder) return
    const bytes = byteLength(JSON.stringify({type, data}))
    if (this.transcriptBytes + bytes > this.limits.transcriptBytes) throw new MCPClientError("transcript_limit", "MCP transcript limit exceeded")
    this.transcriptBytes += bytes
    await this.recorder.record(type, data)
  }

  close(reason = "closed") {
    if (this.closed) return
    this.closed = true
    this.controller.abort(reason)
    for (const controller of this.activeRequests.values()) controller.abort(reason)
    this.activeRequests.clear()
    this.pending.clear()
    this.notifications.length = 0
  }

  handles() { return {pending: this.pending.size, active_requests: this.activeRequests.size, closed: this.closed} }
}

function safeJson(text) { try { return JSON.parse(text) } catch { return "[INVALID JSON]" } }

export function actionCases(tool) {
  const branches = new Map(tool.inputSchema.oneOf.map(branch => [branch.properties.action.const, branch]))
  return [...branches].map(([action, branch]) => ({
    action,
    positive: schemaArguments(action, branch),
    negative: negativeArguments(action, branch),
    business_success_expected: !new Set(["discovery.get", "page.get", "page.tools", "page.call"]).has(action),
  }))
}

function negativeArguments(action, branch) {
  const required = branch.properties.params?.required ?? []
  if (required.length > 0) return {action, params: {}}
  return {action: `${action}.invalid`}
}

export function jsonRpcError(response) {
  if (response.status !== 200) return {layer: "transport", kind: response.body?.error?.message, status: response.status}
  if (response.body?.error) return {layer: "jsonrpc", kind: response.body.error.message, code: response.body.error.code}
  if (response.body?.result?.isError) return {layer: "tool", kind: response.body.result.structuredContent?.kind}
  return undefined
}

export function createRequestGate() {
  let release
  let entered
  const enteredPromise = new Promise(resolve => { entered = resolve })
  const releasePromise = new Promise(resolve => { release = resolve })
  return {
    entered: enteredPromise,
    release: () => release(),
    fetch: async (...args) => { entered(); await releasePromise; return fetch(...args) },
  }
}

function schemaArguments(action, branch) {
  const required = branch.properties.params?.required ?? []
  const values = {id: "missing", page: "missing", tool: "missing", catalog_revision: 1, session: "missing", arguments: {}}
  const params = Object.fromEntries(required.map(key => [key, values[key]]))
  return Object.keys(params).length === 0 ? {action} : {action, params}
}

export async function waitForHealth(client, status, {timeoutMs = 8_000} = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await client.health()
    if (last.status === status) return last
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new MCPClientError("health_timeout", `health did not reach ${status}`, {last_status: last?.status})
}
