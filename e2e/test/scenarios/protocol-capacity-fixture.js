import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {createConnection} from "node:net"
import {randomUUID} from "node:crypto"
import {promisify} from "node:util"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {ChromiumWorld} from "../../support/chromium-world.js"
import {DashboardDriver} from "../../support/dashboard-driver.js"
import {MCPClient} from "../../support/mcp-client.js"
import {SimulatedBrowser} from "../../support/simulated-browser.js"
import {WebbyWorld} from "../../support/world.js"

const execFileAsync = promisify(execFile)
export const CAPACITY_SEED = 8675309

export async function sqlite(database, sql) {
  return JSON.parse((await execFileAsync("sqlite3", ["-json", database, sql])).stdout || "[]")
}

export function eventBarrier(emitter, type, count, predicate = () => true, timeoutMs = 30_000) {
  const values = []
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error(`timed out after ${values.length}/${count} ${type} events`)), timeoutMs)
    const listener = value => {
      if (!predicate(value)) return
      values.push(value)
      if (values.length === count) finish(resolve, values)
    }
    const finish = (complete, value) => { clearTimeout(timer); emitter.off(type, listener); complete(value) }
    emitter.on(type, listener)
  })
}

export async function openCapacityFixture(t, scenarioId, {browserCount = 1, credentialCount = 1, dashboardSetup = false, invocationTimeoutMs = 120_000} = {}) {
  const root = await mkdtemp(join(tmpdir(), `${scenarioId}-`))
  const world = await WebbyWorld.start({scenarioId, seed: CAPACITY_SEED, invocationTimeoutMs})
  const recorder = await new ArtifactRecorder({root: join(root, "recorder"), scenarioId, worldId: world.worldId, seed: world.seed, secrets: [world.secret]}).open()
  let chromium
  let dashboard
  const browsers = []
  const credentials = []
  t.after(async () => {
    const failures = []
    for (const {client} of credentials) client.close()
    for (const operation of [
      ...browsers.map(({browser}) => () => browser.close()),
      ...(chromium ? [() => chromium.close()] : []),
      () => recorder.finalize({cleanup: {clients: "closed", browsers: "closed", chromium: chromium ? "closed" : "not-started"}}),
      () => world.teardown(),
      () => rm(root, {recursive: true, force: true}),
    ]) {
      try { await operation() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, "capacity fixture cleanup failed")
  })
  if (dashboardSetup) {
    chromium = await ChromiumWorld.launch({world, recorder})
    const page = await chromium.context.newPage()
    dashboard = await new DashboardDriver({page, recorder, timeoutMs: 20_000}).open(world.baseUrl)
  }
  for (let index = 0; index < browserCount; index += 1) {
    const browser = new SimulatedBrowser({baseUrl: world.baseUrl, producer: recorder.producers.protocol, timeoutMs: 30_000})
    let browserId
    if (dashboardSetup) {
      await browser.connect()
      const pairing = await browser.pair({displayName: `Capacity Browser ${index}`})
      await dashboard.refresh()
      browserId = await dashboard.approvePairing(pairing.pairing_id, `Capacity Browser ${index}`)
    } else {
      browserId = randomUUID()
      const now = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")
      await execFileAsync("sqlite3", [world.databasePath, `INSERT INTO browsers (id,display_name,extension_id,public_key,scanning_mode,paired_at,inserted_at,updated_at) VALUES ('${browserId}','Capacity Browser ${index}','${browser.identity.extensionId}',X'${browser.identity.publicKeyRaw.toString("hex")}','granted_sites','${now}','${now}','${now}');`])
    }
    await browser.authenticate(browserId)
    browsers.push({browser, browserId})
  }
  const observation = browsers[0].browser.observation(700, {origin: "https://capacity.fixture", toolCount: 1})
  let registrationId
  if (dashboardSetup) {
    await browsers[0].browser.observe([observation])
    await dashboard.refresh()
    const row = await dashboard.rowByText("discoveries", "discovery", "Fixture 700")
    const discoveryId = (await row.getAttribute("id")).slice("discovery-".length)
    registrationId = await dashboard.registerDiscovery(discoveryId, "Fixture 700")
  } else {
    registrationId = randomUUID()
    const now = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")
    await execFileAsync("sqlite3", [world.databasePath, `INSERT INTO page_registrations (id,slug,display_name,origin,url_pattern,auto_attach,enabled,exposure_mode,inserted_at,updated_at) VALUES ('${registrationId}','capacity-fixture','Capacity Fixture','https://capacity.fixture','/page/700',1,1,'broker','${now}','${now}');`])
    await recorder.producers.world.event("setup.direct-fixture", {kind: "reviewed-fault-injection", browser_count: browserCount, registration_id: registrationId})
  }
  for (const entry of browsers) await entry.browser.observe([{...observation, tab_id: 700 + browsers.indexOf(entry), document_id: `document-${700 + browsers.indexOf(entry)}`}])
  for (let index = 0; index < credentialCount; index += 1) {
    const credential = await world.provisionCredential({scopes: ["read", "call"]})
    recorder.addSecret(credential.token)
    const client = new MCPClient({baseUrl: world.baseUrl, token: credential.token, version: "2025-06-18", limits: {pendingRequests: 256, requestMs: 60_000, lifetimeMs: 120_000, transcriptBytes: 16_000_000}})
    const tools = await client.call({action: "page.tools", params: {page: registrationId}})
    assert.equal(tools.body.result.isError, false)
    assert.equal(tools.body.result.structuredContent.sessions.length, browserCount)
    credentials.push({credential, client, sessions: tools.body.result.structuredContent.sessions})
  }
  const fixture = {root, world, recorder, chromium, dashboard, browsers, credentials, registrationId, observation}
  return fixture
}

export function beginCalls(fixture, count, {idPrefix = "capacity", clientOffset = 0, transport = "client"} = {}) {
  const arrivals = eventBarrierForBrowsers(fixture.browsers, Math.min(count, 100))
  const requests = Array.from({length: count}, (_, index) => {
    const entry = fixture.credentials[(index + clientOffset) % fixture.credentials.length]
    const session = entry.sessions[index % entry.sessions.length]
    const id = `${idPrefix}-${index}`
    const arguments_ = {action: "page.call", params: {page: fixture.registrationId, session: session.id, tool: "tool_0", catalog_revision: session.catalog_revision, arguments: {index}}}
    return transport === "raw" ? rawMcpCall(fixture.world.baseUrl, entry.credential.token, id, arguments_) : entry.client.call(arguments_, {id})
  })
  return {arrivals, requests}
}

export async function beginAdmittedCalls(fixture, count, {idPrefix = "capacity", clientOffset = 0, transport = "raw", batchSize = 1} = {}) {
  const calls = []
  const requests = []
  for (let offset = 0; offset < count; offset += batchSize) {
    const size = Math.min(batchSize, count - offset)
    const arrivals = eventBarrierForBrowsers(fixture.browsers, size)
    for (let local = 0; local < size; local += 1) {
      const index = offset + local
      const entry = fixture.credentials[(index + clientOffset) % fixture.credentials.length]
      const session = entry.sessions[index % entry.sessions.length]
      const id = `${idPrefix}-${index}`
      const arguments_ = {action: "page.call", params: {page: fixture.registrationId, session: session.id, tool: "tool_0", catalog_revision: session.catalog_revision, arguments: {index}}}
      requests.push(transport === "raw" ? rawMcpCall(fixture.world.baseUrl, entry.credential.token, id, arguments_) : entry.client.call(arguments_, {id}))
    }
    calls.push(...await arrivals)
  }
  return {calls, requests}
}

export function rawMcpCall(baseUrl, token, id, arguments_, {onSocket} = {}) {
  return rawMcpMessage(baseUrl, token, {jsonrpc: "2.0", id, method: "tools/call", params: {name: "webby", arguments: arguments_}}, {onSocket})
}

export function rawMcpCancel(baseUrl, token, requestId) {
  return rawMcpMessage(baseUrl, token, {jsonrpc: "2.0", method: "notifications/cancelled", params: {requestId}})
}

function rawMcpMessage(baseUrl, token, message, {onSocket} = {}) {
  const target = new URL(baseUrl)
  const body = JSON.stringify(message)
  return new Promise((resolve, reject) => {
    const socket = createConnection({host: target.hostname, port: Number(target.port)})
    onSocket?.(socket)
    const chunks = []
    socket.setTimeout(180_000, () => socket.destroy(new Error("raw MCP request timed out")))
    socket.on("connect", () => socket.write([
      "POST /mcp HTTP/1.1", `Host: ${target.host}`, "Accept: application/json, text/event-stream", "Content-Type: application/json",
      "MCP-Protocol-Version: 2025-06-18", `Authorization: Bearer ${token}`, `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", "", body,
    ].join("\r\n")))
    socket.on("data", chunk => chunks.push(chunk))
    socket.on("error", reject)
    socket.on("close", hadError => {
      if (hadError) return
      try {
        const response = Buffer.concat(chunks).toString("utf8")
        const split = response.indexOf("\r\n\r\n")
        if (split < 0) throw new Error("raw MCP response closed before headers")
        const head = response.slice(0, split)
        let payload = response.slice(split + 4)
        if (/transfer-encoding:\s*chunked/i.test(head)) payload = decodeChunked(payload)
        const status = Number(head.match(/^HTTP\/1\.1 (\d+)/)?.[1])
        if (!Number.isInteger(status)) throw new Error("raw MCP response status was invalid")
        resolve({status, body: payload ? JSON.parse(payload) : undefined, text: payload})
      } catch (error) { reject(error) }
    })
  })
}

function decodeChunked(value) {
  let cursor = 0
  let decoded = ""
  while (cursor < value.length) {
    const line = value.indexOf("\r\n", cursor)
    const size = Number.parseInt(value.slice(cursor, line), 16)
    if (!size) break
    cursor = line + 2
    decoded += value.slice(cursor, cursor + size)
    cursor += size + 2
  }
  return decoded
}

function eventBarrierForBrowsers(browsers, count, timeoutMs = 120_000) {
  const values = []
  return new Promise((resolve, reject) => {
    const listeners = []
    const timer = setTimeout(() => finish(reject, new Error(`timed out after ${values.length}/${count} tool.call events`)), timeoutMs)
    const finish = (complete, value) => { clearTimeout(timer); for (const [browser, listener] of listeners) browser.off("tool.call", listener); complete(value) }
    for (const {browser, browserId} of browsers) {
      const listener = value => { values.push({...value, observed_browser_id: browserId}); if (values.length === count) finish(resolve, values) }
      listeners.push([browser, listener]); browser.on("tool.call", listener)
    }
  })
}

export async function completeCalls(fixture, calls, {reverse = false} = {}) {
  const ordered = reverse ? [...calls].reverse() : calls
  await Promise.all(ordered.map(async call => {
    const entry = fixture.browsers.find(({browser}) => browser.calls.has(call.call_id))
    assert.ok(entry, `no browser owns ${call.call_id}`)
    await entry.browser.result(call.call_id, {index: call.arguments.index})
  }))
}

export function toolOutcome(response) {
  const result = response.body?.result
  return result?.isError ? {state: "rejected", kind: result.structuredContent?.kind} : {state: "succeeded", value: result?.structuredContent}
}

export async function measuredState(fixture) {
  const audits = await sqlite(fixture.world.databasePath, "SELECT outcome, error_kind, count(*) AS count FROM invocation_audits GROUP BY outcome, error_kind ORDER BY outcome, error_kind;")
  const sessions = await sqlite(fixture.world.databasePath, "SELECT count(*) AS count FROM document_sessions WHERE status = 'active';")
  return {
    browser_pending: fixture.browsers.reduce((sum, {browser}) => sum + [...browser.calls.values()].filter(call => call.state === "pending").length, 0),
    client_pending: fixture.credentials.reduce((sum, {client}) => sum + client.handles().pending, 0),
    client_active: fixture.credentials.reduce((sum, {client}) => sum + client.handles().active_requests, 0),
    active_sessions: Number(sessions[0]?.count ?? 0),
    audits,
  }
}

export async function auditState(fixture) {
  const rows = await sqlite(fixture.world.databasePath, "SELECT outcome, error_kind FROM invocation_audits ORDER BY inserted_at, id;")
  return {rows, started: rows.filter(row => row.outcome === "started").length, terminal: rows.filter(row => row.outcome !== "started").length}
}

export function assertExactTerminal({state, audits, expectedAudits}) {
  assert.equal(state.browser_pending, 0, "browser work leaked")
  assert.equal(state.client_pending, 0, "client request leaked")
  assert.equal(state.client_active, 0, "client transport leaked")
  assert.equal(audits.started, 0, "started audit leaked")
  assert.equal(audits.terminal, expectedAudits, "audit terminal count was not exact")
}
