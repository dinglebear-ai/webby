import test from "node:test";
import assert from "node:assert/strict";

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); }
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function installChrome({settingsGets = [], identity = {publicKey: "public", privateKey: {kty: "OKP"}}} = {}) {
  const events = {
    installed: event(), startup: event(), updated: event(), activated: event(),
    removed: event(), alarm: event(), permissionAdded: event(),
    permissionRemoved: event(), storageChanged: event(), message: event()
  };
  let settingsIndex = 0;
  globalThis.chrome = {
    runtime: {id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", getManifest: () => ({}), onInstalled: events.installed, onStartup: events.startup, onMessage: events.message},
    tabs: {
      onUpdated: events.updated, onActivated: events.activated, onRemoved: events.removed,
      get: async () => ({id: 1, url: "https://example.com"}), query: async () => []
    },
    alarms: {onAlarm: events.alarm, create: async () => {}},
    permissions: {onAdded: events.permissionAdded, onRemoved: events.permissionRemoved},
    scripting: {executeScript: async () => []},
    storage: {
      onChanged: events.storageChanged,
      local: {
        async get(keys) {
          if (Array.isArray(keys) && keys.includes("scanningPaused")) {
            const value = settingsGets[settingsIndex++];
            return value ? await value : {baseUrl: "http://127.0.0.1:6477", scanningPaused: true};
          }
          return identity;
        },
        async set() {}
      }
    }
  };
  return events;
}

class FakeWebSocket {
  static OPEN = 1;
  static urls = [];
  readyState = 0;
  constructor(url) { FakeWebSocket.urls.push(String(url)); }
  send() {}
  close() { this.closed = true; }
}

test("base URL changes invalidate an initialization even before a channel exists", async () => {
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const second = Promise.resolve({baseUrl: "http://127.0.0.1:7777", scanningPaused: true});
  const events = installChrome({settingsGets: [first, second]});
  FakeWebSocket.urls = [];
  globalThis.WebSocket = FakeWebSocket;

  await import(`../src/service_worker.js?generation-race=${Date.now()}`);
  events.storageChanged.listeners[0]({baseUrl: {oldValue: "http://127.0.0.1:6477", newValue: "http://127.0.0.1:7777"}});
  releaseFirst({baseUrl: "http://127.0.0.1:6477", scanningPaused: true});
  await tick();
  await tick();

  assert.equal(FakeWebSocket.urls.length, 1);
  assert.match(FakeWebSocket.urls[0], /^ws:\/\/127\.0\.0\.1:7777\/browser\/websocket/);
});

test("async Chrome listener failures are consumed and logged", async () => {
  const events = installChrome();
  globalThis.WebSocket = FakeWebSocket;
  chrome.tabs.get = async () => { throw new Error("tab lookup failed"); };
  const failures = [];
  const originalError = console.error;
  console.error = (...args) => failures.push(args);
  try {
    await import(`../src/service_worker.js?listener-failure=${Date.now()}`);
    events.activated.listeners[0]({tabId: 91});
    await tick();
  } finally {
    console.error = originalError;
  }

  assert.equal(failures.length, 1);
  assert.match(failures[0][0], /activated tab scan failed/);
  assert.match(failures[0][1].message, /tab lookup failed/);
});

test("pairing terminal states clear only after durable approval and reject malformed replies", async () => {
  installChrome();
  globalThis.WebSocket = FakeWebSocket;
  const operations = [];
  chrome.storage.local.set = async (value) => { operations.push(["set", value]); };
  chrome.storage.local.remove = async (key) => { operations.push(["remove", key]); };
  const {lookupExecutableTab, pairingTransition, persistApprovedPairing, reconcilePairingStatus, recoverPairingPersistence, reportMissingObservationCancellation, transientCancellationDiagnostic, transientErrorKind} = await import(`../src/service_worker.js?pairing-status=${Date.now()}`);
  await tick();

  assert.deepEqual(pairingTransition({payload: {status: "pending"}}), {state: "pending", terminal: false});
  const browserId = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(pairingTransition({payload: {status: "approved", browser_id: browserId}}), {state: "approved", terminal: true, browserId});
  assert.deepEqual(pairingTransition({payload: {status: "rejected"}}), {state: "rejected", terminal: true});
  assert.deepEqual(pairingTransition({payload: {status: "expired"}}), {state: "expired", terminal: true});
  assert.throws(() => pairingTransition({payload: {status: "approved", browser_id: ""}}), error => error.code === "invalid_pairing_status");
  for (const browser_id of [" ", "browser-1", "123e4567-e89b-02d3-a456-426614174000", "x".repeat(256)]) {
    assert.throws(() => pairingTransition({payload: {status: "approved", browser_id}}), error => error.code === "invalid_pairing_status");
  }

  assert.equal(await reconcilePairingStatus({payload: {status: "approved", browser_id: browserId}}), true);
  assert.deepEqual(operations.slice(-2), [["set", {browserId}], ["remove", "pairingId"]]);

  const originalInfo = console.info;
  console.info = () => {};
  try {
    assert.equal(await reconcilePairingStatus({payload: {status: "rejected"}}), false);
    assert.equal(await reconcilePairingStatus({payload: {status: "expired"}}), false);
  } finally { console.info = originalInfo; }
  assert.deepEqual(operations.slice(-2), [["remove", "pairingId"], ["remove", "pairingId"]]);
  await assert.rejects(reconcilePairingStatus({payload: {status: "unknown"}}), /invalid_pairing_status/);

  let removed = false;
  chrome.storage.local.set = async () => { throw new Error("browser identity persistence failed"); };
  chrome.storage.local.remove = async () => { removed = true; };
  await assert.rejects(reconcilePairingStatus({payload: {status: "approved", browser_id: "123e4567-e89b-42d3-a456-426614174001"}}), /persistence failed/);
  assert.equal(removed, false);

  const pushedOperations = [];
  chrome.storage.local.set = async value => { pushedOperations.push(["set", value]); };
  chrome.storage.local.remove = async key => { pushedOperations.push(["remove", key]); };
  await persistApprovedPairing("123e4567-e89b-42d3-a456-426614174002");
  assert.deepEqual(pushedOperations, [
    ["set", {browserId: "123e4567-e89b-42d3-a456-426614174002"}],
    ["remove", "pairingId"]
  ]);
  for (const malformed of [undefined, "", "browser-1", "123e4567-e89b-02d3-a456-426614174000"]) {
    await assert.rejects(persistApprovedPairing(malformed), /invalid_pairing_status/);
  }
  assert.equal(pushedOperations.length, 2);

  const recovery = [];
  chrome.storage.local.remove = async key => recovery.push(key);
  assert.equal(await recoverPairingPersistence({browserId: "123e4567-e89b-42d3-a456-426614174001", pairingId: "pairing-2"}), true);
  assert.equal(await recoverPairingPersistence({browserId: "malformed", pairingId: "pairing-2"}), false);
  assert.equal(await recoverPairingPersistence({pairingId: "pairing-2"}), false);
  assert.deepEqual(recovery, ["pairingId"]);

  assert.equal(transientErrorKind("activation_lookup", new Error("No tab with id: 1")), "tab_gone");
  assert.equal(transientErrorKind("activation_lookup", new Error("Frame with ID 0 was removed")), null);
  assert.equal(transientErrorKind("scan_injection", new Error("Frame with ID 0 was removed")), "frame_gone");
  assert.equal(transientErrorKind("scan_injection", new Error("Cannot access contents of url chrome://settings")), null);
  assert.equal(transientErrorKind("observation_close", new Error("channel_not_ready")), null);

  assert.deepEqual(
    transientCancellationDiagnostic(
      {call_id: "call-1", document_id: "doc-1"},
      {tab_id: 42, document_id: "doc-1"},
      new Error("No tab with id: 42")
    ),
    {callId: "call-1", tabId: 42, documentId: "doc-1", kind: "tab_gone"}
  );
  assert.equal(
    transientCancellationDiagnostic(
      {call_id: "call-1", document_id: "doc-1"},
      {tab_id: 42, document_id: "doc-1"},
      new Error("permission denied")
    ),
    null
  );
  const missingDiagnostics = [];
  await reportMissingObservationCancellation(
    {call_id: "missing-call", document_id: "missing-doc"},
    {async cancellationTransient(value) { missingDiagnostics.push(value); }}
  );
  assert.deepEqual(missingDiagnostics, [{
    callId: "missing-call", tabId: null, documentId: "missing-doc", kind: "observation_gone"
  }]);

  chrome.tabs.get = async () => { throw new Error("No tab with id: 42"); };
  assert.equal(await lookupExecutableTab(42), undefined);
  chrome.tabs.get = async () => { throw new Error("unexpected lookup failure"); };
  await assert.rejects(lookupExecutableTab(42), /unexpected lookup failure/);
});

test("expected missing-tab activation races do not log or scan", async () => {
  for (const message of ["No tab with id: 12", "The tab was closed"]) {
    const events = installChrome();
    globalThis.WebSocket = FakeWebSocket;
    chrome.tabs.get = async () => { throw new Error(message); };
    let executeCount = 0;
    chrome.scripting.executeScript = async () => { executeCount += 1; return []; };
    const failures = [];
    const originalError = console.error;
    console.error = (...args) => failures.push(args);
    try {
      await import(`../src/service_worker.js?expected-tab-race=${encodeURIComponent(message)}-${Date.now()}`);
      events.activated.listeners[0]({tabId: 12});
      await tick();
    } finally { console.error = originalError; }
    assert.equal(executeCount, 0);
    assert.deepEqual(failures, []);
  }
});
