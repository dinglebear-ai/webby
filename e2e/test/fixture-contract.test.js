import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import http from "node:http";
import {startFixtureServer} from "../fixture/server.js";
import {installWebMcpFixture} from "../fixture/webmcp-fixture.js";
import {FixtureControl, fixtureLimits} from "../fixture/control.js";

async function world(options = {}) {
  const fixture = await startFixtureServer({worldId: `world_${randomUUID().replaceAll("-", "")}`, ...options});
  const request = async (path, {method = "GET", capability = fixture.capability, origin = fixture.origin, host, body, contentType} = {}) => {
    const headers = {origin, authorization: `Bearer ${capability}`, host: host ?? new URL(fixture.origin).host};
    if (contentType !== null && method === "POST") headers["content-type"] = contentType ?? "application/json";
    return fetch(`${fixture.origin}${path}`, {method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)});
  };
  return {fixture, request};
}

function action(actionName, values = {}) { return {action: actionName, nonce: randomUUID(), scenario_id: "scenario_a", call_id: randomUUID(), ...values}; }

test("serves deterministic pages and module without exposing the control capability", async (t) => {
  const {fixture} = await world(); t.after(() => fixture.close());
  for (const path of ["/", "/dynamic", "/navigation", "/webmcp-fixture.js"]) {
    const response = await fetch(`${fixture.origin}${path}`);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(fixture.capability));
  }
  assert.equal((await fetch(`${fixture.origin}/`, {method: "POST"})).status, 405);
});

test("reload and navigation responses carry distinct document instance identities", async (t) => {
  const {fixture} = await world(); t.after(() => fixture.close());
  const instance = async (path) => (await (await fetch(`${fixture.origin}${path}`)).text()).match(/data-document-instance="([^"]+)"/)[1];
  const first = await instance("/");
  const reload = await instance("/");
  const navigation = await instance("/navigation");
  assert.notEqual(first, reload);
  assert.notEqual(reload, navigation);
});

test("publishes a machine-readable browser capability probe contract", async (t) => {
  const {fixture} = await world(); t.after(() => fixture.close());
  const probe = await (await fetch(`${fixture.origin}/__fixture/capabilities`)).json();
  assert.equal(probe.status, "requires_browser");
  assert.deepEqual(probe.required, ["document.modelContext", "chrome.scripting.documentIds", "MAIN_world_execution"]);
  assert.equal(probe.browser_probe.world, "MAIN");
  assert.match(probe.browser_probe.context_expression, /document\.modelContext/);
});

test("control API enforces host origin method content type and capability", async (t) => {
  const {fixture, request} = await world(); t.after(() => fixture.close());
  assert.equal((await request("/__control/events", {capability: "wrong-capability-value-xxxxxxxxxxxxxxxxxxxxxxxx"})).status, 401);
  assert.equal((await request("/__control/events", {origin: "http://127.0.0.1:1"})).status, 403);
  assert.equal((await rawRequest(fixture, "/__control/events", {host: "127.0.0.1:1"})).status, 421);
  assert.equal((await request("/__control/action", {method: "POST", contentType: "text/plain", body: "{}"})).status, 415);
  assert.equal((await request("/__control/events", {method: "POST", body: action("nope")})).status, 405);
  assert.equal((await request("/__control/action", {method: "PUT"})).status, 405);
});

function rawRequest(fixture, path, {host}) {
  const target = new URL(fixture.origin);
  return new Promise((resolve, reject) => {
    const request = http.request({hostname: target.hostname, port: target.port, path, headers: {
      host, origin: fixture.origin, authorization: `Bearer ${fixture.capability}`
    }}, (response) => { response.resume(); response.on("end", () => resolve({status: response.statusCode})); });
    request.on("error", reject); request.end();
  });
}

