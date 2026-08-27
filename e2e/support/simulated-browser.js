import {EventEmitter} from "node:events"
import {randomUUID} from "node:crypto"
import {Ed25519Identity} from "./ed25519-identity.js"
import {PhoenixWire, WireError} from "./phoenix-wire.js"

export const SERVER_ENVELOPE_RESPONSES = Object.freeze({
  "pairing.pending": "pairing.status", "pairing.approved": "reconnect.auth", "pairing.rejected": "terminal", "pairing.expired": "terminal", "pairing.capacity": "terminal",
  "pairing.status": "none", "auth.challenge": "auth.respond", "auth.accepted": "browser.hello", "auth.failed": "terminal", "browser.welcome": "browser.resync",
  acknowledgement: "none", "protocol.error": "terminal_or_retry", "tool.call": "tool.result_or_error", "tool.cancel": "suppress_result", heartbeat: "heartbeat_ack",
  "transport.join_rejected": "terminal", "transport.close": "reconnect_or_terminal",
})
const serverTypes = new Set(Object.keys(SERVER_ENVELOPE_RESPONSES).filter(type => !type.startsWith("transport.")))
const boundedId = value => typeof value === "string" && Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 128
function validServerPayload(type, payload) {
  if (type.startsWith("pairing.")) return typeof payload.status === "string" || type === "pairing.approved" && boundedId(payload.browser_id)
  if (type === "auth.challenge") return boundedId(payload.challenge_id) && typeof payload.signed_message === "string"
  if (type === "auth.accepted") return boundedId(payload.browser_id)
  if (type === "auth.failed" || type === "protocol.error") return typeof payload.kind === "string"
  if (type === "browser.welcome") return Number.isInteger(payload.heartbeat_interval_ms) && typeof payload.resync_required === "boolean"
  if (type === "acknowledgement" || type === "heartbeat") return typeof payload.received === "string"
  if (type === "tool.call" || type === "tool.cancel") return boundedId(payload.call_id)
  return false
}

function envelope(type, payload, browserId, requestId = randomUUID()) {
  return {protocol_version: 1, type, request_id: requestId, browser_id: browserId, sent_at: new Date().toISOString(), payload}
}

export class DeterministicGate {
  constructor(open = false) { this.waiters = []; this.open = open }
  wait() { return this.open ? Promise.resolve() : new Promise(resolve => this.waiters.push(resolve)) }
  block() { this.open = false }
  release(count = Infinity) { while (this.waiters.length && count-- > 0) this.waiters.shift()(); if (count > 0) this.open = true }
}

export class SimulatedBrowser extends EventEmitter {
  constructor({baseUrl, identity = new Ed25519Identity(), browserId, producer, timeoutMs = 10_000, limits = {}} = {}) {
    super(); this.baseUrl = baseUrl; this.identity = identity; this.browserId = browserId; this.producer = producer; this.timeoutMs = timeoutMs; this.limits = limits
    this.generation = 0; this.joinRef = undefined; this.topic = undefined; this.calls = new Map(); this.observations = new Map(); this.settings = {scanning_mode: "granted_sites", scanning_paused: false}
    this.seenServerRequests = new Set(); this.lastServerSequence = -1; this.serverEnvelopeCount = 0
    this.gates = Object.fromEntries(["join", "inbound", "result", "navigation", "cancel", "disconnect", "replacement", "backoff", "identity", "tab"].map(name => [name, new DeterministicGate(true)]))
  }

  socketUrl({extensionId = this.identity.extensionId, browserId = this.browserId} = {}) {
    const url = new URL("/browser/websocket", this.baseUrl); url.protocol = "ws:"; url.searchParams.set("vsn", "2.0.0"); url.searchParams.set("extension_id", extensionId); if (browserId) url.searchParams.set("browser_id", browserId); return url
  }

  async replaceIdentity(identity) {
    if (!(identity instanceof Ed25519Identity)) throw new WireError("invalid_identity")
    await this.gates.identity.wait(); this.identity = identity; this.browserId = undefined; return identity.extensionId
  }

