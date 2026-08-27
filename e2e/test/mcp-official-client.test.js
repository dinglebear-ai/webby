import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {test} from "node:test"
import {join} from "node:path"
import {promisify} from "node:util"
import {ArtifactRecorder} from "../support/artifacts.js"
import {ChromiumWorld} from "../support/chromium-world.js"
import {DashboardDriver} from "../support/dashboard-driver.js"
import {OfficialMCPClient, assertCompatibilityInventory, loadAuthoritativeCompatibility, loadOfficialCompatibility} from "../support/official-mcp-client.js"
import {SimulatedBrowser} from "../support/simulated-browser.js"
import {WebbyWorld} from "../support/world.js"

const compatibility = await loadOfficialCompatibility()
const authoritative = await loadAuthoritativeCompatibility()
const execFileAsync = promisify(execFile)
async function sqlite(database, sql) { return JSON.parse((await execFileAsync("sqlite3", ["-json", database, sql])).stdout || "[]") }

test("pinned official SDK inventory accounts for shared actions, outcomes, and support drift", () => {
  assert.doesNotThrow(() => assertCompatibilityInventory(compatibility, authoritative))
  assert.equal(compatibility.sdk.version, "2.0.0")
  assert.equal(compatibility.sdk.transport, "StreamableHTTPClientTransport")
  assert.deepEqual(authoritative.scenario_ids, ["e2e-shared-vertical-slice", "e2e-fixture-tool-outcomes", "e2e-lifecycle-removal"])
})

test("official Streamable HTTP client negotiates, lists, pings, and runs every broker action", {timeout: 60_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "official-mcp-actions", preserveArtifacts: true})
  const credential = await world.provisionCredential({scopes: ["read", "call"]})
  const recorder = await new ArtifactRecorder({root: join(world.root, "official-mcp-artifacts"), scenarioId: "official-mcp-actions", worldId: world.worldId, versions: {mcp_sdk: compatibility.sdk.version}, secrets: [credential.token]}).open()
  const official = new OfficialMCPClient({baseUrl: world.baseUrl, token: credential.token, producer: recorder.producers.mcp})
  t.after(async () => { await official.close().catch(() => {}); await recorder.finalize({cleanup: official.handles()}).catch(() => {}); await world.teardown() })
  await official.connect()
  assert.deepEqual(await official.ping(), {})
  const outcomes = await official.actionMatrix()
  await official.report({sdkVersion: compatibility.sdk.version, outcomes})
  assert.deepEqual(outcomes.map(item => item.action), compatibility.required_actions)
  const expectedPositive = {
    status: ["succeeded", undefined], "browser.list": ["succeeded", undefined], "discovery.list": ["succeeded", undefined],
    "discovery.get": ["failed", "not_found"], "page.list": ["succeeded", undefined], "page.get": ["failed", "not_found"],
    "page.tools": ["failed", "not_found"], "page.call": ["failed", "not_found"],
  }
  for (const outcome of outcomes) {
    assert.deepEqual([outcome.positive.state, outcome.positive.kind], expectedPositive[outcome.action], `${outcome.action} positive`)
    assert.equal(outcome.positive.terminal, true, outcome.action)
    assert.equal(outcome.negative.kind, "invalid_arguments", outcome.action)
    assert.equal(outcome.negative.state, "failed", outcome.action)
  }
  assert.equal(outcomes.find(item => item.action === "page.call").positive.kind, "not_found")
  assert.equal(official.transport.protocolVersion, "2025-11-25")
  await official.close()
  assert.deepEqual(official.handles(), {active_requests: 0, timers: 0, transport_closed: true, closed: true})
})

