import {readFile} from "node:fs/promises"
import {Client, StreamableHTTPClientTransport, SUPPORTED_PROTOCOL_VERSIONS} from "@modelcontextprotocol/client"
import {actionCases} from "./mcp-client.js"

const DEFAULT_DEADLINES = Object.freeze({connection: 5_000, operation: 5_000, shutdown: 5_000})
export async function loadOfficialCompatibility(path = new URL("../contracts/mcp-official-compatibility.json", import.meta.url)) { return JSON.parse(await readFile(path, "utf8")) }
const same = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())

export async function loadAuthoritativeCompatibility() {
  const load = path => readFile(new URL(path, import.meta.url), "utf8").then(JSON.parse)
  const [mcp, vertical, fixture, lifecycle] = await Promise.all([load("../contracts/mcp-versions.json"), load("../contracts/scenarios/shared-vertical-slice.json"), load("../contracts/scenarios/fixture-outcomes.json"), load("../contracts/scenarios/lifecycle-removal.json")])
  if (!vertical.steps.some(step => step.action.op === "mcp.invoke")) throw new Error("shared vertical slice no longer exercises MCP")
  const outcomes = new Set()
  for (const fixtureOutcome of fixture.combinations.dimensions.outcome) {
    if (["json", "text", "side-effect"].includes(fixtureOutcome)) outcomes.add("success")
    else if (fixtureOutcome === "throw") outcomes.add("tool_error")
    else if (["oversized", "deep"].includes(fixtureOutcome)) outcomes.add("malformed_result")
    else if (fixtureOutcome === "cancel") outcomes.add("cancelled")
    else if (fixtureOutcome === "delay") outcomes.add("timed_out")
  }
  const transitions = new Set(lifecycle.combinations.dimensions.transition)
  if (transitions.has("disconnect")) outcomes.add("disconnected")
  if (transitions.has("credential-revoke")) outcomes.add("revoked")
  if (lifecycle.combinations.dimensions.result?.includes("late")) outcomes.add("late_result_rejected")
  return {methods: mcp.methods, actions: mcp.broker_actions, versions: mcp.supported, outcomes: [...outcomes].sort(), scenario_ids: [vertical.id, fixture.id, lifecycle.id]}
}

export function assertCompatibilityInventory(contract, authoritative) {
  if (!same(contract.required_methods, authoritative.methods)) throw new Error("unreviewed official-client method drift")
  if (!same(contract.required_actions, authoritative.actions)) throw new Error("unreviewed official-client action drift")
  if (!same(contract.page_call_outcomes, authoritative.outcomes)) throw new Error("unreviewed official-client terminal outcome drift")
  const accounted = new Set([...contract.negotiated_versions, ...contract.executed_outcomes, ...contract.reviewed_exclusions.flatMap(item => item.covers)])
  for (const version of authoritative.versions) if (!accounted.has(version)) throw new Error(`unreviewed official-client version drift: ${version}`)
  for (const outcome of contract.page_call_outcomes) if (!accounted.has(outcome)) throw new Error(`unreviewed official-client outcome drift: ${outcome}`)
  if (!same(contract.sdk_supported_versions, SUPPORTED_PROTOCOL_VERSIONS.filter(version => authoritative.versions.includes(version)))) throw new Error("pinned SDK supported-version inventory drift")
}

