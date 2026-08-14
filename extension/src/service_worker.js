import {WebbyChannel} from "./channel.js";
import {buildObservation, canScanTab, stableStringify} from "./scanning.js";
import {cancelWebMcp, invokeWebMcp, probeWebMcp} from "./probe.js";
import {reconcileModeAfterRemoval} from "./permissions.js";

/** @typedef {{url: string, title: string, tools: unknown[], tab_id: number, document_id: string}} Observation */

const DEFAULTS = {baseUrl: "http://127.0.0.1:6477", scanningMode: "granted_sites", scanningPaused: false};
/** @type {WebbyChannel | undefined} */
let channel;
/** @type {Map<number | undefined, Observation>} */
let observations = new Map();

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

chrome.runtime.onInstalled.addListener(() => initialize());
chrome.runtime.onStartup.addListener(() => initialize());
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.status === "complete") scanTab(tab);
});
chrome.tabs.onActivated.addListener(async ({tabId}) => scanTab(await chrome.tabs.get(tabId)));
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await closeObservation(tabId);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "webby-periodic-scan") scanAll();
});
chrome.permissions.onAdded.addListener(() => scanAll());
chrome.permissions.onRemoved.addListener(async () => {
  await reconcileModeAfterRemoval(chrome.permissions, chrome.storage.local);
  await scanAll();
});
chrome.storage.onChanged.addListener((changes) => {
  const relevant = ["baseUrl", "browserId", "scanningMode", "scanningPaused"];
  if (!relevant.some((key) => key in changes)) return;
  if (("baseUrl" in changes || "browserId" in changes) && channel) {
    channel.close();
    channel = undefined;
  }
  initialize();
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleUiMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ok: false, kind: error.message || "request_failed"}));
  return true;
});

async function initialize() {
  await chrome.alarms.create("webby-periodic-scan", {periodInMinutes: 1});
  const settings = {...DEFAULTS, ...await chrome.storage.local.get(Object.keys(DEFAULTS))};
  const identity = await ensureIdentity();
  if (!channel) {
    channel = new WebbyChannel({
      baseUrl: settings.baseUrl,
      extensionId: chrome.runtime.id,
      browserId: identity.browserId,
      onChallenge: authenticate,
      onReady: resumeAndScan,
      onEvent: handleServerEvent
    });
    channel.connect();
  }
  if (identity.browserId) {
    await channel.message("browser.settings", {scanning_mode: settings.scanningMode, scanning_paused: settings.scanningPaused}).catch(() => {});
  }
  if (identity.browserId && !settings.scanningPaused) await scanAll();
}

/**
 * @returns {Promise<{publicKey?: string, privateKey?: JsonWebKey, browserId?: string}>}
 */