test("capabilities expire and are isolated between worlds", async (t) => {
  let now = 10;
  const first = await world({capabilityTtlMs: 5, now: () => now});
  const second = await world();
  t.after(() => Promise.all([first.fixture.close(), second.fixture.close()]));
  assert.equal((await second.request("/__control/events", {capability: first.fixture.capability})).status, 401);
  now = 15;
  assert.equal((await first.request("/__control/events")).status, 401);
});

test("barriers use namespaced single-use handles and monotonic events", async (t) => {
  const {fixture, request} = await world(); t.after(() => fixture.close());
  const created = await request("/__control/action", {method: "POST", body: action("barrier.create", {call_id: "call_1"})});
  const {handle} = await created.json();
  assert.ok(handle.startsWith(`${fixture.control.worldId}:`));
  const released = await request("/__control/action", {method: "POST", body: action("barrier.release", {handle})});
  assert.equal(released.status, 200);
  assert.equal((await request("/__control/action", {method: "POST", body: action("barrier.release", {handle})})).status, 400);
  assert.equal((await request("/__control/action", {method: "POST", body: action("barrier.release", {handle: "other:call_1"})})).status, 400);
  const snapshot = await (await request("/__control/events")).json();
  assert.deepEqual(snapshot.events.map(({sequence}) => sequence), Array.from({length: snapshot.events.length}, (_, index) => index + 1));
  assert.deepEqual(snapshot.events.filter(({type}) => type.startsWith("barrier.")).map(({type}) => type), ["barrier.created", "barrier.released"]);
});

test("replayed nonces, oversized bodies, deep JSON, and unknown actions are denied", async (t) => {
  const {fixture, request} = await world(); t.after(() => fixture.close());
  const input = action("event.record", {type: "test"});
  assert.equal((await request("/__control/action", {method: "POST", body: input})).status, 200);
  assert.equal((await request("/__control/action", {method: "POST", body: input})).status, 409);
  assert.equal((await request("/__control/action", {method: "POST", body: action("unknown")})).status, 400);
  let deep = {}; for (let index = 0; index < 18; index += 1) deep = {deep};
  assert.equal((await request("/__control/action", {method: "POST", body: action("event.record", {value: deep})})).status, 400);
  assert.equal((await request("/__control/action", {method: "POST", body: "x".repeat(65 * 1024)})).status, 413);
});

test("supports 100 isolated delayed barriers and disconnect cleanup", async (t) => {
  const {fixture, request} = await world(); t.after(() => fixture.close());
  const handles = [];
  for (let index = 0; index < 100; index += 1) {
    const response = await request("/__control/action", {method: "POST", body: action("barrier.create", {id: `call_${index}`})});
    assert.equal(response.status, 200); handles.push((await response.json()).handle);
  }
  assert.equal(fixture.control.snapshot().pending_barriers, 100);
  for (const handle of handles.slice(0, 50)) fixture.control.settleBarrier(handle, "released");
  for (const handle of handles.slice(50, 75)) fixture.control.settleBarrier(handle, "aborted");
  fixture.control.disconnect();
  const snapshot = fixture.control.snapshot();
  assert.equal(snapshot.pending_barriers, 0);
  assert.equal(snapshot.events.filter(({type}) => type === "barrier.released").length, 50);
  assert.equal(snapshot.events.filter(({type}) => type === "barrier.aborted").length, 50);
});

test("bounds control rate, concurrency, barriers, and event history", () => {
  let now = 1_000;
  const control = new FixtureControl({worldId: "world_bounds", host: "127.0.0.1:1", origin: "http://127.0.0.1:1", now: () => now});
  const request = {headers: {host: control.host, origin: control.origin, authorization: `Bearer ${control.capability}`}};
  for (let index = 0; index < fixtureLimits.rate; index += 1) assert.equal(control.authorize(request), null);
  assert.equal(control.authorize(request).kind, "rate_limited");
  now += 1_001;
  for (let index = 0; index < fixtureLimits.concurrency; index += 1) control.begin();
  assert.equal(control.authorize(request).kind, "too_many_requests");
  for (let index = 0; index < fixtureLimits.concurrency; index += 1) control.end();
  for (let index = 0; index < fixtureLimits.barriers; index += 1) control.createBarrier(`scenario:barrier_${index}`);
  assert.throws(() => control.createBarrier("scenario:overflow"), /barrier_capacity/);
  control.disconnect();
  for (let index = 0; index < fixtureLimits.history + 10; index += 1) control.record("history", {index});
  const snapshot = control.snapshot();
  assert.equal(snapshot.events.length, fixtureLimits.history);
  assert.ok(snapshot.events[0].sequence > 1);
});

