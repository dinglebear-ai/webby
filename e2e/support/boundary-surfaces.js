import {createHash} from "node:crypto"

const boundaries = Object.freeze({
  "e2e-shared-vertical-slice": Object.freeze({
    "health.request": ["http:get-root", "http:get-health", "behavior:health", "capability:world-nonce", "world-field:manifest-version", "world-field:world-id", "world-field:base-url", "world-field:artifacts", "world-field:scenario-id", "artifact:timeline", "artifact:manifest"],
    "browser.pair": ["topic:auth", "topic:pairing", "in:pairing-request", "in:pairing-status", "in:auth-respond", "in:browser-hello", "out:auth-challenge", "out:auth-accepted", "out:pairing-pending", "out:pairing-status", "out:pairing-approved", "out:browser-welcome", "dashboard:approve"],
    "discovery.publish": ["in:browser-resync", "in:discovery-observed", "out:ack", "dashboard:register"],
    "credential.create": ["dashboard:create-credential"],
    "mcp.invoke": ["http:post-mcp", "in:tool-result", "out:tool-call", "mcp:initialize", "mcp:tools-list", "mcp:tools-call", "mcp:initialized", "action:status", "action:browser-list", "action:discovery-list", "action:discovery-get", "action:page-list", "action:page-get", "action:page-tools", "action:page-call", "version:2026", "version:2025-11", "version:2025-06", "version:2025-03", "fixture:side-effect"],
    "audit.observe": ["artifact:server-log", "artifact:dashboard"],
  }),
  "e2e-lifecycle-removal": Object.freeze({
    "lifecycle.trigger": ["out:tool-cancel", "mcp:cancelled", "dashboard:revoke-browser", "dashboard:ignore", "dashboard:revoke-credential", "ext-event:cancel", "chrome-event:tab-removed", "chrome-event:permission-removed"],
    "lifecycle.observe-terminal": ["in:session-closed", "storage:ignored-origins", "behavior:retention"],
    "lifecycle.recover": ["in:browser-resync", "in:browser-settings"],
  }),
  "e2e-fixture-tool-outcomes": Object.freeze({
    "fixture.discover": ["in:discovery-observed", "capability:fixture", "world-field:fixture-url"],
    "fixture.invoke-matrix": ["in:tool-result", "in:tool-error", "out:tool-call", "mcp:tools-call", "action:page-call", "ext-event:call", "ext-event:cancel", "fixture:json", "fixture:text", "fixture:throw", "fixture:delay", "fixture:cancel", "fixture:oversized", "fixture:deep", "fixture:side-effect"],
    "fixture.mutate": [],
  }),
})

const hasText = value => typeof value === "string" && value.length > 0
const positive = value => Number.isInteger(value) && value > 0
const freeze = value => Object.freeze(value)
const eventShape = event => event && typeof event === "object" && positive(event.sequence) && hasText(event.type)
const category = surfaceId => surfaceId.split(":", 1)[0]
const deepFreeze = value => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
const attestationDigest = attestation => createHash("sha256").update(JSON.stringify({schema_version: attestation.schema_version, scenario_id: attestation.scenario_id, world_id: attestation.world_id, files: attestation.files})).digest("hex")
const exactAttestationFile = (files, exactFile) => {
  if (!Array.isArray(files)) return undefined
  const matches = files.filter(file => file && (file.path === exactFile || file.name === exactFile || file.path?.split("/").at(-1) === exactFile || file.path?.endsWith(`-${exactFile}`)))
  return matches.length === 1 ? matches[0] : undefined
}
const allowedKinds = Object.freeze({
  http: new Set(["http_response", "mcp_exchange", "journal_event"]), in: new Set(["protocol_event", "mcp_exchange", "journal_event", "fixture_outcome"]), out: new Set(["protocol_event", "mcp_exchange", "journal_event", "fixture_outcome"]), topic: new Set(["protocol_event", "chrome_event", "journal_event"]),
  mcp: new Set(["mcp_exchange", "journal_event", "fixture_outcome"]), action: new Set(["mcp_exchange", "journal_event", "fixture_outcome"]), version: new Set(["mcp_exchange", "journal_event"]), dashboard: new Set(["dashboard_entity", "journal_event"]),
  "world-field": new Set(["manifest_field", "journal_event", "fixture_outcome"]), capability: new Set(["manifest_field", "chrome_event", "journal_event", "fixture_outcome"]), artifact: new Set(["artifact_attestation"]), fixture: new Set(["chrome_event", "journal_event", "fixture_outcome"]),
  "ext-event": new Set(["chrome_event", "journal_event", "fixture_outcome"]), "chrome-event": new Set(["chrome_event", "journal_event"]), storage: new Set(["chrome_event", "journal_event"]), behavior: new Set(["http_response", "journal_event"]),
})

