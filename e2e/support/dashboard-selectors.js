const recordId = /^[0-9a-f-]{36}$/

export const dashboardSelectors = Object.freeze({
  root: "main [data-status]",
  access: "#mcp-access",
  pairing: "#browser-pairing",
  browsers: "#paired-browsers",
  discoveries: "#discovery-inbox",
  registrations: "#page-registrations",
  token: "#mcp-credential-token",
  allTabsDisclosure: "#all-tabs-disclosure",
})

export const dashboardEventContract = Object.freeze([
  {event: "approve-pairing", section: "pairing", action: "Approve", state: "browser"},
  {event: "reject-pairing", section: "pairing", action: "Reject", state: "absent"},
  {event: "revoke-browser", section: "browsers", action: "Revoke", state: "revoked"},
  {event: "ignore-discovery", section: "discoveries", action: "Ignore", state: "absent"},
  {event: "register-discovery", section: "discoveries", action: "Register page", state: "registration"},
  {event: "create-mcp-credential", section: "access", action: "Create read credential|Create call credential", state: "token"},
  {event: "revoke-mcp-credential", section: "access", action: "Revoke", state: "revoked"},
])

export const dashboardExclusions = Object.freeze({
  "invocation-audit-dom": {
    reason: "Invocation audits are not rendered by DashboardLive.",
    owners: ["artifact-recorder", "webby-ihb.15", "webby-ihb.16"],
  },
  "popup-pause-resume-scan-mode": {
    reason: "These controls exist only in the extension popup.",
    owners: ["webby-ihb.17", "webby-ihb.18", "webby-ihb.19"],
  },
  "native-disabled-attribute": {
    reason: "DashboardLive buttons expose LiveView's visible phx-click-loading state, not a disabled attribute; removed/revoked actions are detached.",
    owners: ["DashboardLive"],
  },
})

export function recordSelector(kind, id) {
  if (!new Set(["pairing", "browser", "discovery", "registration", "mcp-credential"]).has(kind)) throw new Error("unknown dashboard record kind")
  if (!recordId.test(id)) throw new Error("invalid dashboard record ID")
  return `#${kind}-${id}`
}