test("bounds wait concurrency, rate, and repeated waiters per barrier", async () => {
  let now = 1_000;
  const control = new FixtureControl({worldId: "world_wait_bounds", host: "127.0.0.1:1", origin: "http://127.0.0.1:1", now: () => now});
  const waits = [];
  for (let index = 0; index < fixtureLimits.waits; index += 1) {
    const handle = control.createBarrier(`scenario:call_${index}`);
    waits.push(control.openWait(handle));
  }
  const overflow = control.createBarrier("scenario:overflow");
  assert.throws(() => control.openWait(overflow), /too_many_waits/);
  assert.throws(() => control.openWait("world_wait_bounds:scenario:call_0"), /too_many_waits/);
  for (const wait of waits) { wait.promise.catch(() => {}); wait.cancel("test_cleanup"); }
  assert.equal(control.activeWaits, 0);
  const repeatedHandle = control.createBarrier("scenario:repeated");
  const first = control.openWait(repeatedHandle); first.promise.catch(() => {});
  assert.throws(() => control.openWait(repeatedHandle), /barrier_waiter_capacity/);
  first.cancel("test_cleanup");
  now += 1_001;
  const rateControl = new FixtureControl({worldId: "world_wait_rate", host: "127.0.0.1:1", origin: "http://127.0.0.1:1", now: () => now});
  for (let index = 0; index < fixtureLimits.waitRate; index += 1) {
    const handle = rateControl.createBarrier(`rate:call_${index}`);
    rateControl.admitWaitRequest();
    const wait = rateControl.openWait(handle); wait.promise.catch(() => {}); wait.cancel("test_cleanup");
  }
  const rateOverflow = rateControl.createBarrier("rate:overflow");
  assert.ok(rateOverflow);
  assert.throws(() => rateControl.admitWaitRequest(), /wait_rate_limited/);
});

test("wait timeout, abort, release, and disconnect deterministically release capacity", async () => {
  const control = new FixtureControl({worldId: "world_wait_cleanup", host: "127.0.0.1:1", origin: "http://127.0.0.1:1"});
  const timeoutHandle = control.createBarrier("scenario:timeout");
  const timed = control.openWait(timeoutHandle, {timeoutMs: 1});
  await assert.rejects(timed.promise, /waiter_timeout/);
  assert.equal(control.activeWaits, 0);
  const cancelHandle = control.createBarrier("scenario:cancel");
  const cancelled = control.openWait(cancelHandle); cancelled.promise.catch(() => {}); cancelled.cancel("socket_closed");
  assert.equal(control.activeWaits, 0);
  const releaseHandle = control.createBarrier("scenario:release");
  const released = control.openWait(releaseHandle); control.settleBarrier(releaseHandle, "released");
  assert.equal(await released.promise, "released");
  const disconnectHandle = control.createBarrier("scenario:disconnect");
  const disconnected = control.openWait(disconnectHandle);
  control.disconnect();
  assert.equal(await disconnected.promise, "aborted");
  assert.equal(control.activeWaits, 0);
  assert.equal(control.snapshot().events.filter(({type}) => type === "wait.opened").length,
    control.snapshot().events.filter(({type}) => type === "wait.closed").length);
});