export class OfficialMCPClient {
  constructor({baseUrl, token, producer, headers = {}, fetchImpl = fetch, deadlines = {}, versionNegotiation = {mode: "legacy"}} = {}) {
    const endpoint = new URL("/mcp", baseUrl)
    if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(endpoint.hostname)) throw new Error("official MCP compatibility only permits loopback")
    this.producer = producer; this.deadlines = {...DEFAULT_DEADLINES, ...deadlines}; this.active = new Set(); this.timers = new Set(); this.state = "open"; this.latestCallRequestId = undefined
    this.cancelNotification = async (requestId, reason, signal) => {
      const response = await fetchImpl(endpoint, {method: "POST", signal, headers: {accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "content-type": "application/json", "mcp-protocol-version": this.transport.protocolVersion ?? "2025-11-25"}, body: JSON.stringify({jsonrpc: "2.0", method: "notifications/cancelled", params: {requestId, reason}})})
      if (response.status !== 202) throw new Error(`official cancellation notification failed: HTTP ${response.status}`)
    }
    this.transport = new StreamableHTTPClientTransport(endpoint, {requestInit: {headers: {...headers, ...(token ? {authorization: `Bearer ${token}`} : {})}}, fetch: this.recordingFetch(fetchImpl), reconnectionOptions: {maxReconnectionDelay: 100, initialReconnectionDelay: 10, reconnectionDelayGrowFactor: 1, maxRetries: 0}})
    this.client = new Client({name: "webby-official-compatibility", version: "1.0.0"}, {capabilities: {}, versionNegotiation})
  }
  recordingFetch(fetchImpl) { return async (url, init = {}) => { const method = init.method ?? "GET"; const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined; if (body?.method === "tools/call" && Number.isInteger(body.id)) this.latestCallRequestId = body.id; await this.producer?.event("official-mcp.request", {method, rpc_method: body?.method, rpc_id: body?.id}); const response = await fetchImpl(url, init); await this.producer?.event("official-mcp.response", {method, rpc_method: body?.method, status: response.status}); return response } }
  bounded(label, operation, timeoutMs) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(`${label} deadline exceeded`), timeoutMs); timer.unref?.(); this.timers.add(timer); this.active.add(controller); return Promise.resolve().then(() => operation(controller.signal)).finally(() => { clearTimeout(timer); this.timers.delete(timer); this.active.delete(controller) }) }
  connect() { return this.bounded("connect", signal => this.client.connect(this.transport, {signal}), this.deadlines.connection) }
  ping() { return this.bounded("ping", signal => this.client.ping({signal}), this.deadlines.operation) }
  listTools() { return this.bounded("tools/list", signal => this.client.listTools({}, {signal}), this.deadlines.operation) }
  call(arguments_, {signal: outerSignal, timeoutMs = this.deadlines.operation} = {}) { return this.bounded("tools/call", signal => this.client.callTool({name: "webby", arguments: arguments_}, {signal: outerSignal ? AbortSignal.any([signal, outerSignal]) : signal}), timeoutMs) }
  callRequestId() { if (!Number.isInteger(this.latestCallRequestId)) throw new Error("official client has not dispatched a tool call"); return this.latestCallRequestId }
  cancel(requestId, reason = "official cancellation") { if (!Number.isInteger(requestId)) throw new Error("official cancellation requires an integer request ID"); return this.bounded("notifications/cancelled", signal => this.cancelNotification(requestId, reason, signal), this.deadlines.operation) }
  async actionMatrix() { const listed = await this.listTools(); const tool = listed.tools.find(item => item.name === "webby"); if (!tool) throw new Error("official client did not discover webby tool"); const outcomes = []; for (const item of actionCases(tool)) outcomes.push({action: item.action, positive: normalizeToolResult(await this.call(item.positive)), negative: normalizeToolResult(await this.call(item.negative))}); return outcomes }
  async report({sdkVersion, outcomes}) { return this.producer?.diagnostic("official-mcp-compatibility.json", {sdk_version: sdkVersion, negotiated_version: this.transport.protocolVersion, actions: outcomes}, ["sdk_version", "negotiated_version", "actions"]) }
  async close() {
    if (this.state === "closed") return
    if (this.closing) return this.closing
    this.state = "closing"
    this.closing = this.#close().then(() => { this.state = "closed" }).catch(error => { this.state = "failed"; throw error }).finally(() => { this.closing = undefined })
    return this.closing
  }
  async #close() {
    for (const controller of this.active) controller.abort("official client closing")
    let timer
    const shutdown = (async () => {
      await this.transport.terminateSession().catch(error => { if (!/405|Method Not Allowed/i.test(error.message)) throw error })
      await this.client.close()
    })()
    try {
      await Promise.race([shutdown, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("official MCP shutdown deadline exceeded"), {code: "official_mcp_shutdown_timeout"})), this.deadlines.shutdown)
        timer.unref?.(); this.timers.add(timer)
      })])
    } catch (error) {
      await this.transport.close?.()
      throw error
    } finally { clearTimeout(timer); this.timers.delete(timer) }
  }
  handles() { return {active_requests: this.active.size, timers: this.timers.size, transport_closed: this.state === "closed", closed: this.state === "closed"} }
}
export function normalizeToolResult(result) { return {state: result.isError ? "failed" : "succeeded", terminal: true, kind: result.structuredContent?.kind} }
