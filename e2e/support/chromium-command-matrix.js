export const chromiumCommandRows = Object.freeze([
  ["popup:base-url", "popup.valid-and-deceptive-endpoints"],
  ["popup:mode", "popup.granted-sites-and-all-tabs"],
  ["popup:paused", "popup.pause-and-resume"],
  ["popup:save", "popup.save"],
  ["popup:scan", "popup.manual-scan"],
  ["popup:pair", "pairing.pending-rejected-approved-duplicate"],
  ["ext-command:pair", "pairing.pending-rejected-approved-duplicate"],
  ["ext-command:scan", "popup.manual-scan"],
  ["ext-event:approved", "pairing.approved"],
  ["chrome-event:installed", "chrome.runtime.onInstalled"],
  ["chrome-event:startup", "chrome.runtime.onStartup"],
  ["chrome-event:tab-updated", "chrome.tabs.onUpdated"],
  ["chrome-event:tab-activated", "chrome.tabs.onActivated"],
  ["chrome-event:tab-removed", "chrome.tabs.onRemoved"],
  ["chrome-event:alarm", "chrome.alarms.onAlarm"],
  ["chrome-event:permission-added", "chrome.permissions.onAdded"],
  ["chrome-event:permission-removed", "chrome.permissions.onRemoved"],
  ["chrome-event:storage", "chrome.storage.onChanged"],
  ["chrome-event:message", "chrome.runtime.onMessage"],
  ["storage:base-url", "popup.valid-endpoint-durable"],
  ["storage:browser-id", "pairing.approved-durable"],
  ["storage:scanning-mode", "popup.mode-durable-public"],
  ["storage:scanning-paused", "popup.pause-durable-public"],
  ["storage:public-key", "pairing.identity-public"],
  ["storage:private-key", "pairing.identity-secret-zone"],
  ["storage:pairing-id", "pairing.pending-durable"],
  ["storage:ignored-origins", "discovery.ignore-durable"],
  ["manifest:key", "chromium-bootstrap.generated-copy"],
  ["manifest:generated-copy", "chromium-bootstrap.generated-copy"],
])

export const chromiumReadActions = Object.freeze([
  "status", "browser.list", "discovery.list", "discovery.get", "page.list", "page.get", "page.tools",
])

export const pairingStates = Object.freeze(["pending", "approved", "rejected", "duplicate"])

export const chromiumAdapterExclusions = Object.freeze({
  "chrome-event:startup": {
    source_symbol: "chrome.runtime.onStartup",
    owner: "webby-ihb.17",
    rationale: "Bundled headless Chromium does not dispatch runtime.onStartup when a Playwright persistent context is relaunched. The listener remains generated-copy instrumented for drift and restart identity/recovery is asserted across the real context boundary.",
    reviewed_on: "2026-08-27",
    adapter: "chromium-headless",
  },
  "chrome-event:permission-added": {
    source_symbol: "chrome.permissions.onAdded",
    owner: "webby-ihb.17",
    rationale: "Bundled headless Chromium exposes no permission-prompt acceptance API. The all-tabs popup path is exercised with the permission pregranted in the generated copy; removal is dispatched by Chromium and add-listener semantics remain covered by extension unit tests.",
    reviewed_on: "2026-08-27",
    adapter: "chromium-headless",
  },
  "chrome-event:permission-removed": {
    source_symbol: "chrome.permissions.onRemoved",
    owner: "webby-ihb.17",
    rationale: "Required host permissions in the generated all-tabs copy cannot be removed, while optional host permission prompts cannot be accepted through bundled headless Chromium. Listener semantics remain covered by extension unit tests and revocation lifecycle is owned by webby-ihb.19.",
    reviewed_on: "2026-08-27",
    adapter: "chromium-headless",
  },
  "pairing:expired": {
    source_symbol: "Webby.Browsers @pairing_ttl 300",
    owner: "webby-ihb.17",
    rationale: "The production five-minute expiry cannot be shortened through a public boundary and fixed waits are forbidden. Expiry is exhaustively exercised by the simulated live adapter; Chromium covers pending, duplicate, rejected, and approved states.",
    reviewed_on: "2026-08-27",
    adapter: "chromium",
  },
})

export const dashboardScenarioReuse = Object.freeze({
  source: "e2e/support/dashboard-selectors.js#dashboardEventContract",
  test: "e2e/test/dashboard-commands.test.js",
  reason: "Chromium executes the shared dashboard IDs; it does not redefine the seven-event matrix.",
})

export function assertChromiumCommandCoverage(surfaces) {
  const eligible = surfaces.filter(surface => new Set([
    "popup_control", "extension_command", "extension_event", "chrome_event_registration",
    "extension_storage", "test_extension_manifest",
  ]).has(surface.category) && surface.id !== "ext-event:call" && surface.id !== "ext-event:cancel")
  const mapped = new Map(chromiumCommandRows)
  const missing = eligible.filter(surface => !mapped.has(surface.id)).map(surface => surface.id)
  const stale = [...mapped.keys()].filter(id => !eligible.some(surface => surface.id === id))
  if (missing.length || stale.length) throw new Error(`Chromium command coverage drift: missing=${missing.join(",")} stale=${stale.join(",")}`)
  return {eligible: eligible.length, mapped: mapped.size, percent: eligible.length ? mapped.size / eligible.length * 100 : 0}
}