async function ensureIdentity() {
  const current = /** @type {{publicKey?: string, privateKey?: JsonWebKey, browserId?: string}} */ (
    await chrome.storage.local.get(["publicKey", "privateKey", "browserId"])
  );
  if (current.publicKey && current.privateKey) return current;
  const pair = await crypto.subtle.generateKey({name: "Ed25519"}, true, ["sign", "verify"]);
  const publicKey = encode(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  await chrome.storage.local.set({publicKey, privateKey});
  return {publicKey, privateKey};
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
  await persistIgnoredOrigins(welcome);
}

async function resumeAndScan() {
  const {browserId, pairingId} = await chrome.storage.local.get(["browserId", "pairingId"]);
  if (!browserId && pairingId) {
    const reply = await requireChannel().message("pairing.status", {pairing_id: pairingId}).catch(() => null);
    if (reply?.payload?.status === "approved" && reply.payload.browser_id) {
      await handleServerEvent({type: "pairing.approved", payload: reply.payload});
      return;
    }
  }
  if (browserId) await resync();
}

/**
 * @param {{type?: string, payload?: any} | undefined} envelope
 */
async function handleServerEvent(envelope) {
  if (envelope?.type === "pairing.approved" && envelope.payload?.browser_id) {
    if (channel?.browserId !== envelope.payload.browser_id) {
      await chrome.storage.local.set({browserId: envelope.payload.browser_id});
    }
    return;
  }
  if (envelope?.type === "tool.call") return executeToolCall(envelope.payload);
  if (envelope?.type === "tool.cancel") return cancelToolCall(envelope.payload);
}

/**
 * @param {{tab_id: number, document_id: string, call_id: string, tool_name: string, arguments?: unknown}} payload
 */
async function executeToolCall(payload) {
  const observation = observations.get(payload.tab_id);
  if (!observation || observation.document_id !== payload.document_id) {
    return sendToolError(payload.call_id, "stale_document", "The requested document is no longer active");
  }
  const expectedCatalog = stableStringify(observation.tools);
  try {
    const [execution] = await chrome.scripting.executeScript({
      target: {tabId: payload.tab_id, documentIds: [payload.document_id]},
      world: "MAIN",
      func: invokeWebMcp,
      args: [payload.tool_name, payload.arguments ?? {}, payload.call_id, expectedCatalog]
    });
    const result = execution?.result;
    if (encodedSize(result) > 131_072 || jsonDepth(result) > 32) throw new Error("result_too_large");
    await requireChannel().message("tool.result", {call_id: payload.call_id, result});
  } catch (error) {
    const message = error instanceof Error ? error.message : undefined;
    const kind = knownToolError(message) ? /** @type {string} */ (message) : "tool_failed";
    await sendToolError(payload.call_id, kind, "The page tool could not be completed");
  }
}

/**
 * @param {{document_id: string, call_id: string}} payload
 */
async function cancelToolCall(payload) {
  const observation = [...observations.values()].find((entry) => entry.document_id === payload.document_id);
  if (!observation) return;
  await chrome.scripting.executeScript({
    target: {tabId: observation.tab_id, documentIds: [observation.document_id]},
    world: "MAIN", func: cancelWebMcp, args: [payload.call_id]
  }).catch(() => {});
}

/**
 * @param {string} callId
 * @param {string} kind
 * @param {string} message
 */
function sendToolError(callId, kind, message) {
  return requireChannel().message("tool.error", {call_id: callId, error: {kind, message}}).catch(() => {});
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
  return kind !== undefined && ["webmcp_unavailable", "stale_catalog", "tool_not_found", "AbortError"].includes(kind);
}

async function scanAll() {
  const settings = {...DEFAULTS, ...await chrome.storage.local.get(Object.keys(DEFAULTS))};
  if (settings.scanningPaused) return;
  const tabs = await chrome.tabs.query({});
  // Not `tabs.map(scanTab)`: map passes the index as the second argument, so
  // every tab after the first would arrive with allowActiveTab truthy and skip
  // the canScanTab check -- incognito, ineligible URLs, and origins the user
  // never granted included.
  await Promise.allSettled(tabs.map((tab) => scanTab(tab)));
}

/**
 * @param {chrome.tabs.Tab | undefined} tab
 * @param {boolean} [allowActiveTab]
 */
async function scanTab(tab, allowActiveTab = false) {
  const settings = {...DEFAULTS, ...await chrome.storage.local.get(Object.keys(DEFAULTS))};
  if (settings.scanningPaused || (!allowActiveTab && !(await canScanTab(tab, chrome.permissions)))) return;
  if (!tab?.id || !tab.url) return;
  const {ignoredOrigins = []} = /** @type {{ignoredOrigins?: string[]}} */ (await chrome.storage.local.get("ignoredOrigins"));
  if (ignoredOrigins.includes(new URL(tab.url).origin)) return;
  try {
    const [result] = await chrome.scripting.executeScript({target: {tabId: tab.id}, world: "MAIN", func: probeWebMcp});
    const observation = buildObservation(tab, result);
    if (!observation) {
      if (result?.documentId) await closeObservation(tab.id);
      return;
    }
    observations.set(tab.id, observation);
    const reply = await channel?.message("discovery.observed", {observations: [observation]});
    await persistIgnoredOrigins(reply);
  } catch {
    // Restricted, navigated, or closed tabs are expected and are not discoveries.
  }
}

/**
 * @param {number | undefined} tabId
 */
async function closeObservation(tabId) {
  const observation = observations.get(tabId);
  observations.delete(tabId);
  if (!observation?.document_id) return;
  await channel?.message("session.closed", {
    tab_id: tabId,
    document_id: observation.document_id
  }).catch(() => {});
}

async function resync() {
  const reply = await requireChannel().message("browser.resync", {observations: [...observations.values()]});
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
    const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
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
  if (Array.isArray(ignoredOrigins)) await chrome.storage.local.set({ignoredOrigins});
}

initialize();
