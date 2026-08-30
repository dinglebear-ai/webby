import {readFile} from "node:fs/promises"

const matrixUrl = new URL("../contracts/lifecycle-matrix.json", import.meta.url)

export const chromiumLifecycleOperations = Object.freeze([
  {id: "scan.granted_sites", execution: "local", source: "extension/src/service_worker.js", symbol: "scanningMode", evidence: "e2e/test/chromium/popup-commands.test.js"},
  {id: "scan.all_tabs", execution: "local", source: "extension/src/permissions.js", symbol: "enableAllTabs", evidence: "e2e/test/chromium/permissions-lifecycle.test.js"},
  {id: "origin.ignore", execution: "shared-owner", owner: "webby-ihb.17", source: "extension/src/scanning.js", symbol: "ignoredObservationTabIds", evidence: "e2e/test/chromium/pairing-discovery.test.js"},
  {id: "scan.pause", execution: "local", source: "extension/src/orchestration.js", symbol: "executionAllowed", evidence: "e2e/test/chromium/permissions-lifecycle.test.js"},
  {id: "permission.revoke", execution: "reviewed-exclusion", source: "extension/src/permissions.js", symbol: "reconcileModeAfterRemoval", exclusion: "permission-revoke"},
  {id: "consent.prompt", execution: "reviewed-exclusion", source: "extension/src/permissions.js", symbol: "enableAllTabs", exclusion: "consent-prompt"},
  {id: "browser.revoke", execution: "local", source: "lib/webby_web/live/dashboard_live.ex", symbol: "revoke-browser", evidence: "e2e/test/chromium/permissions-lifecycle.test.js"},
  {id: "credential.revoke", execution: "shared-owner", owner: "webby-ihb.14", source: "lib/webby_web/live/dashboard_live.ex", symbol: "revoke-mcp-credential", evidence: "e2e/test/scenarios/protocol-cancellation-races.test.js"},
  {id: "socket.reconnect", execution: "local", source: "extension/src/channel.js", symbol: "reconnect", evidence: "e2e/test/chromium/reconnect-restart.test.js"},
  {id: "webby.restart", execution: "local", source: "e2e/support/world.js", symbol: "restart", evidence: "e2e/test/chromium/reconnect-restart.test.js"},
  {id: "worker.restart", execution: "local", source: "e2e/support/extension-driver.js", symbol: "suspendAndReacquireWorker", evidence: "e2e/test/chromium/permissions-lifecycle.test.js"},
  {id: "chromium.restart", execution: "local", source: "e2e/support/chromium-world.js", symbol: "launch", evidence: "e2e/test/chromium/reconnect-restart.test.js"},
  {id: "profile.identity", execution: "local", source: "extension/src/service_worker.js", symbol: "ensureIdentity", evidence: "e2e/test/chromium/reconnect-restart.test.js"},
  {id: "stale.cache", execution: "shared-owner", owner: "webby-ihb.15", source: "extension/src/service_worker.js", symbol: "expectedCatalog", evidence: "e2e/test/chromium/invocation-tools.test.js"},
  {id: "prompt.capacity", execution: "shared-owner", owner: "webby-ihb.14", source: "lib/webby/browser_connections.ex", symbol: "pending", evidence: "e2e/test/chromium/invocation-tools.test.js"},
].map(Object.freeze))

export const chromiumLifecycleExclusions = Object.freeze({
  "permission-revoke": Object.freeze({
    owner: "webby-ihb.19",
    source: "extension/src/permissions.js",
    symbol: "reconcileModeAfterRemoval",
    reviewed_on: "2026-08-27",
    rationale: "Playwright's bundled headless Chromium cannot accept an optional host-permission prompt. Required generated-copy host permissions cannot be removed, so a real removal transition cannot be established without bypassing Chromium's permission model.",
  }),
  "consent-prompt": Object.freeze({
    owner: "webby-ihb.19",
    source: "extension/src/permissions.js",
    symbol: "enableAllTabs",
    reviewed_on: "2026-08-30",
    rationale: "Playwright's bundled headless Chromium exposes no API to accept the extension optional-host-permission prompt. The real popup denial and pregranted all-tabs paths are executable; prompt acceptance remains unreachable without bypassing Chromium consent.",
  }),
})

export async function chromiumLifecycleInventory() {
  const matrix = JSON.parse(await readFile(matrixUrl, "utf8"))
  const eligible = matrix.transitions.filter(row => row.drivers.includes("chromium"))
  const owned = eligible.filter(row => row.owner === "webby-ihb.19")
  const exclusions = new Set(Object.keys(chromiumLifecycleExclusions))
  const mapped = new Set(["service-worker-restart", "chromium-restart"])
  for (const row of owned) {
    if (!mapped.has(row.id) && !exclusions.has(row.id)) throw new Error(`unmapped Chromium lifecycle row: ${row.id}`)
  }
  const operationIds = new Set(chromiumLifecycleOperations.map(row => row.id))
  if (operationIds.size !== chromiumLifecycleOperations.length) throw new Error("duplicate Chromium lifecycle operation")
  for (const operation of chromiumLifecycleOperations) {
    if (!new Set(["local", "shared-owner", "reviewed-exclusion"]).has(operation.execution)) throw new Error(`invalid Chromium lifecycle execution mapping: ${operation.id}`)
    if (operation.execution === "shared-owner" && !operation.owner) throw new Error(`missing shared lifecycle owner: ${operation.id}`)
    if (operation.exclusion && !exclusions.has(operation.exclusion)) throw new Error(`missing reviewed exclusion: ${operation.exclusion}`)
    if (!operation.exclusion && !operation.evidence) throw new Error(`unmapped Chromium lifecycle operation: ${operation.id}`)
  }
  return Object.freeze({eligible, owned, mapped, exclusions, operations: chromiumLifecycleOperations, operationCoverage: {eligible: chromiumLifecycleOperations.length, mapped: chromiumLifecycleOperations.length - exclusions.size, excluded: exclusions.size, percent: 100}})
}

export function assertLifecycleEvidence(evidence, expectedTransitions) {
  const actual = new Set(Object.keys(evidence))
  for (const transition of expectedTransitions) {
    if (!actual.has(transition)) throw new Error(`missing Chromium lifecycle evidence: ${transition}`)
    const row = evidence[transition]
    for (const key of ["browser", "page", "dashboard", "terminal", "capacity", "cleanup"]) if (row[key] === undefined || row[key] === null) throw new Error(`${transition}: ${key} observation is missing`)
    if (row.capacity !== 0) throw new Error(`${transition}: capacity was not released`)
    if (row.cleanup !== "bounded") throw new Error(`${transition}: cleanup was not bounded`)
  }
  return {eligible: expectedTransitions.length, mapped: actual.size, percent: actual.size === expectedTransitions.length ? 100 : 0}
}
