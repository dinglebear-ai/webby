import test from "node:test";
import assert from "node:assert/strict";
import {WebbyChannel} from "../src/channel.js";

test("uses the stable Phoenix join reference and delivers the auth challenge", async () => {
  const frames = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { queueMicrotask(() => this.onopen()); }
    send(value) { frames.push(JSON.parse(value)); }
    close() {}
  }
  globalThis.WebSocket = FakeWebSocket;

  let challenge;
  const channel = new WebbyChannel({
    baseUrl: "http://127.0.0.1:6477",
    extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    browserId: "browser-1",
    onChallenge: async (value) => { challenge = value; }
  });
  channel.connect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const join = frames[0];
  channel.receive([join[0], join[1], join[2], "phx_reply", {status: "ok", response: {type: "auth.challenge", payload: {challenge_id: "one"}}}]);
  const messageReply = channel.message("browser.hello", {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const message = frames[1];
  assert.deepEqual(challenge, {challenge_id: "one"});
  assert.equal(message[0], join[0]);
  assert.notEqual(message[1], join[1]);
  channel.receive([message[0], message[1], message[2], "phx_reply", {status: "ok", response: {}}]);
  await messageReply;
  channel.close();
});

test("rejects and removes requests that exceed the reply deadline", async () => {
  const channel = new WebbyChannel({
    baseUrl: "http://127.0.0.1:6477",
    extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    replyTimeoutMs: 5
  });
  channel.socket = {send() {}};
  channel.topic = "browser:auth";
  channel.joinRef = "1";

  await assert.rejects(channel.sendFrame("message", {}), /channel_reply_timeout/);
  assert.equal(channel.pending.size, 0);
});

test("a join timeout rejects readiness instead of leaving later messages pending", async () => {
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { queueMicrotask(() => this.onopen()); }
    send() {}
    close() { this.onclose?.(); }
  }
  globalThis.WebSocket = FakeWebSocket;

  const channel = new WebbyChannel({
    baseUrl: "http://127.0.0.1:6477",
    extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    replyTimeoutMs: 5
  });
  channel.scheduleReconnect = () => {};
  channel.connect();

  await assert.rejects(channel.message("browser.hello", {}), /channel_reply_timeout/);
  assert.equal(channel.pending.size, 0);
  channel.close();
});

test("a socket that closes before joining rejects readiness", async () => {
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    constructor() { queueMicrotask(() => this.onclose()); }
    send() {}
    close() { this.onclose?.(); }
  }
  globalThis.WebSocket = FakeWebSocket;
  const channel = new WebbyChannel({baseUrl: "http://127.0.0.1:6477", extensionId: "a"});
  channel.scheduleReconnect = () => {};
  channel.connect();
  await assert.rejects(channel.message("browser.hello", {}), /channel_disconnected/);
  channel.close();
});

test("ignores callbacks from a superseded socket", async () => {
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { sockets.push(this); }
    send() {}
    close() { this.onclose?.(); }
  }
  globalThis.WebSocket = FakeWebSocket;
  const channel = new WebbyChannel({baseUrl: "http://127.0.0.1:6477", extensionId: "a"});
  channel.scheduleReconnect = () => {};
  channel.connect();
  const first = sockets[0];
  channel.connect();
  const second = sockets[1];
  first.onclose();
  assert.equal(channel.socket, second);
  assert.equal(channel.pending.size, 0);
  channel.close();
});

test("drops malformed and wrong-topic frames and reports async event failures with call identity", async () => {
  const failures = [];
  const channel = new WebbyChannel({
    baseUrl: "http://127.0.0.1:6477",
    extensionId: "a",
    onEvent: async () => { throw new Error("handler failed"); },
    onError: (error, payload) => failures.push({error, payload})
  });
  channel.topic = "browser:auth";
  assert.doesNotThrow(() => channel.receive(null));
  assert.doesNotThrow(() => channel.receive([null, "1", "other", "message", {}]));
  const payload = {type: "tool.call", payload: {call_id: "call-17"}};
  assert.doesNotThrow(() => channel.receive([null, null, "browser:auth", "message", payload]));
  await new Promise((resolve) => setImmediate(resolve));
  const handlerFailure = failures.find(({error}) => error.message === "handler failed");
  assert.ok(handlerFailure);
  assert.equal(handlerFailure.payload.payload.call_id, "call-17");
});

test("rejects a malformed reply without throwing from the frame handler", async () => {
  const channel = new WebbyChannel({baseUrl: "http://127.0.0.1:6477", extensionId: "a"});
  channel.socket = {readyState: 1, send() {}};
  channel.topic = "browser:auth";
  channel.joinRef = "1";
  const pending = channel.sendFrame("message", {});
  const ref = String(channel.ref);
  assert.doesNotThrow(() => channel.receive(["1", ref, "browser:auth", "phx_reply", null]));
  await assert.rejects(pending, /malformed_channel_reply/);
});

test("reports invalid frame shapes and unexpected topics", () => {
  const failures = [];
  const channel = new WebbyChannel({
    baseUrl: "http://127.0.0.1:6477",
    extensionId: "a",
    onError: (error, context) => failures.push({error, context})
  });
  channel.topic = "browser:auth";
  channel.receive(null);
  channel.receive([null, 1, "browser:auth", "message", {}]);
  channel.receive([null, "1", "other", "message", {}]);
  assert.deepEqual(failures.map(({context}) => context.kind), ["invalid_frame", "invalid_frame", "invalid_frame"]);
});

test("reports invalid JSON with raw frame context", async () => {
  let socket;
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { socket = this; }
    send() {}
    close() {}
  }
  globalThis.WebSocket = FakeWebSocket;
  const failures = [];
  const channel = new WebbyChannel({
    baseUrl: "http://127.0.0.1:6477",
    extensionId: "a",
    onError: (error, context) => failures.push({error, context})
  });
  channel.connect();
  socket.onmessage({data: "{not-json"});
  assert.equal(failures[0].context.kind, "invalid_json");
  assert.equal(failures[0].context.data, "{not-json");
  channel.close();
});

test("onReady rejection is reported and closes the socket for reconnect", async () => {
  let socket;
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { socket = this; queueMicrotask(() => this.onopen()); }
    send() {}
    close() { this.closed = true; this.onclose?.(); }
  }
  globalThis.WebSocket = FakeWebSocket;
  const failures = [];
  const channel = new WebbyChannel({
    baseUrl: "http://127.0.0.1:6477",
    extensionId: "a",
    onReady: async () => { throw new Error("settings failed"); },
    onError: (error, context) => failures.push({error, context})
  });
  channel.scheduleReconnect = () => { channel.reconnectScheduled = true; };
  channel.connect();
  await new Promise((resolve) => setImmediate(resolve));
  const ref = String(channel.ref);
  channel.receive([ref, ref, channel.topic, "phx_reply", {status: "ok", response: {}}]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures[0].context.kind, "ready_reconciliation_failed");
  assert.match(failures[0].error.message, /settings failed/);
  assert.equal(socket.closed, true);
  assert.equal(channel.reconnectScheduled, true);
  channel.close();
});