test("official client executes every shared page.call terminal outcome through live browser work", {timeout: 120_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "official-mcp-terminals", preserveArtifacts: true})
  const recorder = await new ArtifactRecorder({root: join(world.root, "official-terminal-artifacts"), scenarioId: "official-mcp-terminals", worldId: world.worldId, versions: {mcp_client: compatibility.sdk.version}}).open()
  const browser = new SimulatedBrowser({baseUrl: world.baseUrl, producer: recorder.producers.protocol})
  let chromium; let official; let malformedClient
  t.after(async () => { await malformedClient?.close().catch(() => {}); await official?.close().catch(() => {}); await browser.close().catch(() => {}); await chromium?.close().catch(() => {}); await recorder.finalize({cleanup: official?.handles() ?? {setup: "failed"}}).catch(() => {}); await world.teardown() })
  chromium = await ChromiumWorld.launch({world, recorder})
  const dashboardPage = await chromium.context.newPage()
  const dashboard = await new DashboardDriver({page: dashboardPage, recorder}).open(world.baseUrl)
  await browser.connect()
  const pendingPair = await browser.pair({displayName: "Official MCP Browser"})
  await dashboard.refresh()
  const browserId = await dashboard.approvePairing(pendingPair.pairing_id, "Official MCP Browser")
  await browser.authenticate(browserId)
  const observation = browser.observation(73, {origin: "https://official.fixture", toolCount: 1})
  await browser.observe([observation])
  await dashboard.refresh()
  const discovery = await dashboard.rowByText("discoveries", "discovery", "Fixture 73")
  const registrationId = await dashboard.registerDiscovery((await discovery.getAttribute("id")).slice("discovery-".length), "Fixture 73")
  await browser.observe([observation])
  const credential = await world.provisionCredential({scopes: ["read", "call"]})
  recorder.addSecret(credential.token)
  official = new OfficialMCPClient({baseUrl: world.baseUrl, token: credential.token, producer: recorder.producers.mcp, deadlines: {operation: 20_000}})
  const corrupting = {active: false}
  const corruptFetch = async (url, init) => {
    const response = await fetch(url, init)
    if (!corrupting.active || init?.method !== "POST") return response
    const request = JSON.parse(init.body)
    if (request.method !== "tools/call" || request.params?.arguments?.action !== "page.call") return response
    const body = await response.json(); body.result.structuredContent = []
    return new Response(JSON.stringify(body), {status: response.status, headers: response.headers})
  }
  malformedClient = new OfficialMCPClient({baseUrl: world.baseUrl, token: credential.token, fetchImpl: corruptFetch, deadlines: {operation: 20_000}})
  await official.connect(); await malformedClient.connect()
  const tools = await official.call({action: "page.tools", params: {page: registrationId}})
  const session = tools.structuredContent.sessions[0]
  const args = {page: registrationId, session: session.id, tool: "tool_0", catalog_revision: session.catalog_revision, arguments: {source: "official"}}
  const begin = (client = official, options = {}) => { const arrived = browser.waitFor("tool.call"); const response = client.call({action: "page.call", params: args}, options); return {arrived, response} }

  let call = begin(); let inbound = await call.arrived; await browser.result(inbound.call_id, {value: "ok"})
  let result = await call.response; assert.deepEqual(result.structuredContent, {value: "ok"})

  call = begin(); inbound = await call.arrived; await browser.toolError(inbound.call_id, "controlled_failure", "fixture rejected")
  result = await call.response; assert.equal(result.isError, true); assert.equal(result.structuredContent.kind, "controlled_failure")

  corrupting.active = true; call = begin(malformedClient); inbound = await call.arrived; await browser.result(inbound.call_id, {valid_server_result: true})
  await assert.rejects(call.response, /structuredContent|record|array/i); corrupting.active = false

  const cancelled = new AbortController(); const cancelSeen = browser.waitFor("tool.cancel")
  call = begin(official, {signal: cancelled.signal}); const cancelledResponse = assert.rejects(call.response, /abort|cancel|official cancellation/i); inbound = await call.arrived; cancelled.abort("official cancellation")
  const cancelledNotice = await cancelSeen; assert.equal(cancelledNotice.call_id, inbound.call_id)
  await cancelledResponse
  const lateReply = await browser.message("tool.result", {call_id: inbound.call_id, result: {too_late: true}})
  assert.equal(lateReply.type, "acknowledgement")
  const cancelledAudits = await sqlite(world.databasePath, `SELECT outcome, error_kind FROM invocation_audits WHERE browser_id='${browserId}' AND tool_name='tool_0' AND error_kind='cancelled'`)
  assert.deepEqual(cancelledAudits, [{outcome: "failed", error_kind: "cancelled"}])

  const timeoutCancel = browser.waitFor("tool.cancel", () => true, 20_000)
  call = begin(); inbound = await call.arrived; result = await call.response
  assert.equal(result.isError, true); assert.equal(result.structuredContent.kind, "tool_timeout"); assert.equal((await timeoutCancel).call_id, inbound.call_id)

  call = begin(); inbound = await call.arrived; await browser.disconnect(); result = await call.response
  assert.equal(result.isError, true); assert.equal(result.structuredContent.kind, "browser_offline")
  await browser.authenticate(browserId); await browser.resync([observation])

  await world.revokeCredential(credential.id)
  await assert.rejects(official.call({action: "page.call", params: args}), /401|Unauthorized|invalid_credential/)
  const executed = ["success", "tool_error", "malformed_result", "cancelled", "timed_out", "disconnected", "late_result_rejected", "revoked"]
  assert.deepEqual(executed.sort(), authoritative.outcomes)
  await recorder.producers.mcp.diagnostic("official-mcp-terminal-compatibility.json", {sdk_version: compatibility.sdk.version, negotiated_version: official.transport.protocolVersion, outcomes: executed}, ["sdk_version", "negotiated_version", "outcomes"])
  await malformedClient.close(); await official.close()
  assert.deepEqual(official.handles(), {active_requests: 0, timers: 0, transport_closed: true, closed: true})
})

test("official client exposes authentication, Origin, cancellation, revocation, and clean closure", {timeout: 60_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "official-mcp-boundaries"})
  t.after(() => world.teardown())
  const invalid = new OfficialMCPClient({baseUrl: world.baseUrl, token: "invalid"})
  await assert.rejects(invalid.connect(), /401|Unauthorized|invalid_credential/)
  await invalid.close()
  const credential = await world.provisionCredential({scopes: ["read", "call"]})
  const origin = new OfficialMCPClient({baseUrl: world.baseUrl, token: credential.token, headers: {origin: "https://evil.example"}})
  await assert.rejects(origin.connect(), /403|Forbidden|origin/i)
  await origin.close()
  const incompatible = new OfficialMCPClient({baseUrl: world.baseUrl, token: credential.token, versionNegotiation: {mode: {pin: "1900-01-01"}, probe: {timeoutMs: 1_000, maxRetries: 0}}})
  await assert.rejects(incompatible.connect(), /version|discover|negotiat|1900/i)
  await incompatible.close()
  const official = new OfficialMCPClient({baseUrl: world.baseUrl, token: credential.token})
  await official.connect()
  const controller = new AbortController()
  controller.abort("reviewed cancellation")
  await assert.rejects(official.call({action: "status"}, {signal: controller.signal}), /abort|cancel|reviewed cancellation/i)
  await world.revokeCredential(credential.id)
  await assert.rejects(official.ping(), /401|Unauthorized|invalid_credential/)
  await official.close()
  assert.deepEqual(official.handles(), {active_requests: 0, timers: 0, transport_closed: true, closed: true})
})
