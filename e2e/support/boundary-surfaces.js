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
const allowedKinds = Object.freeze({
  http: new Set(["http_response", "mcp_exchange", "journal_event"]), in: new Set(["protocol_event", "mcp_exchange", "journal_event"]), out: new Set(["protocol_event", "mcp_exchange", "journal_event"]), topic: new Set(["protocol_event", "chrome_event", "journal_event"]),
  mcp: new Set(["mcp_exchange", "journal_event"]), action: new Set(["mcp_exchange", "journal_event"]), version: new Set(["mcp_exchange", "journal_event"]), dashboard: new Set(["dashboard_entity", "journal_event"]),
  "world-field": new Set(["manifest_field", "journal_event"]), capability: new Set(["manifest_field", "chrome_event", "journal_event"]), artifact: new Set(["artifact_attestation", "journal_event"]), fixture: new Set(["journal_event", "chrome_event"]),
  "ext-event": new Set(["chrome_event", "journal_event"]), "chrome-event": new Set(["chrome_event", "journal_event"]), storage: new Set(["chrome_event", "journal_event"]), behavior: new Set(["http_response", "journal_event"]),
})

/** Each constructor consumes a real producer result and retains only safe identity fields. */
export const surfaceProof = Object.freeze({
  http(response, {method = "GET", path} = {}) { if (!response || typeof response.status !== "number" || !hasText(method) || !hasText(path)) throw new Error("HTTP proof requires response, method, and path"); return freeze({kind: "http_response", method, path, status: response.status, ok: response.ok === true}) },
  protocol(event, {direction, type = event?.type, ref = event?.ref} = {}) { if (!eventShape(event) || !hasText(direction) || !hasText(type)) throw new Error("protocol proof requires a sequenced producer event"); return freeze({kind: "protocol_event", sequence: event.sequence, direction, type, ...(ref === undefined ? {} : {ref: String(ref)})}) },
  manifest(manifest, manifestPath, field) { if (!manifest || typeof manifest !== "object" || !hasText(manifestPath) || !hasText(field) || !Object.hasOwn(manifest, field)) throw new Error("manifest proof requires a real manifest field"); const value = manifest[field]; if (value === undefined || typeof value === "function") throw new Error("manifest proof field is not serializable"); return freeze({kind: "manifest_field", manifest_path: manifestPath, field, value}) },
  artifact(attestation, exactFile) { const digest = attestation?.attestation?.attestation_sha256 ?? attestation?.attestation_sha256; const files = attestation?.attestation?.files ?? attestation?.files; const file = typeof exactFile === "string" ? files?.find(row => row.path?.endsWith(exactFile) || row.name === exactFile) : exactFile; if (!/^[a-f0-9]{64}$/i.test(digest ?? "") || !file?.path || !/^[a-f0-9]{64}$/i.test(file.sha256 ?? "")) throw new Error("artifact proof requires finalized attestation digest and exact file"); return freeze({kind: "artifact_attestation", attestation_sha256: digest, file: freeze({path: file.path, sha256: file.sha256})}) },
  mcp(exchange, {method, action, version} = {}) { if (!exchange || typeof exchange.status !== "number" || !hasText(method)) throw new Error("MCP proof requires an actual request/response exchange"); if (action !== undefined && !hasText(action)) throw new Error("MCP action proof requires an action"); if (version !== undefined && !hasText(version)) throw new Error("MCP version proof requires a version"); return freeze({kind: "mcp_exchange", method, status: exchange.status, ...(action === undefined ? {} : {action}), ...(version === undefined ? {} : {version})}) },
  dashboard(action, entityId, {relatedId} = {}) { if (!hasText(action) || !hasText(String(entityId))) throw new Error("dashboard proof requires action and entity identity"); return freeze({kind: "dashboard_entity", action, entity_id: String(entityId), ...(relatedId === undefined ? {} : {related_id: String(relatedId)})}) },
  chrome(event, {eventName, identity} = {}) { if (!event || !hasText(eventName) || !hasText(String(identity))) throw new Error("Chrome proof requires event identity"); if (event.sequence !== undefined && !positive(event.sequence)) throw new Error("Chrome event sequence is invalid"); return freeze({kind: "chrome_event", event_name: eventName, identity: String(identity), ...(event.sequence === undefined ? {} : {sequence: event.sequence})}) },
  journal(event) { if (!eventShape(event)) throw new Error("journal proof requires the emitted recorder event token"); return freeze({kind: "journal_event", sequence: event.sequence, type: event.type, producer: event.producer}) },
})

export const instrumentedScenarioIds = Object.freeze(Object.keys(boundaries).sort())
export function observeSurfaceProofs(boundary, proofs) { if (!boundary) return; if (!proofs || typeof proofs !== "object" || Array.isArray(proofs)) throw new Error("surface proof map is required"); for (const [surfaceId, proof] of Object.entries(proofs)) boundary.observe(surfaceId, proof) }
export async function observeRecordedSurfaces(boundary, producerOrSurfaceIds, surfaceIdsOrType, typeOrData, data = {}) {
  if (!boundary) return
  if (Array.isArray(producerOrSurfaceIds)) return boundary.record(producerOrSurfaceIds)
  const producer = producerOrSurfaceIds; const surfaceIds = surfaceIdsOrType; const type = typeOrData
  if (!producer?.event || !Array.isArray(surfaceIds) || !hasText(type)) throw new Error("recorder producer, surface IDs, and event type are required")
  const event = await producer.event(type, {surface_ids: surfaceIds, ...data}); observeSurfaceProofs(boundary, Object.fromEntries(surfaceIds.map(surfaceId => [surfaceId, surfaceProof.journal(event)]))); return event
}
export function observedBoundarySurfaces(scenarioId, operation) { const scenario = boundaries[scenarioId]; if (!scenario) return undefined; if (!Object.hasOwn(scenario, operation)) throw new Error(`${scenarioId}: runtime boundary is unmapped: ${operation}`); return scenario[operation] }

