import assert from "node:assert/strict"
import test from "node:test"
import {assertExactTerminal, auditState, beginAdmittedCalls, beginCalls, cleanupCapacityFixture, completeCalls, measuredState, openCapacityFixture, rawMcpCall, toolOutcome} from "./protocol-capacity-fixture.js"

test("capacity cleanup continues after a client close failure", async () => {
  const calls = []
  const fail = new Error("client close failed")
  await assert.rejects(cleanupCapacityFixture({
    credentials: [{client: {close() { calls.push("client"); throw fail }}}],
    browsers: [{browser: {async close() { calls.push("browser") }}}],
    recorder: {async finalize() { calls.push("recorder") }},
    world: {async teardown() { calls.push("world") }},
    root: "/path/that/does/not/exist",
  }), error => error === fail && error.cleanup_label === "client-1")
  assert.deepEqual(calls, ["client", "browser", "recorder", "world"])
})

test("exact terminal assertion rejects leaked work, started audits, and double audit completion", () => {
  const clean = {browser_pending: 0, client_pending: 0, client_active: 0}
  assert.throws(() => assertExactTerminal({state: {...clean, browser_pending: 1}, audits: {started: 0, terminal: 1}, expectedAudits: 1}), /browser work leaked/)
  assert.throws(() => assertExactTerminal({state: clean, audits: {started: 1, terminal: 0}, expectedAudits: 1}), /started audit leaked/)
  assert.throws(() => assertExactTerminal({state: clean, audits: {started: 0, terminal: 2}, expectedAudits: 1}), /audit terminal count was not exact/)
})

test("repeated fixed-seed live batches have identical normalized outcomes", {timeout: 120_000}, async t => {
  const fixture = await openCapacityFixture(t, "protocol-capacity-seed-repeat")
  const repetitions = []
  for (let repetition = 0; repetition < 2; repetition += 1) {
    const batch = await beginAdmittedCalls(fixture, 10, {idPrefix: `seed-${fixture.world.seed}-${repetition}`, batchSize: 2})
    await completeCalls(fixture, batch.calls, {reverse: true})
    const outcomes = (await Promise.all(batch.requests)).map(toolOutcome)
    repetitions.push(outcomes.map(item => item.state))
  }
  assert.deepEqual(repetitions[0], repetitions[1])
  assert.deepEqual(repetitions[0], Array.from({length: 10}, () => "succeeded"))
})

for (const count of [99, 100, 101]) test(`literal ${count} live calls enforce and recover the global capacity boundary`, {timeout: 300_000}, async t => {
    const fixture = await openCapacityFixture(t, `protocol-capacity-${count}`, {credentialCount: 2})
    const batch = await beginAdmittedCalls(fixture, Math.min(count, 100), {idPrefix: `boundary-${count}`})
    const calls = batch.calls
    assert.equal(calls.length, Math.min(count, 100))
    if (count === 101) {
      const entry = fixture.credentials[0]; const session = entry.sessions[0]
      const overflow = await rawMcpCall(fixture.world.baseUrl, entry.credential.token, "boundary-101-overflow", {action: "page.call", params: {page: fixture.registrationId, session: session.id, tool: "tool_0", catalog_revision: session.catalog_revision, arguments: {index: 100}}})
      batch.requests.push(Promise.resolve(overflow))
      assert.deepEqual(toolOutcome(overflow), {state: "rejected", kind: "server_busy"})
    }
    await completeCalls(fixture, calls, {reverse: true})
    const responses = await Promise.all(batch.requests)
    const outcomes = responses.map(toolOutcome)
    assert.equal(outcomes.filter(outcome => outcome.state === "succeeded").length, Math.min(count, 100))
    assert.equal(outcomes.filter(outcome => outcome.kind === "server_busy").length, count === 101 ? 1 : 0)
    const state = await measuredState(fixture)
    assert.equal(state.browser_pending, 0)
    assert.equal(state.client_pending, 0)
    assert.equal(state.client_active, 0)
    assert.equal(state.active_sessions, 1)
    const audits = await auditState(fixture)
    assert.equal(audits.started, 0)
    assert.equal(audits.terminal, count)
    const normalized = {count, admitted: calls.length, succeeded: outcomes.filter(item => item.state === "succeeded").length, rejected: outcomes.filter(item => item.state === "rejected").length}
    assert.deepEqual(normalized, {count, admitted: Math.min(count, 100), succeeded: Math.min(count, 100), rejected: count === 101 ? 1 : 0})
    await fixture.recorder.producers.world.event("capacity.boundary.measured", {...normalized, pending_calls: state.browser_pending})
    if (count === 100 && process.env.WEBBY_STRESS_PROCESS_NONCE) console.log(`WEBBY_STRESS_MEASUREMENT=${JSON.stringify({pending_calls: normalized.admitted})}`)
  const reuse = beginCalls(fixture, 1, {idPrefix: "post-overflow-reuse", transport: "raw"})
  const [call] = await reuse.arrivals
  await completeCalls(fixture, [call])
  assert.deepEqual(toolOutcome((await Promise.all(reuse.requests))[0]), {state: "succeeded", value: {index: 0}})
  })

test("capacity is global across multiple credentials and releases once after browser disconnect", {timeout: 180_000}, async t => {
  const fixture = await openCapacityFixture(t, "protocol-capacity-multi-identity", {browserCount: 2, credentialCount: 3})
  const batch = await beginAdmittedCalls(fixture, 100, {idPrefix: "multi-identity"})
  const calls = batch.calls
  assert.equal(new Set(calls.map(call => call.observed_browser_id)).size, 2)
  await fixture.browsers[0].browser.disconnect()
  await completeCalls(fixture, calls.filter(call => call.observed_browser_id === fixture.browsers[1].browserId), {reverse: true})
  const responses = await Promise.all(batch.requests)
  const outcomes = responses.map(toolOutcome)
  assert.equal(outcomes.filter(item => item.state === "rejected").length, 50)
  assert.ok(outcomes.every(item => item.state === "succeeded" || item.kind === "browser_offline"))
  assert.equal(outcomes.filter(item => item.kind === "browser_offline").length, 50)
  assert.equal(outcomes.filter(item => item.state === "succeeded").length, 50)
  const state = await measuredState(fixture)
  assert.deepEqual({browser_pending: state.browser_pending, client_pending: state.client_pending, client_active: state.client_active}, {browser_pending: 0, client_pending: 0, client_active: 0})
  assert.equal(state.active_sessions, 1)
  const audits = await auditState(fixture); assert.equal(audits.started, 0); assert.equal(audits.terminal, 100)
  await fixture.recorder.producers.world.event("capacity.disconnect.measured", {credentials: 3, browsers: 2, submitted: 100, outcomes, measured: state})
  await fixture.browsers[0].browser.authenticate(fixture.browsers[0].browserId)
  const reuse = beginCalls(fixture, 1, {idPrefix: "disconnect-reuse", transport: "raw"})
  const [call] = await reuse.arrivals
  await completeCalls(fixture, [call])
  assert.equal(toolOutcome((await Promise.all(reuse.requests))[0]).state, "succeeded")
})
