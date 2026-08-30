import {createHash} from "node:crypto"
import {copyFile, lstat, mkdir, readFile, readdir, stat, writeFile} from "node:fs/promises"
import {join, relative, resolve} from "node:path"

// Public RSA key material only. It pins the generated test extension ID; it
// grants no authority and must never be treated as a credential.
export const TEST_MANIFEST_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsn8O/qyhEXOoFAHttPblNRVioKLgfGI4mG/RXCht7WrRUusN6G/YbyPJuCBwJq5mxQvcDhfByvFbwFTZzLOEr7MoT6L0QF/VhleBpbLfj/GFW+xHa+VpwU5TWEWjfj+Oh4xexlgMuTBo6Q4EcGkYwlEZ6QIyCyJnKVWXzrPmmv1iX/F/pw/5owfWmBr2pDo1PMRHGNRp5iM00FKEh7o7tvQd+wtsv5SSjmZ72CY5HBv49kRU7d0RuR5kt9BDLzyQusxvJyFN5BkvMuyY8O80GL/KTTdZoyd//uAPfmUy6QPq7SN++cEA+v1ad5ic6Moh6bAjimuT3V8yMkQmqbiSrwIDAQAB"

// The unpacked extension is a runtime artifact, not a source checkout. Keep
// this allowlist aligned with manifest entrypoints and their static imports so
// tests, package metadata, node_modules, and symlinks can never enter a browser
// profile or the world ownership audit.
export const RUNTIME_EXTENSION_FILES = Object.freeze([
  "manifest.json",
  "src/base_url.js",
  "src/channel.js",
  "src/orchestration.js",
  "src/permissions.js",
  "src/popup.css",
  "src/popup.html",
  "src/popup.js",
  "src/probe.js",
  "src/scanning.js",
  "src/service_worker.js",
])

export function extensionIdForKey(key = TEST_MANIFEST_KEY) {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)
  return [...hex].map(character => String.fromCharCode(97 + Number.parseInt(character, 16))).join("")
}

async function treeEntries(root, directory = root) {
  const entries = []
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name)
    const info = await stat(path)
    if (info.isDirectory()) entries.push(...await treeEntries(root, path))
    else if (info.isFile()) entries.push({path, relative: relative(root, path)})
    else throw new Error(`unsupported extension tree entry: ${path}`)
  }
  return entries
}

export async function hashExtensionTree(root) {
  const digest = createHash("sha256")
  for (const entry of await treeEntries(resolve(root))) {
    digest.update(entry.relative).update("\0").update(await readFile(entry.path)).update("\0")
  }
  return digest.digest("hex")
}

function exactFixturePattern(fixtureUrl) {
  const url = new URL(fixtureUrl)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
    throw new Error("fixture origin must be an allocated IPv4 loopback HTTP origin")
  }
  // Chromium's installed host-permission representation is host-scoped. The
  // generated binding below pins the exact allocated authority (including
  // port), and the driver refuses every other authority before navigation.
  return `${url.protocol}//${url.hostname}/*`
}

function replaceExactlyOnce(source, needle, replacement, label) {
  const parts = source.split(needle)
  if (parts.length !== 2) throw new Error(`production instrumentation seam must occur exactly once: ${label}`)
  return parts[0] + replacement + parts[1]
}

function applyInstrumentation(source, rules) {
  return rules.reduce((current, {needle, replacement, label}) => replaceExactlyOnce(current, needle, replacement, label), source)
}

async function copyRuntimeExtension(sourceRoot, destination) {
  await mkdir(destination, {recursive: false, mode: 0o700})
  for (const relativePath of RUNTIME_EXTENSION_FILES) {
    const sourcePath = join(sourceRoot, relativePath)
    const info = await lstat(sourcePath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`runtime extension source must be an owned regular file: ${relativePath}`)
    const targetPath = join(destination, relativePath)
    await mkdir(resolve(targetPath, ".."), {recursive: true, mode: 0o700})
    await copyFile(sourcePath, targetPath)
  }
}

