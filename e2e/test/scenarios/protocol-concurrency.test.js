import assert from "node:assert/strict"
import test from "node:test"
import {SimulatedBrowser} from "../../support/simulated-browser.js"
import {beginAdmittedCalls, eventBarrier, openCapacityFixture, sqlite, toolOutcome} from "./protocol-capacity-fixture.js"

test("literal 10, 100, and 1000 tab scans use bounded fanout and live coalesced session updates", {timeout: 180_000}, async t => {
  const fixture = await openCapacityFixture(t, "protocol-tab-scan-boundaries")
  const {browser} = fixture.browsers[0]
  const evidence = []
  let expectedSessions = 1
  for (const [caseIndex, count] of [10, 100, 1000].entries()) {
    const offset = (caseIndex + 1) * 2_000
    const scan = await browser.scanTabs(count, {batchSize: 128, offset, observation: index => ({...browser.observation(index + offset), document_id: `scan-${count}-${index}`, url: fixture.observation.url})})
    assert.equal(scan.observations.length, count)
    assert.equal(scan.peakBatchSize, Math.min(128, count))
    expectedSessions += count
    const sessions = await sqlite(fixture.world.databasePath, "SELECT count(*) AS count FROM document_sessions WHERE status = 'active';")
    assert.equal(Number(sessions[0].count), expectedSessions)
    const replay = await browser.scanTabs(count, {batchSize: 128, offset, observation: index => ({...browser.observation(index + offset), document_id: `scan-${count}-${index}`, url: fixture.observation.url})})
    assert.deepEqual({count: replay.count, messages: replay.messages, peakBatchSize: replay.peakBatchSize}, {count: scan.count, messages: scan.messages, peakBatchSize: scan.peakBatchSize})
    const replaySessions = await sqlite(fixture.world.databasePath, "SELECT count(*) AS count FROM document_sessions WHERE status = 'active';")
    assert.equal(Number(replaySessions[0].count), expectedSessions)
    evidence.push({count, peak_batch_size: scan.peakBatchSize, live_active_sessions: expectedSessions, batches: scan.messages})
    await fixture.recorder.producers.world.event("scan.boundary.measured", evidence.at(-1))
  }

  const replacement = {...browser.observation(2_000), url: fixture.observation.url, tab_id: 2_000, document_id: "scan-replacement", title: "Replacement"}
  await browser.observe([replacement, replacement])
  const coalesced = await sqlite(fixture.world.databasePath, "SELECT count(*) AS count FROM document_sessions WHERE tab_id = 2000 AND status = 'active';")
  assert.equal(Number(coalesced[0].count), 1)
  assert.deepEqual(evidence.map(item => item.count), [10, 100, 1000])
  if (process.env.WEBBY_STRESS_PROCESS_NONCE) console.log(`WEBBY_STRESS_MEASUREMENT=${JSON.stringify({scan_tabs: evidence.map(item => item.count)})}`)
})

test("reverse completions, stale socket callbacks, and live channel replacement preserve generation and identity", {timeout: 120_000}, async t => {
  const fixture = await openCapacityFixture(t, "protocol-generation-ordering")
  const original = fixture.browsers[0].browser
  const entry = fixture.credentials[0]
  const reverseBatch = await beginAdmittedCalls(fixture, 10, {idPrefix: "reverse", batchSize: 2})
  const calls = reverseBatch.calls; const requests = reverseBatch.requests
  for (const call of [...calls].reverse()) await original.result(call.call_id, {index: call.arguments.index})
  const responses = await Promise.all(requests)
  assert.deepEqual(responses.map(response => toolOutcome(response).value.index), Array.from({length: 10}, (_, index) => index))

  const oldGeneration = original.generation
  const stale = new Promise(resolve => original.once("stale_frame", resolve))
  await original.handleFrame({topic: original.topic, event: "message", payload: {protocol_version: 1, type: "heartbeat", request_id: "stale", payload: {received: "stale"}}}, oldGeneration - 1)
  assert.equal((await stale).payload.request_id, "stale")

  const pendingArrival = eventBarrier(original, "tool.call", 1)
  const session = entry.sessions[0]
  const pending = entry.client.call({action: "page.call", params: {page: fixture.registrationId, session: session.id, tool: "tool_0", catalog_revision: session.catalog_revision, arguments: {phase: "replacement"}}}, {id: "channel-replacement"})
  const [pendingCall] = await pendingArrival
  const replacement = new SimulatedBrowser({baseUrl: fixture.world.baseUrl, identity: original.identity, browserId: original.browserId, producer: fixture.recorder.producers.protocol, timeoutMs: 30_000})
  t.after(() => replacement.close())
  await replacement.authenticate(original.browserId)
  assert.deepEqual(toolOutcome(await pending), {state: "rejected", kind: "stale_document"})
  await assert.rejects(original.result(pendingCall.call_id, {late: true}), error => error.code === "call_not_pending")
  assert.equal(replacement.browserId, original.browserId)
  assert.notEqual(replacement.generation, 0)
  await fixture.recorder.producers.world.event("ordering.generation.measured", {reverse_completions: 10, stale_callback: "rejected", replacement: "authenticated", terminal: "stale_document", late_result: "rejected"})
})
