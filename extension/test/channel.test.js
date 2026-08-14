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
