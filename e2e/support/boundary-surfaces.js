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

export const instrumentedScenarioIds = Object.freeze(Object.keys(boundaries).sort())

export function observeVerifiedSurfaces(boundary, surfaceIds, source) {
  if (!boundary) return
  if (typeof source !== "string" || source.length === 0) throw new Error("verified surface source is required")
  for (const surfaceId of surfaceIds) boundary.observe(surfaceId, {source: `${source} [${surfaceId}]`, verified: true})
}

export function observedBoundarySurfaces(scenarioId, operation) {
  const scenario = boundaries[scenarioId]
  if (!scenario) return undefined
  if (!Object.hasOwn(scenario, operation)) throw new Error(`${scenarioId}: runtime boundary is unmapped: ${operation}`)
  return scenario[operation]
}

/**
 * A one-shot completion observation owned by the executing adapter action.
 * Merely selecting an operation never creates evidence: the action must emit
 * completion after its live boundary assertions have passed.
 */
export function createBoundaryObservation(scenarioId, operation) {
  const surfaces = observedBoundarySurfaces(scenarioId, operation)
  if (surfaces === undefined) return undefined
  const allowed = new Set(surfaces)
  const observed = new Map()
  let sealed = false
  let evidence
  return Object.freeze({
    observe(surfaceId, proof) {
      if (sealed) throw new Error(`${scenarioId}/${operation}: boundary evidence is already sealed`)
      if (!allowed.has(surfaceId)) throw new Error(`${scenarioId}/${operation}: undeclared boundary surface: ${surfaceId}`)
      if (!proof || typeof proof !== "object" || typeof proof.source !== "string" || proof.source.length === 0 || proof.verified !== true) {
        throw new Error(`${scenarioId}/${operation}/${surfaceId}: verified runtime proof is required`)
      }
      if (observed.has(surfaceId)) throw new Error(`${scenarioId}/${operation}: boundary surface was observed more than once: ${surfaceId}`)
      observed.set(surfaceId, Object.freeze({...proof}))
      return surfaceId
    },
    complete() {
      if (sealed) throw new Error(`${scenarioId}/${operation}: boundary completion was emitted more than once`)
      sealed = true
      evidence = Object.freeze({schema_version: 1, scenario_id: scenarioId, operation, state: "verified", surface_ids: Object.freeze([...observed.keys()]), proofs: Object.freeze(Object.fromEntries(observed))})
      return evidence
    },
    consume() {
      if (!sealed) throw new Error(`${scenarioId}/${operation}: verified boundary completion evidence is missing`)
      return evidence
    },
  })
}

export function validateBoundaryDenominator(scenario) {
  const mapping = boundaries[scenario.id]
  if (!mapping) throw new Error(`${scenario.id}: runtime boundary mapping is required`)
  const declaredOps = [...new Set(scenario.steps.map(step => step.action.op))].sort()
  const mappedOps = Object.keys(mapping).sort()
  if (JSON.stringify(declaredOps) !== JSON.stringify(mappedOps)) throw new Error(`${scenario.id}: runtime boundary operations drifted`)
  const observed = [...new Set(Object.values(mapping).flat())].sort()
  const declared = [...new Set(scenario.surface_ids)].sort()
  if (JSON.stringify(observed) !== JSON.stringify(declared)) throw new Error(`${scenario.id}: runtime boundary surface denominator drifted`)
  return true
}
