import {WebbyChannel} from "./channel.js";
import {buildObservation, canScanTab, ignoredObservationTabIds, stableStringify} from "./scanning.js";
import {cancelWebMcp, invokeWebMcp, probeWebMcp} from "./probe.js";
import {reconcileModeAfterRemoval} from "./permissions.js";
import {parseLoopbackBaseUrl} from "./base_url.js";
import {closeObservations, executionAllowed, publishCurrentObservation, requireSettledSuccess, ScanScheduler} from "./orchestration.js";
import {createIsolatedE2EDiagnostics, extensionDiagnostics, installExtensionDiagnostics} from "./diagnostics.js";
import {E2E_BINDING} from "./e2e_binding.js";

const diagnosticsReady = E2E_BINDING ? (() => {
  installExtensionDiagnostics(createIsolatedE2EDiagnostics(E2E_BINDING));
  return chrome.storage.local.set({e2eBinding: E2E_BINDING, baseUrl: E2E_BINDING.base_url});
})() : Promise.resolve();

/** @typedef {{url: string, title: string, tools: unknown[], tab_id: number, document_id: string}} Observation */

const DEFAULTS = {baseUrl: "http://127.0.0.1:6477", scanningMode: "granted_sites", scanningPaused: false};
/** @type {WebbyChannel | undefined} */
let channel;
/** @type {Promise<void> | undefined} */
let initialization;
let initializationGeneration = 0;
/** @type {Promise<{publicKey?: string, privateKey?: JsonWebKey, browserId?: string}> | undefined} */
let identityCreation;
/** @type {Map<number | undefined, Observation>} */
let observations = new Map();
/** @type {Map<number, number>} */
const scanGenerations = new Map();
const SCAN_CONCURRENCY = 8;
const BROWSER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** @type {Map<number, string>} */
const pendingClosures = new Map();

/**
 * The channel is created by `initialize()`, which runs at worker start and
 * before any listener can fire. Callers that only run in response to a server
 * event therefore have one; this keeps that assumption in a single place
 * instead of scattering optional chaining that would silently do nothing.
 * @returns {WebbyChannel}
 */
function requireChannel() {
  if (!channel) throw new Error("channel_unavailable");
  return channel;
}

chrome.runtime.onInstalled.addListener(() => { extensionDiagnostics().chromeEvent("runtime.onInstalled"); runListener("installation initialization", initialize); });
chrome.runtime.onStartup.addListener(() => { extensionDiagnostics().chromeEvent("runtime.onStartup"); runListener("startup initialization", initialize); });
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  extensionDiagnostics().chromeEvent("tabs.onUpdated");
  if (change.status === "complete") runListener("updated tab scan", () => scanTab(tab));
});
chrome.tabs.onActivated.addListener(({tabId}) => runListener("activated tab scan", async () => {
  extensionDiagnostics().chromeEvent("tabs.onActivated");
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch (error) { if (transientErrorKind("activation_lookup", error) === "tab_gone") return; throw error; }
  return scanTab(tab);
}));
chrome.tabs.onRemoved.addListener((tabId) => { extensionDiagnostics().chromeEvent("tabs.onRemoved"); runListener("removed tab close", () => closeObservation(tabId)); });
chrome.alarms.onAlarm.addListener((alarm) => {
  extensionDiagnostics().chromeEvent("alarms.onAlarm");
  if (alarm.name === "webby-periodic-scan") runListener("periodic scan", scanAll);
});
chrome.permissions.onAdded.addListener(() => { extensionDiagnostics().chromeEvent("permissions.onAdded"); runListener("permission-added scan", scanAll); });
chrome.permissions.onRemoved.addListener(() => runListener("permission removal reconciliation", async () => {
  extensionDiagnostics().chromeEvent("permissions.onRemoved");
  await reconcileModeAfterRemoval(chrome.permissions, chrome.storage.local);
  await closeIneligibleObservations();
  await scanAll();
}));
chrome.storage.onChanged.addListener((changes) => {
  const relevant = ["baseUrl", "browserId", "scanningMode", "scanningPaused"];
  if (!relevant.some((key) => key in changes)) return;
  extensionDiagnostics().chromeEvent("storage.onChanged");
  if ("baseUrl" in changes || "browserId" in changes) {
    channel?.close();
    channel = undefined;
    initializationGeneration += 1;
    initialization = undefined;
  }
  runListener("settings-change initialization", initialize);
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  extensionDiagnostics().chromeEvent("runtime.onMessage");
  handleUiMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ok: false, kind: error.message || "request_failed"}));
  return true;
});

