import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {randomUUID} from "node:crypto"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {promisify} from "node:util"
import test from "node:test"
import {ArtifactRecorder} from "../support/artifacts.js"
import {Ed25519Identity} from "../support/ed25519-identity.js"
import {SERVER_ENVELOPE_RESPONSES, SimulatedBrowser} from "../support/simulated-browser.js"
import {WebbyWorld} from "../support/world.js"

const execFileAsync = promisify(execFile)

async function fixture(t, scenarioId) {
  const root = await mkdtemp(join(tmpdir(), "webby-simulator-test-")); const world = await WebbyWorld.start({scenarioId})
  const recorder = await new ArtifactRecorder({root, scenarioId, worldId: world.worldId, seed: 7, versions: {node: process.version}, secrets: [world.secret, world.telemetryCapability]}).open()
  t.after(async () => { await world.teardown().catch(() => {}); await rm(root, {recursive: true, force: true}) })
  return {world, recorder}
}

async function approveFixturePairing(world, browser, pairingId) {
  const browserId = randomUUID(); const now = new Date().toISOString().replace("T", " ").slice(0, 19); const publicKey = browser.identity.publicKeyRaw.toString("hex")
  const sql = `INSERT INTO browsers(id,display_name,extension_id,public_key,scanning_mode,paired_at,inserted_at,updated_at) VALUES('${browserId}','Simulator','${browser.identity.extensionId}',X'${publicKey}','granted_sites','${now}','${now}','${now}'); UPDATE browser_pairing_requests SET status='approved',browser_id='${browserId}',resolved_at='${now}',updated_at='${now}' WHERE id='${pairingId}';`
  await execFileAsync("sqlite3", [world.databasePath, sql]); return browserId
}

test("real Phoenix v2 pairing, Ed25519 auth, hello, settings, heartbeat, discovery, resync, and closure", {timeout: 90_000}, async t => {
  const {world, recorder} = await fixture(t, "simulated-live")
  const browser = new SimulatedBrowser({baseUrl: world.baseUrl, producer: recorder.producers.protocol})
  await browser.connect(); const pending = await browser.pair({displayName: "Protocol Simulator"})
  assert.match(pending.pairing_id, /^[0-9a-f-]{36}$/)
  let status = await browser.pairingStatus(); assert.equal(status.payload.status, "pending")
  const browserId = await approveFixturePairing(world, browser, pending.pairing_id)
  status = await browser.pairingStatus(); assert.equal(status.payload.status, "approved"); assert.equal(status.payload.browser_id, browserId)
  const welcome = await browser.authenticate(browserId)
  assert.equal(welcome.resync_required, true); assert.equal(welcome.heartbeat_interval_ms, 30_000)
  assert.equal((await browser.settingsUpdate({scanning_mode: "all_tabs", scanning_paused: false})).type, "acknowledgement")
  assert.equal((await browser.heartbeat()).status ?? "ok", "ok")
  assert.equal((await browser.resync([])).payload.observation_count, 0)
  const observation = browser.observation(1, {toolCount: 2})
  assert.equal((await browser.observe([observation])).payload.observation_count, 1)
  assert.equal((await browser.resync([observation])).payload.observation_count, 1)
  assert.equal((await browser.closeSession(1, "document-1")).type, "acknowledgement")
  await assert.rejects(browser.observe([browser.observation(99, {toolCount: 0})]), error => error.code === "channel_reply_error")
  const maximumObservations = Array.from({length: 128}, (_, index) => browser.observation(index + 100, {toolCount: 1}))
  assert.equal((await browser.resync(maximumObservations)).payload.observation_count, 128)
  await assert.rejects(browser.resync([...maximumObservations, browser.observation(999, {toolCount: 1})]), error => error.code === "channel_reply_error")
  assert.equal((await browser.observe([browser.observation(2000, {toolCount: 64})])).payload.observation_count, 1)
  await assert.rejects(browser.observe([browser.observation(2001, {toolCount: 65})]), error => error.code === "channel_reply_error")
  assert.equal((await browser.message("tool.result", {call_id: "c".repeat(128), result: "x".repeat(131_070)})).type, "acknowledgement")
  await assert.rejects(browser.message("tool.result", {call_id: "c".repeat(129), result: null}), error => error.code === "channel_reply_error")
  await assert.rejects(browser.message("tool.result", {call_id: "call", result: "x".repeat(131_071)}), error => error.code === "channel_reply_error")
  const nested = depth => { let value = true; for (let index = 0; index < depth; index++) value = {child: value}; return value }
  assert.equal((await browser.message("tool.result", {call_id: "depth-32", result: nested(32)})).type, "acknowledgement")
  await assert.rejects(browser.message("tool.result", {call_id: "depth-33", result: nested(33)}), error => error.code === "channel_reply_error")
  const replaySignature = browser.identity.signChallenge(browser.lastChallenge)
  await assert.rejects(browser.message("auth.respond", {challenge_id: browser.lastChallenge.challenge_id, signature: replaySignature}), error => error.code === "channel_reply_error")
  await browser.close()
  const result = await recorder.finalize({status: "failed", cleanup: {browser: "closed"}})
  const evidence = Buffer.concat(await Promise.all(result.uploadCandidates.map(path => readFile(path))))
  const privateDer = browser.identity.privateKey.export({format: "der", type: "pkcs8"}).toString("base64")
  assert.equal(evidence.includes(Buffer.from(privateDer)), false)
  assert.equal(evidence.includes(Buffer.from(replaySignature)), false)
})