function validateProof(surfaceId, proof) {
  if (!proof || typeof proof !== "object" || !hasText(proof.kind)) throw new Error(`${surfaceId}: discriminated producer proof is required`)
  if (!allowedKinds[category(surfaceId)]?.has(proof.kind)) throw new Error(`${surfaceId}: proof kind ${proof.kind} is not allowed for ${category(surfaceId)}`)
  if (proof.kind === "protocol_event" && (!positive(proof.sequence) || !hasText(proof.direction) || !hasText(proof.type))) throw new Error(`${surfaceId}: protocol proof is incomplete`)
  if (proof.kind === "journal_event" && (!positive(proof.sequence) || !hasText(proof.type))) throw new Error(`${surfaceId}: journal event token is incomplete`)
  if (proof.kind === "manifest_field" && (!hasText(proof.manifest_path) || !hasText(proof.field) || !Object.hasOwn(proof, "value"))) throw new Error(`${surfaceId}: manifest proof is incomplete`)
  if (proof.kind === "artifact_attestation" && (!/^[a-f0-9]{64}$/i.test(proof.attestation_sha256 ?? "") || !hasText(proof.file?.path) || !/^[a-f0-9]{64}$/i.test(proof.file?.sha256 ?? ""))) throw new Error(`${surfaceId}: artifact proof is incomplete`)
  if (proof.kind === "mcp_exchange" && (!hasText(proof.method) || typeof proof.status !== "number")) throw new Error(`${surfaceId}: MCP proof is incomplete`)
  if (proof.kind === "dashboard_entity" && (!hasText(proof.action) || !hasText(proof.entity_id))) throw new Error(`${surfaceId}: dashboard proof is incomplete`)
  if (proof.kind === "chrome_event" && (!hasText(proof.event_name) || !hasText(proof.identity))) throw new Error(`${surfaceId}: Chrome proof is incomplete`)
  if (proof.kind === "http_response" && (!hasText(proof.method) || !hasText(proof.path) || typeof proof.status !== "number")) throw new Error(`${surfaceId}: HTTP proof is incomplete`)
  return freeze({...proof})
}

export function createBoundaryObservation(scenarioId, operation, recorder) {
  const surfaces = observedBoundarySurfaces(scenarioId, operation); if (surfaces === undefined) return undefined
  const allowed = new Set(surfaces); const observed = new Map(); const reserved = new Set(); const pending = new Set(); let sealed = false; let evidence
  return Object.freeze({
    observe(surfaceId, proof) { if (sealed) throw new Error(`${scenarioId}/${operation}: boundary evidence is already sealed`); if (!allowed.has(surfaceId)) throw new Error(`${scenarioId}/${operation}: undeclared boundary surface: ${surfaceId}`); if (observed.has(surfaceId)) throw new Error(`${scenarioId}/${operation}: boundary surface was observed more than once: ${surfaceId}`); observed.set(surfaceId, validateProof(surfaceId, proof)); return surfaceId },
    record(surfaceIds) { if (!recorder?.producers?.world?.event) throw new Error(`${scenarioId}/${operation}: recorder-backed boundary proof is required`); if (sealed) throw new Error(`${scenarioId}/${operation}: boundary evidence is already sealed`); if (!Array.isArray(surfaceIds)) throw new Error("surface IDs are required"); for (const surfaceId of surfaceIds) { if (!allowed.has(surfaceId)) throw new Error(`${scenarioId}/${operation}: undeclared boundary surface: ${surfaceId}`); if (observed.has(surfaceId) || reserved.has(surfaceId)) throw new Error(`${scenarioId}/${operation}: boundary surface was observed more than once: ${surfaceId}`); reserved.add(surfaceId) } const task = Promise.resolve(recorder.producers.world.event("boundary.observed", {scenario_id: scenarioId, operation, surface_ids: surfaceIds})).then(event => { for (const surfaceId of surfaceIds) observed.set(surfaceId, validateProof(surfaceId, surfaceProof.journal(event))); return event }); pending.add(task); task.finally(() => pending.delete(task)); return task },
    complete() { if (sealed) throw new Error(`${scenarioId}/${operation}: boundary completion was emitted more than once`); sealed = true; const build = () => freeze({schema_version: 2, scenario_id: scenarioId, operation, state: "verified", surface_ids: freeze([...observed.keys()]), proofs: freeze(Object.fromEntries(observed))}); evidence = pending.size === 0 ? build() : Promise.all([...pending]).then(build); return evidence },
    consume() { if (!sealed) throw new Error(`${scenarioId}/${operation}: verified boundary completion evidence is missing`); return evidence },
  })
}

export function validateBoundaryDenominator(scenario) { const mapping = boundaries[scenario.id]; if (!mapping) throw new Error(`${scenario.id}: runtime boundary mapping is required`); const declaredOps = [...new Set(scenario.steps.map(step => step.action.op))].sort(); const mappedOps = Object.keys(mapping).sort(); if (JSON.stringify(declaredOps) !== JSON.stringify(mappedOps)) throw new Error(`${scenario.id}: runtime boundary operations drifted`); const observed = [...new Set(Object.values(mapping).flat())].sort(); const declared = [...new Set(scenario.surface_ids)].sort(); if (JSON.stringify(observed) !== JSON.stringify(declared)) throw new Error(`${scenario.id}: runtime boundary surface denominator drifted`); return true }
