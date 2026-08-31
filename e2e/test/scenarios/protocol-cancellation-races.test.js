import assert from "node:assert/strict"
import test from "node:test"
import {credentialRevokeOwnerOracle, normalizeLifecycleEvidence} from "../../support/lifecycle-parity.js"
import {auditState, beginAdmittedCalls, eventBarrier, measuredState, openCapacityFixture, rawMcpCall, rawMcpCancel, toolOutcome} from "./protocol-capacity-fixture.js"

function invoke(fixture, entry, id, arguments_ = {}) {
  const session = entry.sessions[0]
  return entry.client.call({action: "page.call", params: {page: fixture.registrationId, session: session.id, tool: "tool_0", catalog_revision: session.catalog_revision, arguments: arguments_}}, {id})
}

test("cancellation before dispatch, during execution, after completion, duplicate, and unknown are idempotent", {timeout: 120_000}, async t => {
  const fixture = await openCapacityFixture(t, "protocol-cancellation-timings")
  const {browser} = fixture.browsers[0]
  const entry = fixture.credentials[0]

  assert.equal((await entry.client.cancel("before-dispatch")).status, 202)
  const beforeArrival = eventBarrier(browser, "tool.call", 1)
  const beforeRequest = invoke(fixture, entry, "before-dispatch", {phase: "before"})
  const [beforeCall] = await beforeArrival
  await browser.result(beforeCall.call_id, {phase: "before"})
  assert.equal(toolOutcome(await beforeRequest).state, "succeeded")

  const duringArrival = eventBarrier(browser, "tool.call", 1)
  const duringRequest = invoke(fixture, entry, "during-execution", {phase: "during"})
  const [duringCall] = await duringArrival
  const cancelSeen = browser.waitFor("tool.cancel", value => value.call_id === duringCall.call_id)
  assert.equal((await entry.client.cancel("during-execution")).status, 202)
  await cancelSeen
  assert.deepEqual(toolOutcome(await duringRequest), {state: "rejected", kind: "cancelled"})
  await assert.rejects(browser.result(duringCall.call_id, {late: true}), error => error.code === "call_not_pending")
  assert.equal((await entry.client.cancel("during-execution")).status, 202)
  assert.equal((await entry.client.cancel("unknown-request")).status, 202)

  const afterArrival = eventBarrier(browser, "tool.call", 1)
  const afterRequest = invoke(fixture, entry, "after-completion", {phase: "after"})
  const [afterCall] = await afterArrival
  await browser.result(afterCall.call_id, {phase: "after"})
  assert.equal(toolOutcome(await afterRequest).state, "succeeded")
  assert.equal((await entry.client.cancel("after-completion")).status, 202)

  const state = await measuredState(fixture)
  assert.deepEqual({browser_pending: state.browser_pending, client_pending: state.client_pending, client_active: state.client_active}, {browser_pending: 0, client_pending: 0, client_active: 0})
  await fixture.recorder.producers.world.event("cancellation.timings.measured", {before: "succeeded", during: "cancelled", after: "succeeded", duplicate: "idempotent", unknown: "idempotent", late_result: "rejected", measured: state})
})