test("two isolated worlds accept concurrent independent simulator identities", {timeout: 120_000}, async t => {
  const [first, second] = await Promise.all([fixture(t, "simulator-a"), fixture(t, "simulator-b")])
  const browsers = [new SimulatedBrowser({baseUrl: first.world.baseUrl, producer: first.recorder.producers.protocol}), new SimulatedBrowser({baseUrl: second.world.baseUrl, producer: second.recorder.producers.protocol})]
  await Promise.all(browsers.map(browser => browser.connect()))
  const pairings = await Promise.all(browsers.map((browser, index) => browser.pair({displayName: `Simulator ${index}`})))
  assert.notEqual(browsers[0].identity.extensionId, browsers[1].identity.extensionId); assert.notEqual(pairings[0].pairing_id, pairings[1].pairing_id)
  await Promise.all(browsers.map(browser => browser.close())); await Promise.all([first.recorder.finalize(), second.recorder.finalize()])
})

test("Origin and claimed extension identity must match at the real handshake", {timeout: 60_000}, async t => {
  const {world, recorder} = await fixture(t, "simulator-origin")
  const browser = new SimulatedBrowser({baseUrl: world.baseUrl, producer: recorder.producers.protocol})
  await assert.rejects(browser.connect({origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}), error => error.code === "websocket_handshake_rejected")
  const malformed = new SimulatedBrowser({baseUrl: world.baseUrl, producer: recorder.producers.protocol})
  await assert.rejects(malformed.connect({origin: "null", extensionId: "not-an-extension"}), error => error.code === "websocket_handshake_rejected")
  await recorder.journal.close()
})

test("real auth rejects an invalid Ed25519 signature and permits an event-driven reconnect", {timeout: 60_000}, async t => {
  const {world, recorder} = await fixture(t, "simulator-invalid-signature")
  const browser = new SimulatedBrowser({baseUrl: world.baseUrl, producer: recorder.producers.protocol})
  await browser.connect(); const pending = await browser.pair({displayName: "Invalid Signature"}); const browserId = await approveFixturePairing(world, browser, pending.pairing_id)
  await browser.close(); const challenge = await browser.connect({browserId})
  await assert.rejects(browser.message("auth.respond", {challenge_id: challenge.payload.challenge_id, signature: Buffer.alloc(64).toString("base64url")}), error => error.code === "channel_reply_error")
  await browser.close()
  const attempts = []; let connectCount = 0; browser.connect = async () => { attempts.push(`connect-${++connectCount}`); if (connectCount < 3) throw new Error("transient"); return "connected" }
  assert.equal(await browser.reconnect({attempts: 3, waitForBackoff: async attempt => attempts.push(`gate-${attempt}`)}), "connected")
  assert.deepEqual(attempts, ["connect-1", "gate-1", "connect-2", "gate-2", "connect-3"]); await recorder.finalize()
})

test("deterministic gates, stale generations, unknown envelopes, and tool cancel/result ordering are explicit", async () => {
  const events = []; const browser = new SimulatedBrowser({baseUrl: "http://127.0.0.1:1", timeoutMs: 100})
  browser.on("protocol_error", error => events.push(error.code)); browser.on("stale_frame", frame => events.push(frame.payload.type))
  browser.topic = "browser:auth"; browser.generation = 2
  await browser.handleFrame({topic: "browser:auth", event: "message", payload: {protocol_version: 1, type: "future.message", payload: {}}}, 2)
  await browser.handleFrame({topic: "browser:auth", event: "message", payload: {protocol_version: 1, type: "tool.call", payload: {call_id: "stale"}}}, 1)
  await browser.handleFrame({topic: "browser:auth", event: "message", payload: {protocol_version: 1, type: "tool.call", payload: {call_id: "call-1"}}}, 2)
  await browser.handleFrame({topic: "browser:auth", event: "message", payload: {protocol_version: 1, type: "tool.cancel", payload: {call_id: "call-1"}}}, 2)
  assert.deepEqual(events, ["unknown_server_message", "tool.call"]); assert.equal(browser.calls.get("call-1").state, "cancelled")
  await assert.rejects(browser.result("call-1", {ok: true}), error => error.code === "call_not_pending")
  browser.gates.result.block(); let released = false
  browser.calls.set("call-2", {state: "pending"}); browser.message = async () => ({type: "acknowledgement"})
  const pending = browser.result("call-2", {ok: true}).then(() => { released = true })
  await Promise.resolve(); assert.equal(released, false); browser.gates.result.release(); await pending; assert.equal(released, true)
})

