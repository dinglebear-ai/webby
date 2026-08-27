import {createHash} from "node:crypto"
import {cp, readFile, readdir, stat, writeFile} from "node:fs/promises"
import {join, relative, resolve} from "node:path"

// Public RSA key material only. It pins the generated test extension ID; it
// grants no authority and must never be treated as a credential.
export const TEST_MANIFEST_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsn8O/qyhEXOoFAHttPblNRVioKLgfGI4mG/RXCht7WrRUusN6G/YbyPJuCBwJq5mxQvcDhfByvFbwFTZzLOEr7MoT6L0QF/VhleBpbLfj/GFW+xHa+VpwU5TWEWjfj+Oh4xexlgMuTBo6Q4EcGkYwlEZ6QIyCyJnKVWXzrPmmv1iX/F/pw/5owfWmBr2pDo1PMRHGNRp5iM00FKEh7o7tvQd+wtsv5SSjmZ72CY5HBv49kRU7d0RuR5kt9BDLzyQusxvJyFN5BkvMuyY8O80GL/KTTdZoyd//uAPfmUy6QPq7SN++cEA+v1ad5ic6Moh6bAjimuT3V8yMkQmqbiSrwIDAQAB"

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

export async function generateTestExtension({source, destination, fixtureUrl, world, broadHostPermissions = false}) {
  if (!world?.instance_nonce || world.environment_marker !== "isolated-e2e") throw new Error("invalid isolated world binding")
  const sourceRoot = resolve(source)
  const before = await hashExtensionTree(sourceRoot)
  await cp(sourceRoot, destination, {recursive: true, errorOnExist: true, force: false})
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
  await chrome.storage.local.set({e2eBinding: binding, baseUrl: binding.base_url});
  await initialize();
}
initializeBoundE2EWorker().catch(error => console.error("Webby E2E binding failed", error));
`
  const diagnosticWorker = productionWorker.replace(
    'console.error("Webby tab scan failed", {tabId: tab.id, error});',
    'console.error("Webby tab scan failed", {tabId: tab.id, error: error instanceof Error ? `${error.name}:${error.message}` : String(error)});',
  ).replace(
    "  const welcome = await requireChannel().messageNow(\"browser.hello\", {});",
    "  const welcome = await requireChannel().messageNow(\"browser.hello\", {});\n  await chrome.storage.local.set({e2eAuthenticatedBrowserId: channel.browserId});",
  ).replace(
    "    const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});\n    return scanTab(activeTab, true);",
    "    const {e2eScanTabId} = await chrome.storage.local.get(\"e2eScanTabId\");\n    const activeTab = e2eScanTabId ? await chrome.tabs.get(e2eScanTabId) : (await chrome.tabs.query({active: true, currentWindow: true}))[0];\n    return scanTab(activeTab, true);",
  ).replace(
    "    const observation = buildObservation(tab, result);",
    "    const observation = buildObservation(tab, result);\n    await chrome.storage.local.set({e2eLastScan: {tabId, supported: result?.result?.supported === true, toolCount: observation?.tools?.length ?? 0, documentId: result?.documentId ?? null}});",
  )
  const eventCounter = `const e2eChromeEvents = globalThis.__webbyE2EChromeEvents ??= {};
function recordE2EChromeEvent(name) {
  e2eChromeEvents[name] = (e2eChromeEvents[name] ?? 0) + 1;
  chrome.storage.local.set({e2eChromeEvents: {...e2eChromeEvents}}).catch(() => {});
}
`
  const instrumentedWorker = diagnosticWorker
    .replace('chrome.runtime.onInstalled.addListener(() => initialize());', 'chrome.runtime.onInstalled.addListener(() => { recordE2EChromeEvent("runtime.onInstalled"); return initialize(); });')
    .replace('chrome.runtime.onStartup.addListener(() => initialize());', 'chrome.runtime.onStartup.addListener(() => { recordE2EChromeEvent("runtime.onStartup"); return initialize(); });')
    .replace('chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {', 'chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {\n  recordE2EChromeEvent("tabs.onUpdated");')
    .replace('chrome.tabs.onActivated.addListener(async ({tabId}) => scanTab(await chrome.tabs.get(tabId)));', 'chrome.tabs.onActivated.addListener(async ({tabId}) => { recordE2EChromeEvent("tabs.onActivated"); return scanTab(await chrome.tabs.get(tabId)); });')
    .replace('chrome.tabs.onRemoved.addListener(async (tabId) => {', 'chrome.tabs.onRemoved.addListener(async (tabId) => {\n  recordE2EChromeEvent("tabs.onRemoved");')
    .replace('chrome.alarms.onAlarm.addListener((alarm) => {', 'chrome.alarms.onAlarm.addListener((alarm) => {\n  recordE2EChromeEvent("alarms.onAlarm");')
    .replace('chrome.permissions.onAdded.addListener(() => scanAll());', 'chrome.permissions.onAdded.addListener(() => { recordE2EChromeEvent("permissions.onAdded"); return scanAll(); });')
    .replace('chrome.permissions.onRemoved.addListener(async () => {', 'chrome.permissions.onRemoved.addListener(async () => {\n  recordE2EChromeEvent("permissions.onRemoved");')
    .replace('  if (!relevant.some((key) => key in changes)) return;', '  if (!relevant.some((key) => key in changes)) return;\n  recordE2EChromeEvent("storage.onChanged");')
    .replace('chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {', 'chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {\n  recordE2EChromeEvent("runtime.onMessage");')
  for (const symbol of ["runtime.onInstalled", "runtime.onStartup", "tabs.onUpdated", "tabs.onActivated", "tabs.onRemoved", "alarms.onAlarm", "permissions.onAdded", "permissions.onRemoved", "storage.onChanged", "runtime.onMessage"]) {
    if (!instrumentedWorker.includes(`recordE2EChromeEvent("${symbol}")`)) throw new Error(`production Chrome event contract changed: ${symbol}`)
  }
  await writeFile(workerPath, eventCounter + instrumentedWorker.slice(0, -"initialize();\n".length) + boundBootstrap, {mode: 0o600})
  const channelPath = join(destination, "src", "channel.js")
  const channel = await readFile(channelPath, "utf8")
  const socketConstruction = "    const socket = new WebSocket(url);"
  if (!channel.includes(socketConstruction)) throw new Error("production WebSocket construction contract changed")
  await writeFile(channelPath, channel
    .replace(socketConstruction, "    globalThis.__webbyE2ESocketAttempts = (globalThis.__webbyE2ESocketAttempts ?? 0) + 1;\n" + socketConstruction), {mode: 0o600})
  const after = await hashExtensionTree(sourceRoot)
  if (after !== before) throw new Error("production extension tree changed while generating test copy")
  return {path: resolve(destination), binding, productionHash: before, manifest}
}