async function initialize() {
  await diagnosticsReady;
  if (initialization) return initialization;
  const generation = ++initializationGeneration;
  initialization = initializeGeneration(generation).finally(() => {
    if (generation === initializationGeneration) initialization = undefined;
  });
  return initialization;
}

/** @param {number} generation */
async function initializeGeneration(generation) {
  const settings = {...DEFAULTS, ...await chrome.storage.local.get(Object.keys(DEFAULTS))};
  if (generation !== initializationGeneration) return;
  try { settings.baseUrl = parseLoopbackBaseUrl(settings.baseUrl); } catch {
    settings.baseUrl = DEFAULTS.baseUrl;
    if (generation !== initializationGeneration) return;
    await chrome.storage.local.set({baseUrl: settings.baseUrl});
  }
  if (generation !== initializationGeneration) return;
  const identity = await ensureIdentity();
  if (generation !== initializationGeneration) return;
  await chrome.alarms.create("webby-periodic-scan", {periodInMinutes: 1});
  if (generation !== initializationGeneration) return;
  if (!channel) {
    const candidate = new WebbyChannel({
      baseUrl: settings.baseUrl,
      extensionId: chrome.runtime.id,
      browserId: identity.browserId,
      onChallenge: authenticate,
      onReady: async () => {
        await extensionDiagnostics().channelReady();
        return resumeAndScan();
      },
      onEvent: handleServerEvent
    });
    if (generation !== initializationGeneration || channel) candidate.close();
    else { channel = candidate; candidate.connect(); }
  }
  if (generation !== initializationGeneration) return;
  if (settings.scanningPaused) await closeAllObservations();
  else if (identity.browserId) await scanAll();
}

/**
 * @returns {Promise<{publicKey?: string, privateKey?: JsonWebKey, browserId?: string}>}
 */
async function ensureIdentity() {
  const current = /** @type {{publicKey?: string, privateKey?: JsonWebKey, browserId?: string}} */ (
    await chrome.storage.local.get(["publicKey", "privateKey", "browserId"])
  );
  if (current.publicKey && current.privateKey) return current;
  identityCreation ??= (async () => {
    const latest = await chrome.storage.local.get(["publicKey", "privateKey", "browserId"]);
    if (latest.publicKey && latest.privateKey) return latest;
    const pair = await crypto.subtle.generateKey({name: "Ed25519"}, true, ["sign", "verify"]);
    const publicKey = encode(await crypto.subtle.exportKey("raw", pair.publicKey));
    const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
    await chrome.storage.local.set({publicKey, privateKey});
    return {publicKey, privateKey};
  })().finally(() => { identityCreation = undefined; });
  return identityCreation;
}

/**
 * @param {{signed_message: string, challenge_id: string}} challenge
 */
async function authenticate(challenge) {
  const {privateKey} = /** @type {{privateKey: JsonWebKey}} */ (await chrome.storage.local.get("privateKey"));
  const key = await crypto.subtle.importKey("jwk", privateKey, {name: "Ed25519"}, false, ["sign"]);
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(challenge.signed_message));
  await requireChannel().messageNow("auth.respond", {challenge_id: challenge.challenge_id, signature: encode(signature)});
  const welcome = await requireChannel().messageNow("browser.hello", {});
  await extensionDiagnostics().authenticated(requireChannel().browserId);
  await persistIgnoredOrigins(welcome);
}

async function resumeAndScan() {
  const {browserId, pairingId} = await chrome.storage.local.get(["browserId", "pairingId"]);
  await recoverPairingPersistence({browserId, pairingId});
  if (!browserId && pairingId) {
    const reply = await requireChannel().message("pairing.status", {pairing_id: pairingId});
    if (await reconcilePairingStatus(reply)) return;
  }
  if (browserId) {
    await syncBrowserSettings();
    await resync();
  }
}

/**
 * Completes the second half of an approved transition after an interrupted
 * browserId -> pairingId-removal durability sequence.
 * @param {{browserId?: unknown, pairingId?: unknown}} state
 */