test("WebMCP fixture exposes tools, boundaries, catalog mutation, and effects", async () => {
  const documentObject = {documentElement: {dataset: {documentMarker: "document-a"}}};
  const context = installWebMcpFixture(documentObject);
  const names = (await context.getTools()).map(({name}) => name);
  assert.deepEqual(names, ["echo", "typed", "immediate", "delayed", "side_effect", "reject", "oversized", "deep", "catalog.add", "catalog.remove"]);
  assert.deepEqual(await context.executeTool("typed", {count: 3, enabled: true}), {count: 3, enabled: true});
  assert.equal(await context.executeTool("echo", {value: "hello"}), "hello");
  assert.equal((await context.executeTool("oversized")).length, 131_073);
  assert.ok(JSON.stringify(await context.executeTool("deep")).length > 100);
  await assert.rejects(context.executeTool("reject"), /controlled_rejection/);
  await context.executeTool("side_effect");
  await context.executeTool("catalog.add");
  assert.ok((await context.getTools()).some(({name}) => name === "dynamic"));
  assert.equal(globalThis.__webbyFixture.snapshot().revision, 2);
  assert.equal(globalThis.__webbyFixture.snapshot().catalog.at(-1).name, "dynamic");
  await context.executeTool("catalog.remove");
  assert.ok(!(await context.getTools()).some(({name}) => name === "dynamic"));
  assert.equal(globalThis.__webbyFixture.snapshot().revision, 3);
  assert.deepEqual(globalThis.__webbyFixture.snapshot().events.filter(({type}) => type === "catalog.changed").map(({revision}) => revision), [2, 3]);
  assert.equal(globalThis.__webbyFixture.snapshot().effects, 1);
  assert.equal(globalThis.__webbyFixture.navigateMarker(), "document-a");
});

test("100 actual modelContext delayed calls settle through the shared control bridge", async () => {
  const control = new FixtureControl({worldId: "world_bridge", host: "127.0.0.1:1", origin: "http://127.0.0.1:1"});
  const bridge = {wait(scenarioId, callId) { return control.waitBarrier(control.handle(`${scenarioId}:${callId}`)); }};
  const context = installWebMcpFixture({documentElement: {dataset: {documentMarker: "bridge"}}}, {bridge});
  const calls = [];
  for (let index = 0; index < 100; index += 1) {
    const callId = `call_${index}`;
    control.createBarrier(`scenario_bulk:${callId}`);
    calls.push(context.executeTool("delayed", {scenario_id: "scenario_bulk", call_handle: callId}));
  }
  for (let index = 0; index < 100; index += 1) {
    control.settleBarrier(`world_bridge:scenario_bulk:call_${index}`, index % 2 === 0 ? "released" : "aborted");
  }
  const results = await Promise.allSettled(calls);
  assert.equal(results.filter(({status}) => status === "fulfilled").length, 50);
  assert.equal(results.filter(({status}) => status === "rejected").length, 50);
  const snapshot = globalThis.__webbyFixture.snapshot();
  assert.equal(snapshot.effects, 50);
  assert.equal(snapshot.calls.filter(([, call]) => call.status === "completed").length, 50);
  assert.equal(snapshot.calls.filter(([, call]) => call.status === "aborted").length, 50);
  assert.deepEqual(control.snapshot().events.filter(({type}) => type === "barrier.released").map(({call_id}) => call_id),
    Array.from({length: 50}, (_, index) => `call_${index * 2}`));
});

