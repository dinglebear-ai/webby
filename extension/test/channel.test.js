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

test("drops malformed and wrong-topic frames and contains async event failures", async () => {
  const channel = new WebbyChannel({
    baseUrl: "http://127.0.0.1:6477",
    extensionId: "a",
    onEvent: async () => { throw new Error("handler failed"); }
  });
  channel.topic = "browser:auth";
  assert.doesNotThrow(() => channel.receive(null));
  assert.doesNotThrow(() => channel.receive([null, "1", "other", "message", {}]));
  assert.doesNotThrow(() => channel.receive([null, "1", "browser:auth", "message", {}]));
  await new Promise((resolve) => setImmediate(resolve));
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