test("typed envelope admission, race gates, and downstream behavioral ownership are explicit", async () => {
  assert.deepEqual(Object.keys(SERVER_ENVELOPE_RESPONSES).sort(), ["acknowledgement", "auth.accepted", "auth.challenge", "auth.failed", "browser.welcome", "heartbeat", "pairing.approved", "pairing.capacity", "pairing.expired", "pairing.pending", "pairing.rejected", "pairing.status", "protocol.error", "tool.call", "tool.cancel", "transport.join_rejected", "transport.close"].sort())
  const errors = []; const browser = new SimulatedBrowser({baseUrl: "http://127.0.0.1:1", limits: {maxServerEnvelopes: 3}}); browser.topic = "browser:auth"; browser.generation = 1; browser.on("protocol_error", error => errors.push(error.code))
  const frame = (type, requestId, sequence) => ({topic: "browser:auth", event: "message", payload: {protocol_version: 1, type, request_id: requestId, sequence, payload: {status: "pending"}}})
  await browser.handleFrame(frame("pairing.pending", "one", 1), 1)
  await browser.handleFrame(frame("pairing.pending", "one", 2), 1)
  await browser.handleFrame(frame("pairing.pending", "two", 0), 1)
  await browser.handleFrame({topic: "wrong", event: "message", payload: {}}, 1)
  await browser.handleFrame(frame("pairing.pending", "three", 3), 1)
  await browser.handleFrame(frame("pairing.pending", "four", 4), 1)
  assert.deepEqual(errors, ["duplicate_server_envelope", "reordered_server_envelope", "server_envelope_limit", "server_envelope_limit"])
  const malformed = new SimulatedBrowser({baseUrl: "http://127.0.0.1:1"}); malformed.topic = "browser:auth"; malformed.generation = 1; const malformedErrors = []; malformed.on("protocol_error", error => malformedErrors.push(error.code))
  await malformed.handleFrame({topic: "browser:auth", event: "message", payload: {protocol_version: 1, type: "auth.challenge", payload: {challenge_id: "x".repeat(129), signed_message: "message"}}}, 1)
  assert.deepEqual(malformedErrors, ["invalid_server_payload"])
  for (const gate of ["navigation", "cancel", "disconnect", "replacement", "join", "identity", "tab"]) assert.ok(browser.gates[gate])
  // Beads .13/.14/.16 select exhaustive pairing, security, capacity, cancellation,
  // replacement, and lifecycle matrices; this bead supplies their deterministic primitives.
})

test("10/100/1000 tab primitives record bounded peak concurrency and reverse completion", async () => {
  const browser = new SimulatedBrowser({baseUrl: "http://127.0.0.1:1"})
  for (const count of [10, 100, 1_000]) {
    const run = await browser.simulateTabs(count, {concurrency: 17, reverse: true, action: async observation => observation.tab_id})
    assert.equal(run.completed.length, count); assert.ok(run.peakConcurrency <= 17); assert.equal(run.completed[0].index, count - 1); assert.equal(run.completed.at(-1).index, 0)
  }
  await assert.rejects(browser.simulateTabs(1_001), error => error.code === "tab_count_limit")
})

test("batched live scans maintain the Phoenix heartbeat boundary without changing the discovery denominator", async () => {
  const browser = new SimulatedBrowser({baseUrl: "http://127.0.0.1:1"})
  const batches = []
  let heartbeats = 0
  browser.observe = async observations => { batches.push(observations.map(item => item.tab_id)); return {type: "acknowledgement"} }
  browser.heartbeat = async () => { heartbeats += 1; return {status: "ok"} }
  const result = await browser.scanTabs(1_000, {batchSize: 128})
  assert.equal(result.count, 1_000)
  assert.equal(result.messages, 8)
  assert.equal(batches.length, 8)
  assert.equal(heartbeats, 8)
  assert.deepEqual(batches.map(batch => batch.length), [128, 128, 128, 128, 128, 128, 128, 104])
})

test("identity replacement is deterministically blocked and subsequent connections use the released identity", async () => {
  const browser = new SimulatedBrowser({baseUrl: "http://127.0.0.1:1", browserId: "stale-browser"}); const original = browser.identity; const replacement = new Ed25519Identity()
  browser.gates.identity.block(); let transitioned = false
  const pending = browser.replaceIdentity(replacement).then(extensionId => { transitioned = true; return extensionId })
  await Promise.resolve(); assert.equal(transitioned, false); assert.equal(browser.identity, original); assert.equal(browser.browserId, "stale-browser")
  browser.gates.identity.release(); assert.equal(await pending, replacement.extensionId); assert.equal(browser.identity, replacement); assert.equal(browser.browserId, undefined)
  const url = browser.socketUrl(); assert.equal(url.searchParams.get("extension_id"), replacement.extensionId); assert.equal(url.searchParams.has("browser_id"), false)
  await assert.rejects(browser.replaceIdentity({extensionId: replacement.extensionId}), error => error.code === "invalid_identity")
})