export async function recoverPairingPersistence(state) {
  if (typeof state.browserId === "string" && BROWSER_ID.test(state.browserId) && typeof state.pairingId === "string" && state.pairingId) {
    await chrome.storage.local.remove("pairingId");
    return true;
  }
  return false;
}

/**
 * @param {{payload?: {status?: unknown, browser_id?: unknown}} | undefined} reply
 * @returns {{state: "pending", terminal: false}|{state: "approved", terminal: true, browserId: string}|{state: "rejected"|"expired", terminal: true}}
 */
export function pairingTransition(reply) {
  const payload = reply?.payload;
  if (payload?.status === "pending") return {state: "pending", terminal: false};
  if (payload?.status === "approved" && typeof payload.browser_id === "string" && BROWSER_ID.test(payload.browser_id)) {
    return {state: "approved", terminal: true, browserId: payload.browser_id};
  }
  if (payload?.status === "rejected") return {state: "rejected", terminal: true};
  if (payload?.status === "expired") return {state: "expired", terminal: true};
  throw Object.assign(new Error("invalid_pairing_status"), {code: "invalid_pairing_status"});
}

/** @param {{payload?: {status?: unknown, browser_id?: unknown}} | undefined} reply */
export async function reconcilePairingStatus(reply) {
  const transition = pairingTransition(reply);
  if (transition.state === "approved") {
    await persistApprovedPairing(transition.browserId);
    return true;
  }
  if (transition.state === "rejected" || transition.state === "expired") {
    await chrome.storage.local.remove("pairingId");
    console.info("Webby pairing reached a terminal state", {status: transition.state});
    return false;
  }
  return false;
}

/** Persist an approved identity before clearing the resumable pairing marker. */
/** @param {unknown} browserId */
export async function persistApprovedPairing(browserId) {
  const transition = pairingTransition({payload: {status: "approved", browser_id: browserId}});
  if (transition.state !== "approved") throw new Error("invalid_pairing_status");
  await chrome.storage.local.set({browserId: transition.browserId});
  await chrome.storage.local.remove("pairingId");
}

/**
 * Chrome ignores promises returned by most event listeners. Always attach a
 * rejection handler inside the listener turn so failures are observable and
 * do not become unhandled rejections in the service worker.
 * @param {string} operation
 * @param {() => Promise<unknown> | unknown} callback
 */
function runListener(operation, callback) {
  Promise.resolve()
    .then(callback)
    .catch((error) => console.error(`Webby ${operation} failed`, error));
}

async function syncBrowserSettings() {
  const settings = {...DEFAULTS, ...await chrome.storage.local.get(["scanningMode", "scanningPaused"])};
  try {
    await requireChannel().message("browser.settings", {
      scanning_mode: settings.scanningMode,
      scanning_paused: settings.scanningPaused
    });
  } catch (error) {
    console.error("Webby browser settings reconciliation failed", {
      scanningMode: settings.scanningMode,
      scanningPaused: settings.scanningPaused,
      error
    });
    throw error;
  }
}

/**
 * @param {{type?: string, payload?: any} | undefined} envelope
 */
async function handleServerEvent(envelope) {
  if (envelope?.type === "pairing.approved") {
    return persistApprovedPairing(envelope.payload?.browser_id);
  }
  if (envelope?.type === "tool.call") return executeToolCall(envelope.payload);
  if (envelope?.type === "tool.cancel") return cancelToolCall(envelope.payload);
}

/**
 * @param {{tab_id: number, document_id: string, call_id: string, tool_name: string, arguments?: unknown}} payload
 */
