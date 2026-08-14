import {WebbyChannel} from "./channel.js";
import {buildObservation, canScanTab, stableStringify} from "./scanning.js";
import {cancelWebMcp, invokeWebMcp, probeWebMcp} from "./probe.js";
import {reconcileModeAfterRemoval} from "./permissions.js";

const DEFAULTS = {baseUrl: "http://127.0.0.1:6477", scanningMode: "granted_sites", scanningPaused: false};
let channel;
let observations = new Map();

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

async function ensureIdentity() {
  const current = await chrome.storage.local.get(["publicKey", "privateKey", "browserId"]);
  if (current.publicKey && current.privateKey) return current;
  const pair = await crypto.subtle.generateKey({name: "Ed25519"}, true, ["sign", "verify"]);
  const publicKey = encode(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  await chrome.storage.local.set({publicKey, privateKey});
  return {publicKey, privateKey};
}

async function authenticate(challenge) {
  const {privateKey} = await chrome.storage.local.get("privateKey");
  const key = await crypto.subtle.importKey("jwk", privateKey, {name: "Ed25519"}, false, ["sign"]);
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(challenge.signed_message));
  await channel.messageNow("auth.respond", {challenge_id: challenge.challenge_id, signature: encode(signature)});
  const welcome = await channel.messageNow("browser.hello", {});
  await persistIgnoredOrigins(welcome);
}

async function resumeAndScan() {
  const {browserId, pairingId} = await chrome.storage.local.get(["browserId", "pairingId"]);
  if (!browserId && pairingId) {
    const reply = await channel.message("pairing.status", {pairing_id: pairingId}).catch(() => null);
    if (reply?.payload?.status === "approved" && reply.payload.browser_id) {
      await handleServerEvent({type: "pairing.approved", payload: reply.payload});
      return;
    }
  }
  if (browserId) await resync();
}

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
    await channel.message("tool.result", {call_id: payload.call_id, result});
  } catch (error) {
    const kind = knownToolError(error?.message) ? error.message : "tool_failed";
    await sendToolError(payload.call_id, kind, "The page tool could not be completed");
  }
}

async function cancelToolCall(payload) {
  const observation = [...observations.values()].find((entry) => entry.document_id === payload.document_id);
  if (!observation) return;
  await chrome.scripting.executeScript({
    target: {tabId: observation.tab_id, documentIds: [observation.document_id]},
    world: "MAIN", func: cancelWebMcp, args: [payload.call_id]
  }).catch(() => {});
}

function sendToolError(callId, kind, message) {
  return channel.message("tool.error", {call_id: callId, error: {kind, message}}).catch(() => {});
}

function encodedSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function jsonDepth(value, depth = 0) {
  if (!value || typeof value !== "object") return depth;
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.reduce((maximum, item) => Math.max(maximum, jsonDepth(item, depth + 1)), depth);
}

function knownToolError(kind) {
  return ["webmcp_unavailable", "stale_catalog", "tool_not_found", "AbortError"].includes(kind);
}

async function scanAll() {
  const settings = {...DEFAULTS, ...await chrome.storage.local.get(Object.keys(DEFAULTS))};
  if (settings.scanningPaused) return;
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(scanTab));
}

async function scanTab(tab, allowActiveTab = false) {
  const settings = {...DEFAULTS, ...await chrome.storage.local.get(Object.keys(DEFAULTS))};
  if (settings.scanningPaused || (!allowActiveTab && !(await canScanTab(tab, chrome.permissions)))) return;
  const {ignoredOrigins = []} = await chrome.storage.local.get("ignoredOrigins");
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
  const reply = await channel.message("browser.resync", {observations: [...observations.values()]});
  await persistIgnoredOrigins(reply);
  await scanAll();
}

async function handleUiMessage(message) {
  if (message.type === "pair") {
    const identity = await ensureIdentity();
    const reply = await channel.message("pairing.request", {display_name: message.displayName || "Chrome", public_key: identity.publicKey, scanning_mode: "granted_sites"});
    if (reply?.payload?.pairing_id) await chrome.storage.local.set({pairingId: reply.payload.pairing_id});
    return reply;
  }
  if (message.type === "scan-now") {
    const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
    return scanTab(activeTab, true);
  }
  return {ok: true};
}

function encode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function persistIgnoredOrigins(envelope) {
  const ignoredOrigins = envelope?.payload?.ignored_origins;
  if (Array.isArray(ignoredOrigins)) await chrome.storage.local.set({ignoredOrigins});
}

initialize();