  async connect({origin = `chrome-extension://${this.identity.extensionId}`, extensionId = this.identity.extensionId, browserId = this.browserId} = {}) {
    const generation = ++this.generation
    const wire = new PhoenixWire({url: this.socketUrl({extensionId, browserId}), origin, producer: this.producer, timeoutMs: this.timeoutMs, ...this.limits})
    wire.on("error", error => this.emit("protocol_error", error)); wire.on("close", () => this.emit("disconnect", {generation}))
    wire.on("frame", frame => this.handleFrame(frame, generation).catch(error => this.emit("protocol_error", error)))
    await wire.connect(); if (generation !== this.generation) { await wire.close(); throw new WireError("stale_socket") }
    this.wire = wire; this.topic = browserId ? "browser:auth" : `browser:pairing:${extensionId}`
    await this.gates.join.wait()
    const reply = await wire.push(this.topic, "phx_join", browserId ? {browser_id: browserId} : {})
    this.joinRef = String(wire.ref)
    await this.producer?.event("browser.joined", {topic: this.topic, generation})
    return reply
  }

  async pair(options) {
    const reply = await this.message("pairing.request", this.identity.pairingPayload(options))
    if (reply?.type !== "pairing.pending") throw new WireError("unexpected_pairing_reply")
    this.pairingId = reply.payload.pairing_id; this.emit("pairing.pending", reply.payload); return reply.payload
  }

  pairingStatus() { return this.message("pairing.status", {pairing_id: this.pairingId}) }

  async authenticate(browserId = this.browserId) {
    this.browserId = browserId
    if (this.wire && !this.wire.closed) await this.wire.close()
    const challengeEnvelope = await this.connect({browserId})
    if (challengeEnvelope?.type !== "auth.challenge") throw new WireError("missing_auth_challenge")
    this.lastChallenge = challengeEnvelope.payload
    const signature = this.identity.signChallenge(challengeEnvelope.payload)
    const accepted = await this.message("auth.respond", {challenge_id: challengeEnvelope.payload.challenge_id, signature})
    if (accepted?.type !== "auth.accepted") throw new WireError("authentication_rejected")
    const welcome = await this.message("browser.hello", {})
    if (welcome?.type !== "browser.welcome") throw new WireError("missing_browser_welcome")
    this.emit("authenticated", {browserId, welcome: welcome.payload}); return welcome.payload
  }

  async message(type, payload, {requestId = randomUUID()} = {}) {
    return this.wire.push(this.topic, "message", envelope(type, payload, this.browserId, requestId), {joinRef: this.joinRef})
  }
  heartbeat() { return this.wire.heartbeat() }
  settingsUpdate(settings) { this.settings = {...this.settings, ...settings}; return this.message("browser.settings", this.settings) }
  resync(observations = [...this.observations.values()]) { return this.message("browser.resync", {observations}) }
  observe(observations) { for (const item of observations) this.observations.set(`${item.tab_id}:${item.document_id}`, item); return this.message("discovery.observed", {observations}) }
  closeSession(tabId, documentId) { this.observations.delete(`${tabId}:${documentId}`); return this.message("session.closed", {tab_id: tabId, document_id: documentId}) }

  observation(index, {toolCount = 1, origin = "https://fixture.test"} = {}) {
    return {url: `${origin}/page/${index}`, title: `Fixture ${index}`, tab_id: index, document_id: `document-${index}`, tools: Array.from({length: toolCount}, (_, tool) => ({name: `tool_${tool}`, description: "fixture", inputSchema: {type: "object"}}))}
  }