async function executeToolCall(payload) {
  try {
    const observation = observations.get(payload.tab_id);
    if (!observation || observation.document_id !== payload.document_id) {
      return await sendToolError(payload.call_id, "stale_document", "The requested document is no longer active");
    }
    const settings = {...DEFAULTS, ...await chrome.storage.local.get(["scanningPaused"])};
    const permissionGranted = await canScanTab(await lookupExecutableTab(payload.tab_id), chrome.permissions);
    if (!executionAllowed(settings.scanningPaused, permissionGranted)) {
      await closeObservation(payload.tab_id);
      return await sendToolError(payload.call_id, "permission_denied", "Browser access is paused or no longer granted");
    }
    const expectedCatalog = stableStringify(observation.tools);
    const [execution] = await chrome.scripting.executeScript({
      target: {tabId: payload.tab_id, documentIds: [payload.document_id]},
      world: "MAIN",
      func: invokeWebMcp,
      args: [payload.tool_name, payload.arguments ?? {}, payload.call_id, expectedCatalog, true]
    });
    const boundary = /** @type {any} */ (execution?.result);
    // A targeted document that is replaced while its injected promise is
    // pending resolves without an InjectionResult payload in Chromium.
    if (!boundary || boundary.__webby_execution_v1__ !== true) throw new Error("stale_document");
    if (!boundary.ok) throw new Error(boundary.error ?? "tool_failed");
    const result = boundary.value;
    if (encodedSize(result) > 131_072 || jsonDepth(result) > 32) throw new Error("result_too_large");
    await requireChannel().message("tool.result", {call_id: payload.call_id, result});
  } catch (error) {
    const message = error instanceof Error ? error.message : undefined;
    const kind = classifyToolError(error, message);
    const log = ["renderer_crashed", "worker_crashed"].includes(kind) ? console.error : console.info;
    log("Webby tool call failed", {callId: payload.call_id, kind, error});
    await sendToolError(payload.call_id, kind, "The page tool could not be completed");
  }
}

/**
 * @param {{document_id: string, call_id: string}} payload
 */
export async function cancelToolCall(payload) {
  const observation = [...observations.values()].find((entry) => entry.document_id === payload.document_id);
  if (!observation) {
    await reportMissingObservationCancellation(payload);
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: {tabId: observation.tab_id, documentIds: [observation.document_id]},
      world: "MAIN", func: cancelWebMcp, args: [payload.call_id]
    });
  } catch (error) {
    const diagnostic = transientCancellationDiagnostic(payload, observation, error);
    if (diagnostic) {
      await extensionDiagnostics().cancellationTransient(diagnostic);
      return;
    }
    console.error("Webby tool cancellation failed", {
      callId: payload.call_id,
      tabId: observation.tab_id,
      documentId: observation.document_id,
      error
    });
    throw error;
  }
}

/**
 * @param {{call_id: string, document_id: string}} payload
 * @param {{cancellationTransient: (value: any) => Promise<unknown>}} [target]
 */
export function reportMissingObservationCancellation(payload, target = extensionDiagnostics()) {
  return target.cancellationTransient({
    callId: payload.call_id,
    tabId: null,
    documentId: payload.document_id,
    kind: "observation_gone"
  });
}

/** Build explicit evidence for cancellation races that are safe to suppress. */
/**
 * @param {{call_id: string, document_id: string}} payload
 * @param {Observation} observation
 * @param {unknown} error
 */
export function transientCancellationDiagnostic(payload, observation, error) {
  const kind = transientErrorKind("tool_cancellation", error);
  return kind ? {
    callId: payload.call_id,
    tabId: observation.tab_id,
    documentId: observation.document_id,
    kind
  } : null;
}

/** Return undefined only for the expected tab-removal race. */
/** @param {number} tabId */
export async function lookupExecutableTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    if (transientErrorKind("eligibility_lookup", error) === "tab_gone") return undefined;
    throw error;
  }
}

/**
 * @param {string} callId
 * @param {string} kind
 * @param {string} message
 */
