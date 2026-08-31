import {createHash, randomBytes} from "node:crypto"
import {EventEmitter} from "node:events"
import {connect as tcpConnect} from "node:net"
import {TextDecoder} from "node:util"

const fatalUtf8 = new TextDecoder("utf-8", {fatal: true})
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

export class WireError extends Error {
  constructor(code, message = code) { super(message); this.name = "WireError"; this.code = code }
}

function encodeFrame(payload, {opcode = 1, fin = true, masked = true, rsv = 0} = {}) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const extended = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8
  const header = Buffer.alloc(2 + extended + (masked ? 4 : 0))
  header[0] = (fin ? 0x80 : 0) | ((rsv & 7) << 4) | opcode
  header[1] = (masked ? 0x80 : 0) | (extended ? (extended === 2 ? 126 : 127) : payload.length)
  let offset = 2
  if (extended === 2) { header.writeUInt16BE(payload.length, offset); offset += 2 }
  if (extended === 8) { header.writeBigUInt64BE(BigInt(payload.length), offset); offset += 8 }
  if (!masked) return Buffer.concat([header, payload])
  const mask = randomBytes(4); mask.copy(header, offset)
  const encoded = Buffer.alloc(payload.length)
  for (let index = 0; index < payload.length; index++) encoded[index] = payload[index] ^ mask[index & 3]
  return Buffer.concat([header, encoded])
}

function inspectJson(text, maxDepth) {
  let index = 0
  function whitespace() { while (/\s/.test(text[index] ?? "")) index++ }
  function string() {
    if (text[index++] !== '"') throw new WireError("invalid_json")
    let escaped = false
    while (index < text.length) {
      const char = text[index++]
      if (!escaped && char === '"') return
      if (!escaped && char.charCodeAt(0) < 0x20) throw new WireError("invalid_json")
      if (!escaped && char === "\\") escaped = true
      else escaped = false
    }
    throw new WireError("partial_json")
  }
  function value(depth) {
    if (depth > maxDepth) throw new WireError("json_depth_limit")
    whitespace(); const char = text[index]
    if (char === '"') return string()
    if (char === "[") {
      index++; whitespace(); if (text[index] === "]") { index++; return }
      for (;;) { value(depth + 1); whitespace(); if (text[index++] === "]") return; if (text[index - 1] !== ",") throw new WireError("invalid_json") }
    }
    if (char === "{") {
      index++; whitespace(); const keys = new Set(); if (text[index] === "}") { index++; return }
      for (;;) {
        const start = index; string(); const raw = text.slice(start, index); let key
        try { key = JSON.parse(raw) } catch { throw new WireError("invalid_json") }
        if (keys.has(key)) throw new WireError("duplicate_json_key"); keys.add(key)
        whitespace(); if (text[index++] !== ":") throw new WireError("invalid_json"); value(depth + 1); whitespace()
        if (text[index++] === "}") return; if (text[index - 1] !== ",") throw new WireError("invalid_json"); whitespace()
      }
    }
    const match = text.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)
    if (!match) throw new WireError("invalid_json"); index += match[0].length
  }
  value(0); whitespace(); if (index !== text.length) throw new WireError("invalid_json")
}

export function decodeJson(bytes, {maxBytes = 1_048_576, maxDepth = 32} = {}) {
  if (bytes.length > maxBytes) throw new WireError("frame_size_limit")
  let text
  try { text = fatalUtf8.decode(bytes) } catch { throw new WireError("invalid_utf8") }
  inspectJson(text, maxDepth)
  return JSON.parse(text)
}

export class PhoenixWire extends EventEmitter {
  constructor({url, origin, producer, timeoutMs = 10_000, maxFrameBytes = 262_144, maxDepth = 64, maxPending = 256, maxNotifications = 2_000} = {}) {
    super(); this.url = new URL(url); this.origin = origin; this.producer = producer
    this.timeoutMs = timeoutMs; this.maxFrameBytes = maxFrameBytes; this.maxDepth = maxDepth; this.maxPending = maxPending; this.maxNotifications = maxNotifications
    this.ref = 0; this.pending = new Map(); this.buffer = Buffer.alloc(0); this.fragments = []; this.fragmentBytes = 0; this.notifications = 0; this.processing = Promise.resolve(); this.closed = false
  }

