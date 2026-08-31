/** @typedef {{active: boolean, workerNonce?: string, chromeEvent: (name: string) => void, socketAttempt: () => void, protocolOut: (frame: any) => void, protocolIn: (frame: any) => void, channelReady: () => Promise<unknown>, authenticated: (browserId?: string) => Promise<unknown>, scanCompleted: (value: any) => Promise<unknown>, scanAllCompleted: () => Promise<unknown>, selectScanTarget: (fallback: () => any) => Promise<any>, scanError: (error: unknown) => unknown, socketAttempts?: () => number, binding?: Record<string, string>}} ExtensionDiagnostics */

/** @type {Readonly<ExtensionDiagnostics>} */
const DEFAULT_DIAGNOSTICS = Object.freeze({
  active: false,
  workerNonce: undefined,
  chromeEvent() {},
  socketAttempt() {},
  protocolOut() {},
  protocolIn() {},
  async channelReady() {},
  async authenticated() {},
  async scanCompleted() {},
  async scanAllCompleted() {},
  async selectScanTarget(/** @type {() => any} */ fallback) { return fallback(); },
  scanError(/** @type {unknown} */ error) { return error; }
});

/** @type {Readonly<ExtensionDiagnostics>} */
let diagnostics = DEFAULT_DIAGNOSTICS;

export function extensionDiagnostics() {
  return diagnostics;
}

/**
 * Installs the only supported extension diagnostics implementation. Production
 * never calls this function and therefore retains the frozen no-op interface.
 *
 * @param {Readonly<ExtensionDiagnostics>} implementation
 */
export function installExtensionDiagnostics(implementation) {
  if (diagnostics !== DEFAULT_DIAGNOSTICS) throw new Error("extension diagnostics already installed");
  if (!implementation?.active) throw new Error("invalid extension diagnostics implementation");
  diagnostics = implementation;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function validBinding(value) {
  if (!value || typeof value !== "object") return false;
  const binding = /** @type {Record<string, any>} */ (value);
  if (binding.schema_version !== 1 || binding.environment_marker !== "isolated-e2e" || binding.expected_extension_id !== chrome.runtime.id) return false;
  if (typeof binding.base_url !== "string" || typeof binding.fixture_url !== "string") return false;
  try {
    const base = new URL(binding.base_url);
    const fixture = new URL(binding.fixture_url);
    const exactAuthority = (/** @type {URL} */ url) => !url.username && !url.password && !url.search && !url.hash && (url.pathname === "" || url.pathname === "/");
    return base.protocol === "http:" && base.hostname === "127.0.0.1" && Boolean(base.port) && base.port !== "6477" && exactAuthority(base) &&
      fixture.protocol === "http:" && fixture.hostname === "127.0.0.1" && Boolean(fixture.port) && exactAuthority(fixture) && fixture.origin !== base.origin &&
      typeof binding.instance_nonce === "string" && binding.instance_nonce.length >= 32;
  } catch { return false; }
}

/**
 * Creates diagnostics only for a cryptographically pinned, isolated generated
 * extension. Keeping this implementation behind an explicit interface avoids
 * source rewriting while making accidental production activation fail closed.
 *
 * @param {unknown} candidate
 */
export function createIsolatedE2EDiagnostics(candidate) {
  if (!validBinding(candidate)) throw new Error("invalid E2E binding");
  const binding = /** @type {Record<string, string>} */ (candidate);
  const workerNonce = crypto.randomUUID();
  /** @type {Record<string, number>} */
  const chromeEvents = {};
  /** @type {any[]} */
  const protocolEvents = [];
  /** @type {Record<string, string>} */
  const protocolRefs = {};
  let scanAllCompletions = 0;
  let socketAttempts = 0;
  const e2eGlobal = /** @type {any} */ (globalThis);
  e2eGlobal.__webbyE2EChromeEvents = chromeEvents;
  e2eGlobal.__webbyE2ESocketAttempts = 0;

  const persist = (/** @type {Record<string, any>} */ value) => chrome.storage.local.set(value);
  const recordProtocol = (/** @type {any} */ value) => {
    protocolEvents.push({...value, sequence: protocolEvents.length + 1});
    void persist({e2eProtocolEvents: protocolEvents.slice(-256)}).catch(() => {});
  };

  return Object.freeze({
    active: true,
    workerNonce,
    chromeEvent(/** @type {string} */ name) {
      chromeEvents[name] = (chromeEvents[name] ?? 0) + 1;
      void persist({e2eChromeEvents: {...chromeEvents}}).catch(() => {});
    },
    socketAttempt() { socketAttempts += 1; e2eGlobal.__webbyE2ESocketAttempts = socketAttempts; },
    socketAttempts() { return socketAttempts; },
    protocolOut(/** @type {any} */ {ref, event, payload}) {
      protocolRefs[ref] = payload?.type ?? event;
      recordProtocol({
        direction: "out", ref, event, type: protocolRefs[ref],
        observations: payload?.payload?.observations?.map((/** @type {any} */ value) => {
          let sanitized_url = null;
          try { const parsed = new URL(value.url); sanitized_url = parsed.origin + parsed.pathname; } catch {}
          return {tab_id: value.tab_id, document_id: value.document_id, catalog_revision: value.catalog_revision, sanitized_url};
        }) ?? []
      });
    },
    protocolIn(/** @type {any} */ {ref, event, payload}) {
      recordProtocol({direction: "in", ref, event, type: protocolRefs[ref] ?? event, status: payload?.status ?? null, observation_count: payload?.response?.payload?.observation_count ?? null});
    },
    channelReady() { return persist({e2eChannelReadyNonce: workerNonce}); },
    authenticated(/** @type {string | undefined} */ browserId) { return persist({e2eAuthenticatedBrowserId: browserId, e2eAuthenticatedWorkerNonce: workerNonce}); },
    scanCompleted(/** @type {any} */ {tabId, result, observation}) {
      return persist({e2eLastScan: {tabId, supported: result?.result?.supported === true, toolCount: observation?.tools?.length ?? 0, documentId: result?.documentId ?? null}});
    },
    async scanAllCompleted() { scanAllCompletions += 1; await persist({e2eScanAllCompletions: scanAllCompletions}); },
    async selectScanTarget(/** @type {() => any} */ fallback) {
      const {e2eScanTabId} = await chrome.storage.local.get("e2eScanTabId");
      return typeof e2eScanTabId === "number" ? chrome.tabs.get(e2eScanTabId) : fallback();
    },
    scanError(/** @type {unknown} */ error) { return error instanceof Error ? `${error.name}:${error.message}` : String(error); },
    binding
  });
}