test("same request IDs isolate across credentials while duplicate external identity is rejected within one credential", {timeout: 120_000}, async t => {
  const fixture = await openCapacityFixture(t, "protocol-request-identity", {credentialCount: 2})
  const {browser} = fixture.browsers[0]
  const arrivals = eventBarrier(browser, "tool.call", 2)
  const first = invoke(fixture, fixture.credentials[0], "shared-id", {owner: "first"})
  const second = invoke(fixture, fixture.credentials[1], "shared-id", {owner: "second"})
  const calls = await arrivals
  const firstCall = calls.find(call => call.arguments.owner === "first")
  const secondCall = calls.find(call => call.arguments.owner === "second")
  const cancelled = browser.waitFor("tool.cancel", value => value.call_id === firstCall.call_id)
  await fixture.credentials[0].client.cancel("shared-id")
  await cancelled
  await browser.result(secondCall.call_id, {owner: "second"})
  assert.deepEqual(toolOutcome(await first), {state: "rejected", kind: "cancelled"})
  assert.deepEqual(toolOutcome(await second), {state: "succeeded", value: {owner: "second"}})

  const duplicateArrival = eventBarrier(browser, "tool.call", 1)
  const duplicateEntry = fixture.credentials[0]
  const duplicateSession = duplicateEntry.sessions[0]
  const duplicateArguments = attempt => ({action: "page.call", params: {page: fixture.registrationId, session: duplicateSession.id, tool: "tool_0", catalog_revision: duplicateSession.catalog_revision, arguments: {attempt}}})
  const duplicateA = rawMcpCall(fixture.world.baseUrl, duplicateEntry.credential.token, "duplicate-id", duplicateArguments("a"))
  const duplicateB = rawMcpCall(fixture.world.baseUrl, duplicateEntry.credential.token, "duplicate-id", duplicateArguments("b"))
  const [admitted] = await duplicateArrival
  const duplicateRejected = await Promise.race([duplicateA, duplicateB])
  assert.deepEqual(toolOutcome(duplicateRejected), {state: "rejected", kind: "duplicate_request"})
  await browser.result(admitted.call_id, {attempt: admitted.arguments.attempt})
  const duplicateOutcomes = (await Promise.all([duplicateA, duplicateB])).map(toolOutcome)
  assert.equal(duplicateOutcomes.filter(item => item.state === "succeeded").length, 1)
  assert.equal(duplicateOutcomes.filter(item => item.kind === "duplicate_request").length, 1)
  const state = await measuredState(fixture)
  assert.equal(state.browser_pending, 0)
  await fixture.recorder.producers.world.event("request.identity.measured", {cross_credential_same_id: "isolated", same_credential_duplicate: "rejected", measured: state})
})

test("caller death, navigation, result, and disconnect races have one terminal outcome and reusable capacity", {timeout: 120_000}, async t => {
  const fixture = await openCapacityFixture(t, "protocol-terminal-races", {invocationTimeoutMs: 500})
  const {browser} = fixture.browsers[0]
  const entry = fixture.credentials[0]

  const deadArrival = eventBarrier(browser, "tool.call", 1)
  const deadSession = entry.sessions[0]
  let deadSocket
  const deadRequest = rawMcpCall(fixture.world.baseUrl, entry.credential.token, "caller-death", {action: "page.call", params: {page: fixture.registrationId, session: deadSession.id, tool: "tool_0", catalog_revision: deadSession.catalog_revision, arguments: {phase: "caller-death"}}}, {onSocket: socket => { deadSocket = socket }})
  const [deadCall] = await deadArrival
  const deadCancel = browser.waitFor("tool.cancel", value => value.call_id === deadCall.call_id)
  deadSocket.destroy(new Error("caller-death"))
  await assert.rejects(deadRequest, /caller-death/)
  await deadCancel

  const navigationArrival = eventBarrier(browser, "tool.call", 1)
  const navigationRequest = invoke(fixture, entry, "navigation-race", {phase: "navigate"})
  const [navigationCall] = await navigationArrival
  const navigationCancel = browser.waitFor("tool.cancel", value => value.call_id === navigationCall.call_id)
  await browser.navigate({...fixture.observation, document_id: "document-replacement"})
  await navigationCancel
  assert.deepEqual(toolOutcome(await navigationRequest), {state: "rejected", kind: "stale_document"})
  await assert.rejects(browser.result(navigationCall.call_id, {late: true}), error => error.code === "call_not_pending")
  const refreshed = await entry.client.call({action: "page.tools", params: {page: fixture.registrationId}})
  entry.sessions = refreshed.body.result.structuredContent.sessions

  const resultArrival = eventBarrier(browser, "tool.call", 1)
  const resultRequest = invoke(fixture, entry, "result-first", {phase: "result"})
  const [resultCall] = await resultArrival
  await browser.result(resultCall.call_id, {phase: "result"})
  assert.equal(toolOutcome(await resultRequest).state, "succeeded")
  await entry.client.cancel("result-first")

  const disconnectArrival = eventBarrier(browser, "tool.call", 1)
  const disconnectRequest = invoke(fixture, entry, "disconnect-race", {phase: "disconnect"})
  await disconnectArrival
  await browser.disconnect()
  assert.deepEqual(toolOutcome(await disconnectRequest), {state: "rejected", kind: "browser_offline"})
  await browser.authenticate(browser.browserId)

  const state = await measuredState(fixture)
  assert.deepEqual({browser_pending: state.browser_pending, client_pending: state.client_pending, client_active: state.client_active}, {browser_pending: 0, client_pending: 0, client_active: 0})
  await fixture.recorder.producers.world.event("terminal.races.measured", {caller_death: "cancelled", navigation: "stale_document", result_first: "succeeded", disconnect: "browser_offline", late_result: "rejected", measured: state})
})