  async connect() {
    if (this.url.protocol !== "ws:" || this.url.hostname !== "127.0.0.1") throw new WireError("unsafe_websocket_url")
    const key = randomBytes(16).toString("base64")
    this.socket = tcpConnect({host: this.url.hostname, port: Number(this.url.port)})
    await new Promise((resolve, reject) => { this.socket.once("connect", resolve); this.socket.once("error", reject) })
    const request = [`GET ${this.url.pathname}${this.url.search} HTTP/1.1`, `Host: ${this.url.host}`, "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", `Origin: ${this.origin}`, "\r\n"].join("\r\n")
    this.socket.write(request)
    let handshake = Buffer.alloc(0)
    let remainder
    try { remainder = await new Promise((resolve, reject) => {
      const onData = chunk => {
        handshake = Buffer.concat([handshake, chunk]); if (handshake.length > 16_384) return reject(new WireError("handshake_size_limit"))
        const end = handshake.indexOf("\r\n\r\n"); if (end < 0) return
        this.socket.off("data", onData); const head = handshake.subarray(0, end).toString("latin1"); const lines = head.split("\r\n")
        const status = Number(lines[0].split(" ")[1]); const headers = Object.fromEntries(lines.slice(1).map(line => { const split = line.indexOf(":"); return [line.slice(0, split).toLowerCase(), line.slice(split + 1).trim()] }))
        if (status !== 101) return reject(new WireError("websocket_handshake_rejected", `handshake returned ${status}`))
        const expected = createHash("sha1").update(key + websocketGuid).digest("base64")
        if (headers["sec-websocket-accept"] !== expected) return reject(new WireError("invalid_websocket_accept"))
        resolve(handshake.subarray(end + 4))
      }
      this.socket.on("data", onData); this.socket.once("error", reject); this.socket.once("close", () => reject(new WireError("incomplete_handshake")))
    }) } catch (error) { this.socket.destroy(); throw error }
    this.socket.on("data", chunk => this.feed(chunk)); this.socket.on("close", () => this.onClose()); this.socket.on("error", error => this.fail(error))
    await this.producer?.event("wire.connected", {origin: this.origin, path: this.url.pathname})
    if (remainder.length) this.feed(remainder)
    return this
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    try {
      for (;;) {
        if (this.buffer.length < 2) return
        const first = this.buffer[0]; const second = this.buffer[1]; let length = second & 0x7f; let offset = 2
        if (first & 0x70) throw new WireError("compressed_or_reserved_frame")
        if (second & 0x80) throw new WireError("masked_server_frame")
        if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4 }
        else if (length === 127) { if (this.buffer.length < 10) return; const wide = this.buffer.readBigUInt64BE(2); if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new WireError("frame_size_limit"); length = Number(wide); offset = 10 }
        if (length > this.maxFrameBytes || this.fragmentBytes + length > this.maxFrameBytes) throw new WireError("frame_size_limit")
        if (this.buffer.length < offset + length) return
        const payload = this.buffer.subarray(offset, offset + length); this.buffer = this.buffer.subarray(offset + length)
        this.acceptFrame(first & 0xf, Boolean(first & 0x80), payload)
      }
    } catch (error) { this.fail(error) }
  }

  acceptFrame(opcode, fin, payload) {
    if (opcode >= 8) {
      if (!fin || payload.length > 125) throw new WireError("invalid_control_frame")
      if (opcode === 8) { this.socket.end(encodeFrame(payload, {opcode: 8})); this.onClose(); return }
      if (opcode === 9) { this.socket.write(encodeFrame(payload, {opcode: 10})); return }
      if (opcode === 10) return
      throw new WireError("unknown_websocket_opcode")
    }
    if (opcode === 1) { if (this.fragments.length) throw new WireError("fragment_sequence_error"); this.fragments = [payload]; this.fragmentBytes = payload.length }
    else if (opcode === 0) { if (!this.fragments.length) throw new WireError("fragment_sequence_error"); this.fragments.push(payload); this.fragmentBytes += payload.length }
    else throw new WireError("binary_frame_rejected")
    if (!fin) return
    const message = Buffer.concat(this.fragments); this.fragments = []; this.fragmentBytes = 0
    this.processing = this.processing.then(() => this.receive(message)).catch(error => this.fail(error))
  }

  async receive(bytes) {
    const frame = decodeJson(bytes, {maxBytes: this.maxFrameBytes, maxDepth: this.maxDepth})
    if (!Array.isArray(frame) || frame.length !== 5) throw new WireError("invalid_phoenix_frame")
    const [joinRef, ref, topic, event, payload] = frame
    if ((joinRef !== null && typeof joinRef !== "string") || (ref !== null && typeof ref !== "string") || typeof topic !== "string" || typeof event !== "string" || payload === null || typeof payload !== "object") throw new WireError("invalid_phoenix_frame")
    await this.producer?.event("wire.inbound", {join_ref: joinRef, ref, topic, event, bytes: bytes.length})
    if (event === "phx_reply" && ref && this.pending.has(ref)) {
      const pending = this.pending.get(ref); this.pending.delete(ref); clearTimeout(pending.timer)
      if (!payload || !["ok", "error"].includes(payload.status)) pending.reject(new WireError("malformed_channel_reply"))
      else payload.status === "ok" ? pending.resolve(payload.response) : pending.reject(Object.assign(new WireError("channel_reply_error"), {response: payload.response}))
      return
    }
    if (++this.notifications > this.maxNotifications) throw new WireError("notification_rate_limit")
    this.emit("frame", {joinRef, ref, topic, event, payload})
  }

  async push(topic, event, payload, {joinRef = null, awaitReply = true} = {}) {
    if (this.closed || !this.socket?.writable) return Promise.reject(new WireError("channel_closed"))
    if (awaitReply && this.pending.size >= this.maxPending) return Promise.reject(new WireError("pending_limit"))
    const ref = String(++this.ref); const frame = [joinRef, ref, topic, event, payload]; const bytes = Buffer.from(JSON.stringify(frame))
    if (bytes.length > this.maxFrameBytes) return Promise.reject(new WireError("frame_size_limit"))
    try { await this.producer?.event("wire.outbound", {join_ref: joinRef, ref, topic, event, bytes: bytes.length}) }
    catch (error) { this.fail(error); throw error }
    if (this.closed || !this.socket?.writable) throw new WireError("channel_closed")
    this.socket.write(encodeFrame(bytes))
    if (!awaitReply) return Promise.resolve(ref)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(ref); reject(new WireError("channel_reply_timeout")) }, this.timeoutMs)
      this.pending.set(ref, {resolve, reject, timer})
    })
  }

  raw(bytes) { this.socket.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) }
  rawText(text, options) { this.socket.write(encodeFrame(Buffer.from(text), options)) }
  heartbeat() { return this.push("phoenix", "heartbeat", {}, {awaitReply: true}) }

  async close(code = 1000) {
    if (this.closed) return
    this.closed = true; this.socket?.end(encodeFrame(Buffer.from([code >> 8, code & 0xff]), {opcode: 8})); this.rejectPending(new WireError("channel_closed"))
    await this.producer?.event("wire.closed", {code})
  }
  rejectPending(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) } this.pending.clear() }
  onClose() {
    if (this.closed) return
    if (this.buffer.length || this.fragments.length) this.emit("error", new WireError("incomplete_close"))
    this.closed = true; this.rejectPending(new WireError("channel_disconnected")); this.emit("close")
  }
  fail(error) { if (this.closed) return; this.emit("error", error); this.closed = true; this.rejectPending(error); this.socket?.destroy(); this.emit("close") }
}

export {encodeFrame}