export async function generateTestExtension({source, destination, fixtureUrl, world, broadHostPermissions = false}) {
  if (!world?.instance_nonce || world.environment_marker !== "isolated-e2e") throw new Error("invalid isolated world binding")
  const sourceRoot = resolve(source)
  const before = await hashExtensionTree(sourceRoot)
  await copyRuntimeExtension(sourceRoot, destination)
  const manifestPath = join(destination, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.key = TEST_MANIFEST_KEY
  manifest.host_permissions = broadHostPermissions ? ["http://*/*", "https://*/*"] : [exactFixturePattern(fixtureUrl)]
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o600})
  const binding = {
    schema_version: 1,
    expected_extension_id: extensionIdForKey(),
    instance_nonce: world.instance_nonce,
    environment_marker: world.environment_marker,
    base_url: world.base_url,
    fixture_url: new URL(fixtureUrl).origin,
  }
  await writeFile(join(destination, "e2e-binding.json"), `${JSON.stringify(binding, null, 2)}\n`, {mode: 0o600})
  const workerPath = join(destination, "src", "service_worker.js")
  const productionWorker = await readFile(workerPath, "utf8")
  if (!productionWorker.endsWith("initialize();\n")) throw new Error("production service-worker bootstrap contract changed")
  const boundBootstrap = `async function initializeBoundE2EWorker() {
  const binding = await (await fetch(chrome.runtime.getURL("e2e-binding.json"))).json();
  if (chrome.runtime.id !== binding.expected_extension_id) throw new Error("runtime extension ID mismatch");
  if (binding.environment_marker !== "isolated-e2e" || new URL(binding.base_url).port === "6477") throw new Error("invalid E2E binding");
  globalThis.__webbyE2EWorkerNonce = crypto.randomUUID();
  await chrome.storage.local.set({e2eBinding: binding, baseUrl: binding.base_url});
  await initialize();
}
initializeBoundE2EWorker().catch(error => console.error("Webby E2E binding failed", error));
`
  const diagnosticWorker = applyInstrumentation(productionWorker, [
    {label: "scan-error", needle: 'console.error("Webby tab scan failed", {tabId: tab.id, error});', replacement: 'console.error("Webby tab scan failed", {tabId: tab.id, error: error instanceof Error ? `${error.name}:${error.message}` : String(error)});'},
    {label: "authenticated", needle: '  const welcome = await requireChannel().messageNow("browser.hello", {});', replacement: '  const welcome = await requireChannel().messageNow("browser.hello", {});\n  await chrome.storage.local.set({e2eAuthenticatedBrowserId: channel.browserId, e2eAuthenticatedWorkerNonce: globalThis.__webbyE2EWorkerNonce});'},
    {label: "channel-ready", needle: "      onReady: resumeAndScan,", replacement: "      onReady: async () => { await chrome.storage.local.set({e2eChannelReadyNonce: globalThis.__webbyE2EWorkerNonce}); return resumeAndScan(); },"},
    {label: "scan-target", needle: '    const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});\n    return scanTab(activeTab, true);', replacement: '    const {e2eScanTabId} = await chrome.storage.local.get("e2eScanTabId");\n    const activeTab = e2eScanTabId ? await chrome.tabs.get(e2eScanTabId) : (await chrome.tabs.query({active: true, currentWindow: true}))[0];\n    return scanTab(activeTab, true);'},
    {label: "scan-result", needle: "    const observation = buildObservation(tab, result);", replacement: "    const observation = buildObservation(tab, result);\n    await chrome.storage.local.set({e2eLastScan: {tabId, supported: result?.result?.supported === true, toolCount: observation?.tools?.length ?? 0, documentId: result?.documentId ?? null}});"},
  ])
  const eventCounter = `const e2eChromeEvents = globalThis.__webbyE2EChromeEvents ??= {};
function recordE2EChromeEvent(name) {
  e2eChromeEvents[name] = (e2eChromeEvents[name] ?? 0) + 1;
  chrome.storage.local.set({e2eChromeEvents: {...e2eChromeEvents}}).catch(() => {});
}
`
  let instrumentedWorker = replaceExactlyOnce(diagnosticWorker, 'function scanAll() {\n  return fullScanScheduler.run();\n}', 'async function scanAll() {\n  const result = await fullScanScheduler.run();\n  globalThis.__webbyE2EScanAllCompletions = (globalThis.__webbyE2EScanAllCompletions ?? 0) + 1;\n  await chrome.storage.local.set({e2eScanAllCompletions: globalThis.__webbyE2EScanAllCompletions});\n  return result;\n}', "scan-completion")
  instrumentedWorker = applyInstrumentation(instrumentedWorker, [
    {label: "runtime.onInstalled", needle: 'chrome.runtime.onInstalled.addListener(() => initialize());', replacement: 'chrome.runtime.onInstalled.addListener(() => { recordE2EChromeEvent("runtime.onInstalled"); return initialize(); });'},
    {label: "runtime.onStartup", needle: 'chrome.runtime.onStartup.addListener(() => initialize());', replacement: 'chrome.runtime.onStartup.addListener(() => { recordE2EChromeEvent("runtime.onStartup"); return initialize(); });'},
    {label: "tabs.onUpdated", needle: 'chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {', replacement: 'chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {\n  recordE2EChromeEvent("tabs.onUpdated");'},
    {label: "tabs.onActivated", needle: 'chrome.tabs.onActivated.addListener(async ({tabId}) => scanTab(await chrome.tabs.get(tabId)));', replacement: 'chrome.tabs.onActivated.addListener(async ({tabId}) => { recordE2EChromeEvent("tabs.onActivated"); return scanTab(await chrome.tabs.get(tabId)); });'},
    {label: "tabs.onRemoved", needle: 'chrome.tabs.onRemoved.addListener(async (tabId) => {', replacement: 'chrome.tabs.onRemoved.addListener(async (tabId) => {\n  recordE2EChromeEvent("tabs.onRemoved");'},
    {label: "alarms.onAlarm", needle: 'chrome.alarms.onAlarm.addListener((alarm) => {', replacement: 'chrome.alarms.onAlarm.addListener((alarm) => {\n  recordE2EChromeEvent("alarms.onAlarm");'},
    {label: "permissions.onAdded", needle: 'chrome.permissions.onAdded.addListener(() => scanAll());', replacement: 'chrome.permissions.onAdded.addListener(() => { recordE2EChromeEvent("permissions.onAdded"); return scanAll(); });'},
    {label: "permissions.onRemoved", needle: 'chrome.permissions.onRemoved.addListener(async () => {', replacement: 'chrome.permissions.onRemoved.addListener(async () => {\n  recordE2EChromeEvent("permissions.onRemoved");'},
    {label: "storage.onChanged", needle: '  if (!relevant.some((key) => key in changes)) return;', replacement: '  if (!relevant.some((key) => key in changes)) return;\n  recordE2EChromeEvent("storage.onChanged");'},
    {label: "runtime.onMessage", needle: 'chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {', replacement: 'chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {\n  recordE2EChromeEvent("runtime.onMessage");'},
  ])
  await writeFile(workerPath, eventCounter + instrumentedWorker.slice(0, -"initialize();\n".length) + boundBootstrap, {mode: 0o600})
  const channelPath = join(destination, "src", "channel.js")
  const channel = await readFile(channelPath, "utf8")
  const socketConstruction = "    const socket = new WebSocket(url);"
  if (!channel.includes(socketConstruction)) throw new Error("production WebSocket construction contract changed")
  const frameSend = "    this.socket.send(JSON.stringify([this.joinRef, ref, this.topic, event, payload]));"
  const frameReceive = "    const [_joinRef, ref, topic, event, payload] = frame;"
  if (!channel.includes(frameSend) || !channel.includes(frameReceive)) throw new Error("production WebSocket frame contract changed")
  const protocolRecorder = `const e2eProtocolEvents = globalThis.__webbyE2EProtocolEvents ??= [];
const e2eProtocolRefs = globalThis.__webbyE2EProtocolRefs ??= {};
function recordE2EProtocolEvent(value) {
  e2eProtocolEvents.push({...value, sequence: e2eProtocolEvents.length + 1});
  chrome.storage.local.set({e2eProtocolEvents: e2eProtocolEvents.slice(-256)}).catch(() => {});
}
`
  const instrumentedChannel = applyInstrumentation(channel, [
    {label: "socket-construction", needle: socketConstruction, replacement: "    globalThis.__webbyE2ESocketAttempts = (globalThis.__webbyE2ESocketAttempts ?? 0) + 1;\n" + socketConstruction},
    {label: "frame-send", needle: frameSend, replacement: "    e2eProtocolRefs[ref] = payload?.type ?? event;\n    recordE2EProtocolEvent({direction: \"out\", ref, event, type: e2eProtocolRefs[ref], observations: payload?.payload?.observations?.map(value => { let sanitized_url = null; try { const parsed = new URL(value.url); sanitized_url = parsed.origin + parsed.pathname; } catch {} return {tab_id: value.tab_id, document_id: value.document_id, catalog_revision: value.catalog_revision, sanitized_url}; }) ?? []});\n" + frameSend},
    {label: "frame-receive", needle: frameReceive, replacement: frameReceive + "\n    recordE2EProtocolEvent({direction: \"in\", ref, event, type: e2eProtocolRefs[ref] ?? event, status: payload?.status ?? null, observation_count: payload?.response?.payload?.observation_count ?? null});"},
  ])
  await writeFile(channelPath, protocolRecorder + instrumentedChannel, {mode: 0o600})
  const after = await hashExtensionTree(sourceRoot)
  if (after !== before) throw new Error("production extension tree changed while generating test copy")
  return {path: resolve(destination), binding, productionHash: before, manifest}
}