/** Each constructor consumes a real producer result and retains only safe identity fields. */
export const surfaceProof = Object.freeze({
  http(response, {method = "GET", path} = {}) { if (!response || typeof response.status !== "number" || !hasText(method) || !hasText(path)) throw new Error("HTTP proof requires response, method, and path"); return freeze({kind: "http_response", method, path, status: response.status, ok: response.ok === true}) },
  protocol(event, {direction, type = event?.type, ref = event?.ref} = {}) { if (!eventShape(event) || !hasText(direction) || !hasText(type) || event.type !== type || !hasText(String(event.producer ?? ""))) throw new Error("protocol proof requires an immutable producer event"); if (event.direction !== direction || (ref !== undefined && String(event.ref) !== String(ref))) throw new Error("protocol proof producer correlation drifted"); return deepFreeze({kind: "protocol_event", sequence: event.sequence, producer: event.producer, direction, type, ...(event.ref === undefined ? {} : {ref: String(event.ref)}), ...(event.correlation === undefined ? {} : {correlation: event.correlation})}) },
  manifest(manifest, manifestPath, field) { if (!manifest || typeof manifest !== "object" || !hasText(manifestPath) || !hasText(field) || !Object.hasOwn(manifest, field)) throw new Error("manifest proof requires a real manifest field"); const value = manifest[field]; if (value === undefined || typeof value === "function") throw new Error("manifest proof field is not serializable"); return freeze({kind: "manifest_field", manifest_path: manifestPath, field, value}) },
  artifact(attested, exactFile) { const attestation = attested?.attestation ?? attested; const file = typeof exactFile === "string" ? exactAttestationFile(attestation?.files, exactFile) : exactFile; if (!attestation || !Array.isArray(attestation.files) || !/^[a-f0-9]{64}$/i.test(attestation.attestation_sha256 ?? "") || attestationDigest(attestation) !== attestation.attestation_sha256 || !file?.path || !/^[a-f0-9]{64}$/i.test(file.sha256 ?? "") || !attestation.files.some(row => row?.path === file.path && row.sha256 === file.sha256)) throw new Error("artifact proof requires finalized attestation digest and exact file"); return deepFreeze({kind: "artifact_attestation", attestation: structuredClone(attestation), file: {path: file.path, sha256: file.sha256}}) },
  mcp(exchange, {method, action, version} = {}) { const actual = exchange?.exchange; const notification = actual?.id === undefined && actual?.rpc_method?.startsWith("notifications/"); if (!exchange || typeof exchange.status !== "number" || !actual || (!positive(actual.id) && !notification) || !hasText(actual.rpc_method) || actual.transport_method !== "POST" || actual.path !== "/mcp") throw new Error("MCP proof requires an immutable request/response exchange"); if (method !== actual.rpc_method && method !== actual.transport_method) throw new Error("MCP method correlation drifted"); if (action !== undefined && action !== actual.action) throw new Error("MCP action correlation drifted"); if (version !== undefined && version !== actual.version) throw new Error("MCP version correlation drifted"); return freeze({kind: "mcp_exchange", ...(notification ? {notification: true} : {exchange_id: actual.id}), transport_method: actual.transport_method, method: actual.rpc_method, path: actual.path, status: exchange.status, ...(actual.action === undefined ? {} : {action: actual.action}), ...(actual.version === undefined ? {} : {version: actual.version})}) },
  dashboard(event) { if (!eventShape(event) || event.producer !== "dashboard" || event.type !== "dashboard.operation.completed" || !hasText(event.data?.action) || !hasText(event.data?.entity_id)) throw new Error("dashboard proof requires the emitted dashboard operation event"); return deepFreeze({kind: "dashboard_entity", sequence: event.sequence, producer: event.producer, type: event.type, action: event.data.action, entity_id: event.data.entity_id, ...(event.data.related_id === undefined ? {} : {related_id: String(event.data.related_id)}), ...(event.data.correlation === undefined ? {} : {correlation: event.data.correlation})}) },
  chrome(event, {eventName, identity} = {}) { const actualName = event?.event_name ?? event?.name ?? event?.type; const actualIdentity = event?.identity ?? event?.id ?? event?.ref; if (!event || !positive(event.sequence) || !hasText(String(actualName)) || !hasText(String(actualIdentity)) || !hasText(String(event.producer ?? "")) || actualName !== eventName || String(actualIdentity) !== String(identity)) throw new Error("Chrome proof requires an immutable event result and identity"); return deepFreeze({kind: "chrome_event", event_name: String(actualName), identity: String(actualIdentity), sequence: event.sequence, producer: event.producer, ...(event.correlation === undefined ? {} : {correlation: event.correlation})}) },
  fixture(snapshot, {callName} = {}) { const matches = snapshot?.calls?.filter?.(([, value]) => value?.name === callName && value?.status === "completed") ?? []; const completions = snapshot?.events?.filter?.(event => event?.type === "call.completed" && event?.name === callName) ?? []; if (matches.length !== 1 || completions.length !== 1) throw new Error("fixture proof requires one completed fixture snapshot call"); const [callId, call] = matches[0], completion = completions[0]; const identity = call.args?.call_handle ?? callId; return deepFreeze({kind: "chrome_event", event_name: "fixture.call.completed", identity: String(identity), sequence: completion.sequence, fixture_call_id: String(callId), producer: "fixture", correlation: call.args?.call_handle ?? callId}) },
  fixtureOutcome(event, surfaceId) { if (!eventShape(event) || event.producer !== "fixture" || !["fixture.catalog.observed", "fixture.matrix.completed"].includes(event.type) || !hasText(surfaceId) || !Array.isArray(event.data?.surface_ids) || !event.data.surface_ids.includes(surfaceId) || !event.data?.outcomes || !hasText(event.data?.correlation?.scenario_id) || !hasText(event.data?.correlation?.operation)) throw new Error("fixture outcome proof requires a retained producer outcome event"); return deepFreeze({kind: "fixture_outcome", sequence: event.sequence, producer: event.producer, type: event.type, surface_id: surfaceId, outcomes: event.data.outcomes, correlation: event.data.correlation}) },
  journal(event, surfaceId) { if (!eventShape(event) || !hasText(surfaceId) || event.type === "boundary.observed" || !hasText(event.producer) || !event.data || event.data.surface_id !== surfaceId || !Object.hasOwn(event.data, "correlation") || event.data.correlation === null || event.data.correlation === undefined) throw new Error("journal proof requires a surface-bound emitted recorder event token"); return deepFreeze({kind: "journal_event", sequence: event.sequence, type: event.type, producer: event.producer, surface_id: surfaceId, correlation: event.data.correlation}) },
})