test("real HTTP controller release and abort settle the exact page wait", async (t) => {
  const {fixture, request} = await world(); t.after(() => fixture.close());
  const create = async (scenarioId, callId) => {
    const response = await request("/__control/action", {method: "POST", body: action("barrier.create", {scenario_id: scenarioId, call_id: callId})});
    return (await response.json()).handle;
  };
  const releaseHandle = await create("scenario_http", "release_call");
  const abortHandle = await create("scenario_http", "abort_call");
  const pageWait = (callId) => fetch(`${fixture.origin}/__fixture/wait?scenario_id=scenario_http&call_id=${callId}`, {headers: {"sec-fetch-site": "same-origin"}}).then((response) => response.json());
  const released = pageWait("release_call");
  const aborted = pageWait("abort_call");
  while (fixture.control.snapshot().events.filter(({type}) => type === "page.wait").length < 2) await new Promise(setImmediate);
  await request("/__control/action", {method: "POST", body: action("barrier.release", {scenario_id: "scenario_http", call_id: "release_call", handle: releaseHandle})});
  await request("/__control/action", {method: "POST", body: action("barrier.abort", {scenario_id: "scenario_http", call_id: "abort_call", handle: abortHandle})});
  assert.deepEqual(await released, {state: "released", scenario_id: "scenario_http", call_id: "release_call"});
  assert.deepEqual(await aborted, {state: "aborted", scenario_id: "scenario_http", call_id: "abort_call"});
  assert.equal(fixture.control.snapshot().events.filter(({type}) => type === "page.wait").length, 2);
  assert.equal((await fetch(`${fixture.origin}/__fixture/wait?scenario_id=scenario_http&call_id=release_call`)).status, 403);
});

test("aborted HTTP page wait closes its accounted waiter and socket", async (t) => {
  const {fixture, request} = await world(); t.after(() => fixture.close());
  const created = await request("/__control/action", {method: "POST", body: action("barrier.create", {scenario_id: "scenario_abort", call_id: "call_abort"})});
  assert.equal(created.status, 200);
  const controller = new AbortController();
  const pending = fetch(`${fixture.origin}/__fixture/wait?scenario_id=scenario_abort&call_id=call_abort`, {
    headers: {"sec-fetch-site": "same-origin"}, signal: controller.signal
  });
  while (fixture.control.activeWaits !== 1) await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(pending, {name: "AbortError"});
  while (fixture.control.activeWaits !== 0) await new Promise(setImmediate);
  const events = fixture.control.snapshot().events;
  assert.equal(events.filter(({type, call_id: callId}) => type === "wait.opened" && callId === "call_abort").length, 1);
  assert.equal(events.filter(({type, call_id: callId}) => type === "wait.closed" && callId === "call_abort").length, 1);
  assert.ok(events.some(({type, reason}) => type === "wait.closed" && reason === "waiter_disconnected"));
});

test("correlated diagnostics omit the control capability", async (t) => {
  const {fixture, request} = await world(); t.after(() => fixture.close());
  const response = await request("/__control/action", {method: "POST", body: action("barrier.create", {scenario_id: "scenario_log", call_id: "call_log"})});
  assert.equal(response.status, 200);
  const diagnostics = JSON.stringify(fixture.control.snapshot());
  assert.doesNotMatch(diagnostics, new RegExp(fixture.capability));
  assert.match(diagnostics, /scenario_log/);
  assert.match(diagnostics, /call_log/);
  assert.match(diagnostics, /control\.request/);
});

test("delayed calls release or abort without post-abort side effects", async () => {
  const context = installWebMcpFixture({documentElement: {dataset: {documentMarker: "delayed"}}});
  const released = context.executeTool("delayed", {call_handle: "release_me"});
  globalThis.__webbyFixture.release("release_me");
  assert.equal((await released).ok, true);
  assert.equal(globalThis.__webbyFixture.snapshot().effects, 1);
  const controller = new AbortController();
  const aborted = context.executeTool("delayed", {call_handle: "abort_me"}, {signal: controller.signal});
  controller.abort();
  await assert.rejects(aborted, {name: "AbortError"});
  assert.equal(globalThis.__webbyFixture.snapshot().effects, 1);
  assert.equal(globalThis.__webbyFixture.snapshot().calls.find(([handle]) => handle === "abort_me")[1].status, "aborted");
  assert.throws(() => globalThis.__webbyFixture.release("abort_me"), /unknown_or_stale_handle/);
});
