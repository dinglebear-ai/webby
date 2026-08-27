import assert from "node:assert/strict"
import {createHash, verify} from "node:crypto"
import {createServer} from "node:net"
import test from "node:test"
import {Ed25519Identity} from "../support/ed25519-identity.js"
import {PhoenixWire, WireError, decodeJson, encodeFrame} from "../support/phoenix-wire.js"

test("Ed25519 identities expose raw public keys, Chrome IDs, and sign exact production challenge bytes", () => {
  const identity = new Ed25519Identity()
  assert.equal(Buffer.from(identity.publicKeyEncoded, "base64url").length, 32)
  assert.match(identity.extensionId, /^[a-p]{32}$/)
  const challenge = {challenge_id: "challenge", signed_message: "webby-browser-auth-v1\nbrowser\nchallenge\nnonce\ninstance"}
  const signature = Buffer.from(identity.signChallenge(challenge), "base64url")
  assert.equal(signature.length, 64)
  assert.equal(verify(null, Buffer.from(challenge.signed_message), identity.publicKey, signature), true)
  assert.equal(verify(null, Buffer.from(challenge.signed_message + "x"), identity.publicKey, signature), false)
})

test("JSON admission rejects invalid UTF-8, duplicate keys, depth, partial input, and oversized frames", () => {
  assert.throws(() => decodeJson(Buffer.from([0xc3, 0x28])), error => error.code === "invalid_utf8")
  assert.throws(() => decodeJson(Buffer.from('{"x":1,"x":2}')), error => error.code === "duplicate_json_key")
  assert.throws(() => decodeJson(Buffer.from("[[[[0]]]]"), {maxDepth: 2}), error => error.code === "json_depth_limit")
  assert.throws(() => decodeJson(Buffer.from('{"x":')), error => ["invalid_json", "partial_json"].includes(error.code))
  assert.throws(() => decodeJson(Buffer.from('"12345"'), {maxBytes: 4}), error => error.code === "frame_size_limit")
  assert.deepEqual(decodeJson(Buffer.from('[null,"1","topic","event",{}]')), [null, "1", "topic", "event", {}])
  assert.equal(decodeJson(Buffer.from(`"${"x".repeat(262_142)}"`), {maxBytes: 262_144}).length, 262_142)
  assert.throws(() => decodeJson(Buffer.from(`"${"x".repeat(262_143)}"`), {maxBytes: 262_144}), error => error.code === "frame_size_limit")
})

async function wireServer(t) {
  const sockets = new Set(); let resolveSocket
  const accepted = new Promise(resolve => { resolveSocket = resolve })
  const server = createServer(socket => {
    sockets.add(socket); let handshake = Buffer.alloc(0)
    socket.on("error", () => {})
    socket.on("data", chunk => {
      if (handshake === null) return
      handshake = Buffer.concat([handshake, chunk]); const end = handshake.indexOf("\r\n\r\n"); if (end < 0) return
      const head = handshake.subarray(0, end).toString(); const key = head.match(/Sec-WebSocket-Key:\s*(.+)\r\n/i)?.[1]
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      handshake = null; resolveSocket(socket)
    })
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close() })
  return {url: `ws://127.0.0.1:${server.address().port}/socket`, accepted}
}

test("wire parser handles partial delivery and rejects compressed, masked, flooded, and incomplete server frames", async t => {
  const fixture = await wireServer(t); const events = []
  const wire = new PhoenixWire({url: fixture.url, origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", maxNotifications: 1})
  wire.on("error", error => events.push(error.code)); await wire.connect(); const socket = await fixture.accepted
  const valid = encodeFrame(JSON.stringify([null, null, "topic", "message", {ok: true}]), {masked: false})
  socket.write(valid.subarray(0, 3)); socket.write(valid.subarray(3))
  await new Promise(resolve => wire.once("frame", resolve))
  socket.write(valid); socket.write(valid)
  await new Promise(resolve => wire.once("close", resolve))
  assert.ok(events.includes("notification_rate_limit"))

  const compressedFixture = await wireServer(t); const compressed = new PhoenixWire({url: compressedFixture.url, origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}); const compressedErrors = []
  compressed.on("error", error => compressedErrors.push(error.code)); await compressed.connect(); (await compressedFixture.accepted).write(encodeFrame("{}", {masked: false, rsv: 1}))
  await new Promise(resolve => compressed.once("close", resolve)); assert.ok(compressedErrors.includes("compressed_or_reserved_frame"))

  const partialFixture = await wireServer(t); const partial = new PhoenixWire({url: partialFixture.url, origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}); const partialErrors = []
  partial.on("error", error => partialErrors.push(error.code)); await partial.connect(); const partialSocket = await partialFixture.accepted
  partialSocket.write(valid.subarray(0, 4)); partialSocket.destroy()
  await new Promise(resolve => partial.once("close", resolve)); assert.ok(partialErrors.includes("incomplete_close"))

  const maskedFixture = await wireServer(t); const masked = new PhoenixWire({url: maskedFixture.url, origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}); const maskedErrors = []
  masked.on("error", error => maskedErrors.push(error.code)); await masked.connect(); (await maskedFixture.accepted).write(encodeFrame("{}", {masked: true}))
  await new Promise(resolve => masked.once("close", resolve)); assert.ok(maskedErrors.includes("masked_server_frame"))

  const tupleFixture = await wireServer(t); const tuple = new PhoenixWire({url: tupleFixture.url, origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}); const tupleErrors = []
  tuple.on("error", error => tupleErrors.push(error.code)); await tuple.connect(); (await tupleFixture.accepted).write(encodeFrame('{"not":"a tuple"}', {masked: false}))
  await new Promise(resolve => tuple.once("close", resolve)); assert.ok(tupleErrors.includes("invalid_phoenix_frame"))
})

test("recorder backpressure prevents an outbound frame from becoming unaccounted", async t => {
  const fixture = await wireServer(t); let events = 0
  const producer = {event: async type => { events++; if (type === "wire.outbound") throw new WireError("artifact_overflow") }}
  const wire = new PhoenixWire({url: fixture.url, origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", producer})
  wire.on("error", () => {}); await wire.connect(); await fixture.accepted
  await assert.rejects(wire.push("topic", "event", {}), error => error.code === "artifact_overflow")
  assert.equal(events, 2); assert.equal(wire.closed, true)
})
