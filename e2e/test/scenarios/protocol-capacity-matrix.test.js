import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import {spawn} from "node:child_process"
import {once} from "node:events"
import test from "node:test"
import {auditState, eventBarrier, measuredState, openCapacityFixture, rawMcpCancel, toolOutcome} from "./protocol-capacity-fixture.js"

const contractPath = new URL("../../contracts/scenarios/capacity-concurrency.json", import.meta.url)

function expand(contract) {
  const dimensions = contract.combinations.dimensions
  return dimensions.terminal_event.flatMap(terminal_event => dimensions.order.flatMap(order => dimensions.late_result.map(late_result => ({terminal_event, order, late_result}))))
}

test("authoritative terminal-event by order by late-result matrix executes live with deterministic normalized outcomes", {timeout: 300_000}, async t => {
  const contract = JSON.parse(await readFile(contractPath, "utf8"))
  const rows = expand(contract)
  assert.equal(rows.length, 30)
  assert.deepEqual(new Set(rows.map(row => JSON.stringify(row))).size, 30)
  const fixture = await openCapacityFixture(t, "protocol-authoritative-capacity-matrix", {invocationTimeoutMs: 500})
  const outcomes = []
  for (const [index, row] of rows.entries()) {
    try { outcomes.push(await executeRow(fixture, row, index)) }
    catch (error) { error.message = `${JSON.stringify(row)}: ${error.message}`; throw error }
  }
  assert.equal(outcomes.length, rows.length)
  assert.deepEqual(outcomes.map(item => item.row), rows)
  assert.equal(outcomes.every(item => item.pending_calls === 0 && item.audit_delta === 1 && item.started_audits === 0), true)
  await fixture.recorder.producers.world.event("capacity.matrix.measured", {seed: fixture.world.seed, rows: outcomes})
})

async function executeRow(fixture, row, index) {
  const browser = fixture.browsers[0].browser
  const entry = fixture.credentials[0]
  const tools = await entry.client.call({action: "page.tools", params: {page: fixture.registrationId}})
  entry.sessions = tools.body.result.structuredContent.sessions
  const session = entry.sessions[0]
  const id = `matrix-${index}`
  const args = {action: "page.call", params: {page: fixture.registrationId, session: session.id, tool: "tool_0", catalog_revision: session.catalog_revision, arguments: {index}}}
  const before = await auditState(fixture)
  const arrival = eventBarrier(browser, "tool.call", 1)
  const caller = row.terminal_event === "caller-death" ? spawnCaller(fixture.world.baseUrl, entry.credential.token, id, args) : undefined
  const request = caller ? undefined : entry.client.call(args, {id})
  const [call] = await arrival
  const race = {
    terminal: async () => {
      await fireTerminal(fixture, row, id, call, caller)
      if (request) await request
      else await waitForAuditDelta(fixture, before.rows.length)
    },
    competitor: () => row.late_result ? browser.result(call.call_id, {winner: "competing-result"}) : Promise.resolve({prevented: true}),
  }
  const ordered = await executeOrder(row.order, race)
  const response = request ? await request : undefined
  await waitForAuditDelta(fixture, before.rows.length)
  if (!row.late_result) assert.deepEqual(ordered.competitor, {status: "prevented"})
  if (row.order === "first" && row.late_result) assert.equal(ordered.competitor.status, "rejected")
  if (row.order === "last" && row.late_result) assert.equal(ordered.competitor.status, "fulfilled")
  if (row.terminal_event === "disconnect") {
    await browser.authenticate(browser.browserId)
    await browser.observe([fixture.observation])
  }
  const after = await auditState(fixture)
  const state = await measuredState(fixture)
  assert.equal(after.rows.length - before.rows.length, 1, JSON.stringify(row))
  assert.equal(after.started, 0, JSON.stringify(row))
  assert.equal(state.browser_pending, 0, JSON.stringify(row))
  const normalized = response ? toolOutcome(response) : {state: "rejected", kind: "caller_down"}
  return {row, winner: normalized.kind ?? normalized.state, terminal: ordered.terminal.status, competitor: ordered.competitor.status, audit_delta: 1, started_audits: after.started, pending_calls: state.browser_pending}
}

async function fireTerminal(fixture, row, id, call, caller) {
  const browser = fixture.browsers[0].browser
  switch (row.terminal_event) {
    case "result": return browser.result(call.call_id, {winner: "terminal-result"})
    case "error": return browser.toolError(call.call_id, "matrix_error", "matrix error")
    case "cancel": return rawMcpCancel(fixture.world.baseUrl, fixture.credentials[0].credential.token, id)
    case "disconnect": return browser.disconnect()
    case "caller-death": if (caller.exitCode === null) { caller.kill("SIGKILL"); await once(caller, "exit") }; return {killed: true}
    default: throw new Error(`unknown terminal event ${row.terminal_event}`)
  }
}

async function executeOrder(order, race) {
  if (order === "first") {
    const terminal = await settled(race.terminal)
    const competitor = await settled(race.competitor)
    return {terminal, competitor}
  }
  if (order === "last") {
    const competitor = await settled(race.competitor)
    const terminal = await settled(race.terminal)
    return {terminal, competitor}
  }
  const barrier = releaseBarrier()
  const terminalPromise = barrier.wait().then(() => settled(race.terminal))
  const competitorPromise = barrier.wait().then(() => settled(race.competitor))
  barrier.release()
  const [terminal, competitor] = await Promise.all([terminalPromise, competitorPromise])
  return {terminal, competitor}
}

async function settled(operation) {
  try {
    const value = await operation()
    return value?.prevented ? {status: "prevented"} : {status: "fulfilled"}
  } catch (error) { return {status: "rejected", code: error.code} }
}

function releaseBarrier() {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return {wait: () => promise, release}
}

async function waitForAuditDelta(fixture, previous) {
  const deadline = Date.now() + 5_000
  for (;;) {
    const current = await auditState(fixture)
    if (current.rows.length === previous + 1 && current.started === 0) return current
    if (Date.now() >= deadline) throw new Error("terminal audit predicate timed out")
    await new Promise(resolve => setImmediate(resolve))
  }
}

function spawnCaller(baseUrl, token, id, arguments_) {
  const script = `await fetch(new URL('/mcp', process.env.WEBBY_BASE_URL), {method:'POST', headers:{accept:'application/json, text/event-stream', authorization:'Bearer '+process.env.WEBBY_TOKEN, 'content-type':'application/json', 'mcp-protocol-version':'2025-06-18'}, body:process.env.WEBBY_BODY})`
  return spawn(process.execPath, ["--input-type=module", "-e", script], {stdio: "ignore", env: {...process.env, WEBBY_BASE_URL: baseUrl, WEBBY_TOKEN: token, WEBBY_BODY: JSON.stringify({jsonrpc: "2.0", id, method: "tools/call", params: {name: "webby", arguments: arguments_}})}})
}
