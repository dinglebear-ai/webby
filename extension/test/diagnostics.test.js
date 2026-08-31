import test from "node:test";
import assert from "node:assert/strict";

test("isolated diagnostics fail closed and record through the explicit interface", async () => {
  const writes = [];
  globalThis.chrome = {
    runtime: {id: "a".repeat(32)},
    tabs: {get: async id => ({id})},
    storage: {local: {
      async get() { return {e2eScanTabId: 9}; },
      async set(value) { writes.push(value); }
    }}
  };
  const {createIsolatedE2EDiagnostics} = await import(`../src/diagnostics.js?test=${Date.now()}`);
  const binding = {
    schema_version: 1, environment_marker: "isolated-e2e", expected_extension_id: chrome.runtime.id,
    instance_nonce: "n".repeat(43), base_url: "http://127.0.0.1:65001",
    fixture_url: "http://127.0.0.1:65002"
  };
  assert.throws(() => createIsolatedE2EDiagnostics({...binding, expected_extension_id: "b".repeat(32)}), /invalid E2E binding/);
  assert.throws(() => createIsolatedE2EDiagnostics({...binding, base_url: "http://127.0.0.1:6477"}), /invalid E2E binding/);
  assert.throws(() => createIsolatedE2EDiagnostics({...binding, fixture_url: binding.base_url}), /invalid E2E binding/);
  for (const base_url of [
    "http://user@127.0.0.1:65001", "http://127.0.0.1:65001/path",
    "http://127.0.0.1:65001?query=1", "http://127.0.0.1:65001#fragment"
  ]) assert.throws(() => createIsolatedE2EDiagnostics({...binding, base_url}), /invalid E2E binding/);
  for (const fixture_url of [
    "http://user@127.0.0.1:65002", "http://127.0.0.1:65002/path",
    "http://127.0.0.1:65002?query=1", "http://127.0.0.1:65002#fragment"
  ]) assert.throws(() => createIsolatedE2EDiagnostics({...binding, fixture_url}), /invalid E2E binding/);
  assert.throws(() => createIsolatedE2EDiagnostics({...binding, schema_version: 2}), /invalid E2E binding/);

  const diagnostics = createIsolatedE2EDiagnostics(binding);
  diagnostics.chromeEvent("tabs.onUpdated");
  diagnostics.socketAttempt();
  diagnostics.protocolOut({ref: "1", event: "message", payload: {type: "discovery.observed", payload: {observations: [{url: "https://example.test/private?secret=yes", tab_id: 1}]}}});
  diagnostics.protocolIn({ref: "1", event: "phx_reply", payload: {status: "ok"}});
  await diagnostics.channelReady();
  await diagnostics.authenticated("browser-1");
  await diagnostics.scanCompleted({tabId: 1, result: {documentId: "doc", result: {supported: true}}, observation: {tools: [{name: "one"}]}});
  await diagnostics.scanAllCompleted();
  assert.deepEqual(await diagnostics.selectScanTarget(() => ({id: 1})), {id: 9});
  assert.equal(globalThis.__webbyE2ESocketAttempts, 1);
  assert.equal(globalThis.__webbyE2EChromeEvents["tabs.onUpdated"], 1);
  assert.ok(writes.some(value => value.e2eAuthenticatedBrowserId === "browser-1"));
  assert.ok(writes.some(value => value.e2eLastScan?.toolCount === 1));
  const protocol = writes.filter(value => value.e2eProtocolEvents).at(-1).e2eProtocolEvents;
  assert.equal(protocol[0].observations[0].sanitized_url, "https://example.test/private");
  assert.doesNotMatch(JSON.stringify(protocol), /secret=yes/);
});

test("background diagnostic persistence failures fail the next awaited milestone", async () => {
  let writes = 0;
  globalThis.chrome = {
    runtime: {id: "a".repeat(32)},
    tabs: {get: async id => ({id})},
    storage: {local: {
      async get() { return {}; },
      async set() {
        writes += 1;
        if (writes === 1) throw new Error("diagnostic storage unavailable");
      }
    }}
  };
  const {createIsolatedE2EDiagnostics} = await import(`../src/diagnostics.js?failure=${Date.now()}`);
  const diagnostics = createIsolatedE2EDiagnostics({
    schema_version: 1, environment_marker: "isolated-e2e", expected_extension_id: chrome.runtime.id,
    instance_nonce: "n".repeat(43), base_url: "http://127.0.0.1:65001",
    fixture_url: "http://127.0.0.1:65002"
  });

  diagnostics.protocolOut({ref: "1", event: "message", payload: {type: "discovery.observed"}});
  await assert.rejects(diagnostics.channelReady(), /diagnostic storage unavailable/);
  assert.equal(writes, 1);
});

test("explicit final flush surfaces a tracked failure without a later milestone", async () => {
  globalThis.chrome = {
    runtime: {id: "a".repeat(32)}, tabs: {get: async id => ({id})},
    storage: {local: {async get() { return {}; }, async set() { throw new Error("final diagnostic write failed"); }}}
  };
  const {createIsolatedE2EDiagnostics} = await import(`../src/diagnostics.js?flush=${Date.now()}`);
  const diagnostics = createIsolatedE2EDiagnostics({
    schema_version: 1, environment_marker: "isolated-e2e", expected_extension_id: chrome.runtime.id,
    instance_nonce: "n".repeat(43), base_url: "http://127.0.0.1:65001", fixture_url: "http://127.0.0.1:65002"
  });
  diagnostics.chromeEvent("tabs.onRemoved");
  await assert.rejects(diagnostics.flush(), /final diagnostic write failed/);
  await assert.rejects(globalThis.__webbyE2EFlushDiagnostics(), /final diagnostic write failed/);
});

test("transient cancellation diagnostics are durably observable", async () => {
  const writes = [];
  globalThis.chrome = {
    runtime: {id: "a".repeat(32)},
    tabs: {get: async id => ({id})},
    storage: {local: {async get() { return {}; }, async set(value) { writes.push(value); }}}
  };
  const {createIsolatedE2EDiagnostics} = await import(`../src/diagnostics.js?cancellation=${Date.now()}`);
  const diagnostics = createIsolatedE2EDiagnostics({
    schema_version: 1, environment_marker: "isolated-e2e", expected_extension_id: chrome.runtime.id,
    instance_nonce: "n".repeat(43), base_url: "http://127.0.0.1:65001",
    fixture_url: "http://127.0.0.1:65002"
  });
  const value = {callId: "call-1", tabId: 7, documentId: "doc-1", kind: "frame_gone"};
  await diagnostics.cancellationTransient(value);
  assert.deepEqual(writes.at(-1), {e2eLastTransientCancellation: value});
});