export const instrumentedScenarioIds = Object.freeze(Object.keys(boundaries).sort())
export function observeSurfaceProofs(boundary, proofs) { if (!boundary) return; if (!proofs || typeof proofs !== "object" || Array.isArray(proofs)) throw new Error("surface proof map is required"); for (const [surfaceId, proof] of Object.entries(proofs)) boundary.observe(surfaceId, proof) }
export async function observeRecordedSurfaces(boundary, producer, surfaceIds, type, data = {}) {
  if (!boundary) return
  if (!producer?.event || !Array.isArray(surfaceIds) || !hasText(type)) throw new Error("recorder producer, surface IDs, and event type are required")
  const events = await Promise.all(surfaceIds.map(surfaceId => producer.event(type, {surface_id: surfaceId, ...data}))); observeSurfaceProofs(boundary, Object.fromEntries(events.map((event, index) => [surfaceIds[index], surfaceProof.journal(event, surfaceIds[index])]))); return events
}
export function observedBoundarySurfaces(scenarioId, operation) { const scenario = boundaries[scenarioId]; if (!scenario) return undefined; if (!Object.hasOwn(scenario, operation)) throw new Error(`${scenarioId}: runtime boundary is unmapped: ${operation}`); return scenario[operation] }

export function validateSurfaceProof(surfaceId, proof) {
  if (!proof || typeof proof !== "object" || !hasText(proof.kind)) throw new Error(`${surfaceId}: discriminated producer proof is required`)
  if (!allowedKinds[category(surfaceId)]?.has(proof.kind)) throw new Error(`${surfaceId}: proof kind ${proof.kind} is not allowed for ${category(surfaceId)}`)
  if (proof.kind === "protocol_event" && (!positive(proof.sequence) || !hasText(proof.producer) || !hasText(proof.direction) || !hasText(proof.type) || !["in", "out"].includes(proof.direction) || (category(surfaceId) === "in" && proof.direction !== "out") || (category(surfaceId) === "out" && proof.direction !== "in") || (proof.ref !== undefined && !hasText(proof.ref)))) throw new Error(`${surfaceId}: protocol proof is incomplete`)
  if (proof.kind === "journal_event" && (!positive(proof.sequence) || !hasText(proof.type) || !hasText(proof.producer) || proof.surface_id !== surfaceId || proof.type === "boundary.observed" || proof.correlation === null || proof.correlation === undefined)) throw new Error(`${surfaceId}: journal event token is incomplete or unbound`)
  if (proof.kind === "fixture_outcome" && (!positive(proof.sequence) || proof.producer !== "fixture" || !["fixture.catalog.observed", "fixture.matrix.completed"].includes(proof.type) || proof.surface_id !== surfaceId || !proof.outcomes || !hasText(proof.correlation?.scenario_id) || !hasText(proof.correlation?.operation))) throw new Error(`${surfaceId}: fixture outcome proof is incomplete or unbound`)
  if (proof.kind === "manifest_field" && (!hasText(proof.manifest_path) || !hasText(proof.field) || !Object.hasOwn(proof, "value"))) throw new Error(`${surfaceId}: manifest proof is incomplete`)
  if (proof.kind === "artifact_attestation") { const attestation = proof.attestation; const file = attestation?.files?.find(row => row?.path === proof.file?.path); if (!attestation || !Array.isArray(attestation.files) || !/^[a-f0-9]{64}$/i.test(attestation.attestation_sha256 ?? "") || attestationDigest(attestation) !== attestation.attestation_sha256 || !file || file.sha256 !== proof.file?.sha256) throw new Error(`${surfaceId}: artifact proof is incomplete or does not match its finalized attestation`) }
  if (proof.kind === "mcp_exchange" && ((!positive(proof.exchange_id) && !(proof.notification === true && proof.method?.startsWith("notifications/"))) || proof.transport_method !== "POST" || proof.path !== "/mcp" || !hasText(proof.method) || typeof proof.status !== "number")) throw new Error(`${surfaceId}: MCP proof is incomplete`)
  if (proof.kind === "dashboard_entity" && (!positive(proof.sequence) || proof.producer !== "dashboard" || proof.type !== "dashboard.operation.completed" || !hasText(proof.action) || !hasText(proof.entity_id))) throw new Error(`${surfaceId}: dashboard proof is incomplete`)
  if (proof.kind === "chrome_event" && (!positive(proof.sequence) || !hasText(proof.producer) || !hasText(proof.event_name) || !hasText(proof.identity))) throw new Error(`${surfaceId}: Chrome proof is incomplete`)
  if (proof.kind === "http_response" && (!hasText(proof.method) || !hasText(proof.path) || typeof proof.status !== "number")) throw new Error(`${surfaceId}: HTTP proof is incomplete`)
  return freeze({...proof})
}