test("a 100-call cancellation burst releases every slot exactly once with terminal audits", {timeout: 300_000}, async t => {
  const fixture = await openCapacityFixture(t, "protocol-cancellation-burst", {credentialCount: 4})
  const batch = await beginAdmittedCalls(fixture, 100, {idPrefix: "cancel-burst"})
  const saturated = await measuredState(fixture)
  assert.equal(batch.calls.length, 100)
  assert.equal(saturated.browser_pending, 100)
  const started = await auditState(fixture); assert.equal(started.started, 100); assert.equal(started.terminal, 0)
  const cancelled = eventBarrier(fixture.browsers[0].browser, "tool.cancel", 100, () => true, 120_000)
  const notices = await mapBounded(Array.from({length: 100}, (_, index) => index), 2, index => rawMcpCancel(fixture.world.baseUrl, fixture.credentials[index % fixture.credentials.length].credential.token, `cancel-burst-${index}`))
  const observedCancels = await cancelled
  assert.deepEqual(notices.map(notice => ({status: notice.status, error: notice.body?.error})), Array.from({length: 100}, () => ({status: 202, error: undefined})))
  assert.equal(observedCancels.length, 100)
  const responses = await Promise.all(batch.requests)
  const failedResponses = responses.filter(response => response.status !== 200)
  assert.equal(failedResponses.length, 0, JSON.stringify(failedResponses))
  const outcomes = responses.map(toolOutcome)
  assert.equal(outcomes.length, 100)
  assert.ok(outcomes.every(outcome => outcome.state === "rejected" && outcome.kind === "cancelled"))
  const measured = await measuredState(fixture); assert.equal(measured.browser_pending, 0); assert.equal(measured.active_sessions, 1)
  const audits = await auditState(fixture); assert.deepEqual(audits, {rows: Array.from({length: 100}, () => ({outcome: "failed", error_kind: "cancelled"})), started: 0, terminal: 100})
})

async function mapBounded(values, concurrency, operation) {
  let next = 0
  const results = new Array(values.length)
  await Promise.all(Array.from({length: concurrency}, async () => {
    for (;;) {
      const index = next++
      if (index >= values.length) return
      results[index] = await operation(values[index])
    }
  }))
  return results
}

test("credential revocation cancels an in-flight call and releases capacity exactly once", {timeout: 120_000}, async t => {
  const fixture = await openCapacityFixture(t, "protocol-credential-revoke", {dashboardSetup: true})
  const entry = fixture.credentials[0]
  const arrival = eventBarrier(fixture.browsers[0].browser, "tool.call", 1)
  const request = invoke(fixture, entry, "credential-revoke", {phase: "revoke"})
  const [call] = await arrival
  const cancelled = fixture.browsers[0].browser.waitFor("tool.cancel", value => value.call_id === call.call_id)
  await fixture.dashboard.refresh()
  const row = fixture.dashboard.row("mcp-credential", entry.credential.id)
  await fixture.dashboard.click(row, "Revoke")
  await cancelled
  assert.deepEqual(toolOutcome(await request), {state: "rejected", kind: "revoked"})
  await assert.rejects(fixture.browsers[0].browser.result(call.call_id, {late: true}), error => error.code === "call_not_pending")
  const measured = await measuredState(fixture); assert.equal(measured.browser_pending, 0); assert.equal(measured.active_sessions, 1)
  const audits = await auditState(fixture); assert.deepEqual(audits.rows, [{outcome: "failed", error_kind: "revoked"}]); assert.equal(audits.started, 0)
  const normalized = normalizeLifecycleEvidence({caller: {state: "revoked", terminal: true}, browserWork: {state: "aborted"}, session: {state: measured.active_sessions === 1 ? "active" : "invalidated"}, lateResult: {state: "rejected"}, capacity: {state: "released", value: measured.browser_pending}, audit: {state: audits.rows[0].outcome, terminal: true, count: audits.rows.length, outcome: audits.rows[0].outcome}})
  assert.deepEqual(normalized, credentialRevokeOwnerOracle)
})