  async handleFrame(frame, generation) {
    if (generation !== this.generation) { this.emit("stale_frame", frame); return }
    await this.gates.inbound.wait()
    if (frame.topic !== this.topic || frame.event !== "message") { this.emit("unexpected_frame", frame); return }
    const message = frame.payload
    if (!message || message.protocol_version !== 1 || typeof message.type !== "string" || !message.payload || typeof message.payload !== "object" || Array.isArray(message.payload)) { this.emit("protocol_error", new WireError("invalid_server_envelope")); return }
    if (!serverTypes.has(message.type)) { this.emit("protocol_error", new WireError("unknown_server_message")); return }
    if (!validServerPayload(message.type, message.payload)) { this.emit("protocol_error", new WireError("invalid_server_payload")); return }
    if (++this.serverEnvelopeCount > (this.limits.maxServerEnvelopes ?? 2_000)) { this.emit("protocol_error", new WireError("server_envelope_limit")); return }
    if (message.request_id && this.seenServerRequests.has(message.request_id)) { this.emit("protocol_error", new WireError("duplicate_server_envelope")); return }
    if (message.request_id) this.seenServerRequests.add(message.request_id)
    if (Number.isInteger(message.sequence)) {
      if (message.sequence <= this.lastServerSequence) { this.emit("protocol_error", new WireError(message.sequence === this.lastServerSequence ? "duplicate_server_envelope" : "reordered_server_envelope")); return }
      this.lastServerSequence = message.sequence
    }
    if (message.type === "pairing.approved") { this.browserId = message.payload.browser_id; this.emit("pairing.approved", message.payload) }
    else if (message.type.startsWith("pairing.")) this.emit(message.type, message.payload)
    else if (message.type === "tool.call") { this.calls.set(message.payload.call_id, {state: "pending", payload: message.payload}); this.emit("tool.call", message.payload) }
    else if (message.type === "tool.cancel") { await this.gates.cancel.wait(); const call = this.calls.get(message.payload.call_id); if (call) call.state = "cancelled"; this.emit("tool.cancel", message.payload) }
    else this.emit(message.type, message.payload)
  }

  async result(callId, result) {
    await this.gates.result.wait(); const call = this.calls.get(callId)
    if (!call || call.state !== "pending") throw new WireError("call_not_pending")
    const reply = await this.message("tool.result", {call_id: callId, result}); call.state = "completed"; return reply
  }
  async toolError(callId, kind, message) {
    await this.gates.result.wait(); const call = this.calls.get(callId)
    if (!call || call.state !== "pending") throw new WireError("call_not_pending")
    const reply = await this.message("tool.error", {call_id: callId, error: {kind, message}}); call.state = "completed"; return reply
  }

  waitFor(type, predicate = () => true, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.off(type, listener); reject(new WireError("event_timeout", `timed out waiting for ${type}`)) }, timeoutMs)
      const listener = value => { if (!predicate(value)) return; clearTimeout(timer); this.off(type, listener); resolve(value) }
      this.on(type, listener)
    })
  }

  async reconnect(options = {}) { const attempts = options.attempts ?? 3; const wait = options.waitForBackoff ?? (() => this.gates.backoff.wait()); let last
    for (let attempt = 0; attempt < attempts; attempt++) { if (attempt) await wait(attempt, last); try { return await this.connect(options) } catch (error) { last = error } }
    throw last
  }
  async disconnect() { await this.gates.disconnect.wait(); this.generation++; await this.wire?.close() }
  async replace(options = {}) { await this.gates.replacement.wait(); await this.disconnect(); return this.connect(options) }
  async navigate(observation) { await this.gates.navigation.wait(); return this.observe([observation]) }
  async simulateTabs(count, {concurrency = 32, reverse = false, action = async observation => observation} = {}) {
    if (!Number.isInteger(count) || count < 0 || count > 1_000) throw new WireError("tab_count_limit")
    await this.gates.tab.wait(); let next = 0; let active = 0; let peak = 0; const completed = []
    const workers = Array.from({length: Math.min(concurrency, count)}, async () => { for (;;) { const index = next++; if (index >= count) return; active++; peak = Math.max(peak, active); const value = await action(this.observation(index)); active--; completed.push({index, value}) } })
    await Promise.all(workers); completed.sort((a, b) => reverse ? b.index - a.index : a.index - b.index); return {peakConcurrency: peak, completed}
  }
  async close() { await this.disconnect(); this.calls.clear() }
}