function sendToolError(callId, kind, message) {
  return requireChannel().message("tool.error", {call_id: callId, error: {kind, message}});
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function encodedSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {number}
 */
function jsonDepth(value, depth = 0) {
  if (!value || typeof value !== "object") return depth;
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.reduce((/** @type {number} */ maximum, /** @type {unknown} */ item) => Math.max(maximum, jsonDepth(item, depth + 1)), depth);
}

/**
 * @param {string | undefined} kind
 * @returns {boolean}
 */
function knownToolError(kind) {
  return kind !== undefined && ["webmcp_unavailable", "stale_catalog", "stale_document", "tool_not_found", "result_too_large", "AbortError"].includes(kind);
}

/** @param {unknown} error @param {string | undefined} message @returns {string} */
function classifyToolError(error, message) {
  if (transientErrorKind("tool_execution", error)) return "stale_document";
  if (message && /render(?:er)? process (?:gone|crashed)|render frame.*crashed/i.test(message)) return "renderer_crashed";
  if (message && /service worker.*(?:stopped|crashed|terminated)/i.test(message)) return "worker_crashed";
  if (message && /signal is aborted/i.test(message)) return "AbortError";
  return knownToolError(message) ? /** @type {string} */ (message) : "tool_failed";
}

async function scanAll() {
  const result = await fullScanScheduler.run();
  await extensionDiagnostics().scanAllCompleted();
  return result;
}

const fullScanScheduler = new ScanScheduler(scanAllOnce);

async function scanAllOnce() {
  const settings = {...DEFAULTS, ...await chrome.storage.local.get(Object.keys(DEFAULTS))};
  if (settings.scanningPaused) return closeAllObservations();
  const tabs = await chrome.tabs.query({});
  // Not `tabs.map(scanTab)`: map passes the index as the second argument, so
  // every tab after the first would arrive with allowActiveTab truthy and skip
  // the canScanTab check -- incognito, ineligible URLs, and origins the user
  // never granted included.
  await scanTabs(tabs);
}

/**
 * Runs a bounded tab scan without letting one rejected tab abandon the rest of
 * that worker's queue. The settled results retain one entry per tab so the
 * caller gets a failure only after every tab has been attempted.
 *
 * @param {chrome.tabs.Tab[]} tabs
 * @param {(tab: chrome.tabs.Tab) => Promise<unknown>} [scan]
 * @param {number} [concurrency]
 */
export async function scanTabs(tabs, scan = scanTab, concurrency = SCAN_CONCURRENCY) {
  let next = 0;
  /** @type {PromiseSettledResult<unknown>[]} */
  const results = new Array(tabs.length);
  const workers = Array.from({length: Math.min(concurrency, tabs.length)}, async () => {
    while (next < tabs.length) {
      const index = next++;
      const tab = tabs[index];
      if (!tab) continue;
      try {
        results[index] = {status: "fulfilled", value: await scan(tab)};
      } catch (reason) {
        results[index] = {status: "rejected", reason};
      }
    }
  });
  await Promise.all(workers);
  return reportRejected("full tab scan", results);
}

/**
 * @param {chrome.tabs.Tab | undefined} tab
 * @param {boolean} [allowActiveTab]
 */
async function scanTab(tab, allowActiveTab = false) {
  const settings = {...DEFAULTS, ...await chrome.storage.local.get(Object.keys(DEFAULTS))};
  if (!tab?.id || !tab.url) return;
  const tabId = tab.id;
  const generation = (scanGenerations.get(tabId) ?? 0) + 1;
  scanGenerations.set(tabId, generation);
  if (settings.scanningPaused || (!allowActiveTab && !(await canScanTab(tab, chrome.permissions)))) {
    await closeObservation(tab.id);
    return;
  }
  const {ignoredOrigins = []} = /** @type {{ignoredOrigins?: string[]}} */ (await chrome.storage.local.get("ignoredOrigins"));
  if (ignoredOrigins.includes(new URL(tab.url).origin)) {
    await closeObservation(tab.id);
    return;
  }
  try {
    const [result] = await chrome.scripting.executeScript({target: {tabId: tab.id}, world: "MAIN", func: probeWebMcp});
    if (scanGenerations.get(tabId) !== generation) return;
    const observation = buildObservation(tab, result);
    await extensionDiagnostics().scanCompleted({tabId, result, observation});
    if (!observation) {
      if (result?.documentId) await closeObservation(tab.id);
      return;
    }
    await publishCurrentObservation(
      generation,
      () => scanGenerations.get(tabId),
      async () => {
        const reply = await requireChannel().message("discovery.observed", {observations: [observation]});
        await persistIgnoredOrigins(reply);
      },
      () => observations.set(tabId, observation),
      async () => {
        await requireChannel().message("session.closed", {tab_id: tabId, document_id: observation.document_id});
      }
    );
  } catch (error) {
    if (transientErrorKind("scan_injection", error)) return {status: "gone"};
    console.error("Webby tab scan failed", {tabId: tab.id, error: extensionDiagnostics().scanError(error)});
    throw error;
  }
}

/**
 * @param {number | undefined} tabId
 */
async function closeObservation(tabId) {
  if (tabId !== undefined) scanGenerations.set(tabId, (scanGenerations.get(tabId) ?? 0) + 1);
  const observation = observations.get(tabId);
  if (!observation?.document_id) return;
  pendingClosures.set(/** @type {number} */ (tabId), observation.document_id);
  try {
    await requireChannel().message("session.closed", {
      tab_id: tabId,
      document_id: observation.document_id
    });
    if (observations.get(tabId)?.document_id === observation.document_id) observations.delete(tabId);
    if (pendingClosures.get(/** @type {number} */ (tabId)) === observation.document_id) {
      pendingClosures.delete(/** @type {number} */ (tabId));
    }
  } catch (error) {
    if (transientErrorKind("observation_close", error)) {
      if (observations.get(tabId)?.document_id === observation.document_id) observations.delete(tabId);
      if (pendingClosures.get(/** @type {number} */ (tabId)) === observation.document_id) pendingClosures.delete(/** @type {number} */ (tabId));
      return {status: "gone"};
    }
    console.error("Webby observation close failed; resync required", {tabId, error});
    throw error;
  }
}

async function closeAllObservations() {
  reportRejected("close all observations", await closeObservations(/** @type {Iterable<number>} */ (observations.keys()), closeObservation));
}

async function closeIneligibleObservations() {
  reportRejected("close ineligible observations", await Promise.allSettled([...observations.keys()].map(async (tabId) => {
    let tab;
    try {
      tab = tabId === undefined ? undefined : await chrome.tabs.get(tabId);
    } catch (error) {
      if (!transientErrorKind("eligibility_lookup", error)) throw error;
    }
    if (!(await canScanTab(tab, chrome.permissions))) await closeObservation(tabId);
  })));
}

async function resync() {
  const active = [...observations.values()].filter(
    (observation) => pendingClosures.get(observation.tab_id) !== observation.document_id
  );
  const reply = await requireChannel().message("browser.resync", {observations: active});
  for (const [tabId, documentId] of pendingClosures) {
    if (observations.get(tabId)?.document_id === documentId) observations.delete(tabId);
  }
  pendingClosures.clear();
  await persistIgnoredOrigins(reply);
  await scanAll();
}

/**
 * @param {{type: string, displayName?: string}} message
 */
async function handleUiMessage(message) {
  if (message.type === "pair") {
    const identity = await ensureIdentity();
    const reply = await requireChannel().message("pairing.request", {display_name: message.displayName || "Chrome", public_key: identity.publicKey, scanning_mode: "granted_sites"});
    if (reply?.payload?.pairing_id) await chrome.storage.local.set({pairingId: reply.payload.pairing_id});
    return reply;
  }
  if (message.type === "scan-now") {
    const activeTab = await extensionDiagnostics().selectScanTarget(async () => (await chrome.tabs.query({active: true, currentWindow: true}))[0]);
    return scanTab(activeTab, true);
  }
  return {ok: true};
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function encode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * @param {{payload?: {ignored_origins?: unknown}} | null | undefined} envelope
 */
async function persistIgnoredOrigins(envelope) {
  const ignoredOrigins = envelope?.payload?.ignored_origins;
  if (!Array.isArray(ignoredOrigins)) return;
  await chrome.storage.local.set({ignoredOrigins});
  reportRejected("close ignored observations", await Promise.allSettled(
    ignoredObservationTabIds(observations.values(), ignoredOrigins).map(closeObservation)
  ));
}

/** @param {string} operation @param {PromiseSettledResult<unknown>[]} results */
function reportRejected(operation, results) {
  for (const result of results) {
    if (result.status === "rejected") console.error(`Webby ${operation} failed`, result.reason);
  }
  return requireSettledSuccess(operation, results);
}

/**
 * @param {"activation_lookup"|"scan_injection"|"tool_cancellation"|"tool_execution"|"observation_close"|"eligibility_lookup"} operation
 * @param {unknown} error
 * @returns {"tab_gone"|"frame_gone"|null}
 */
export function transientErrorKind(operation, error) {
  const message = error instanceof Error ? error.message : String(error);
  const tabGone = ["No tab with id", "The tab was closed"].some(expected => message.includes(expected));
  const frameGone = ["Frame with ID 0 was removed", "The frame was removed"].some(expected => message.includes(expected));
  if (operation === "activation_lookup") return tabGone ? "tab_gone" : null;
  if (["scan_injection", "tool_cancellation", "tool_execution", "observation_close", "eligibility_lookup"].includes(operation)) {
    if (tabGone) return "tab_gone";
    if (frameGone) return "frame_gone";
  }
  return null;
}

runListener("worker initialization", initialize);