export function createBoundaryObservation(scenarioId, operation, recorder) {
  const surfaces = observedBoundarySurfaces(scenarioId, operation); if (surfaces === undefined) return undefined
  const allowed = new Set(surfaces); const observed = new Map(); const reserved = new Set(); const pending = new Set(); let sealed = false; let evidence
  return Object.freeze({
    observe(surfaceId, proof) { if (sealed) throw new Error(`${scenarioId}/${operation}: boundary evidence is already sealed`); if (!allowed.has(surfaceId)) throw new Error(`${scenarioId}/${operation}: undeclared boundary surface: ${surfaceId}`); if (observed.has(surfaceId)) throw new Error(`${scenarioId}/${operation}: boundary surface was observed more than once: ${surfaceId}`); observed.set(surfaceId, validateSurfaceProof(surfaceId, proof)); return surfaceId },
    complete() { if (sealed) throw new Error(`${scenarioId}/${operation}: boundary completion was emitted more than once`); sealed = true; const build = () => freeze({schema_version: 2, scenario_id: scenarioId, operation, state: "verified", surface_ids: freeze([...observed.keys()]), proofs: freeze(Object.fromEntries(observed))}); evidence = pending.size === 0 ? build() : Promise.all([...pending]).then(build); return evidence },
    consume() { if (!sealed) throw new Error(`${scenarioId}/${operation}: verified boundary completion evidence is missing`); return evidence },
  })
}

export function validateBoundaryDenominator(scenario) { const mapping = boundaries[scenario.id]; if (!mapping) throw new Error(`${scenario.id}: runtime boundary mapping is required`); const declaredOps = [...new Set(scenario.steps.map(step => step.action.op))].sort(); const mappedOps = Object.keys(mapping).sort(); if (JSON.stringify(declaredOps) !== JSON.stringify(mappedOps)) throw new Error(`${scenario.id}: runtime boundary operations drifted`); const observed = [...new Set(Object.values(mapping).flat())].sort(); const declared = [...new Set(scenario.surface_ids)].sort(); if (JSON.stringify(observed) !== JSON.stringify(declared)) throw new Error(`${scenario.id}: runtime boundary surface denominator drifted`); return true }
