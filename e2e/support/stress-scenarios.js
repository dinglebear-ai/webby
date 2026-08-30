export const stressScenarioFiles = Object.freeze({
  "e2e-shared-vertical-slice": Object.freeze(["test/scenarios/protocol-happy-path.test.js"]),
  "e2e-lifecycle-removal": Object.freeze(["test/scenarios/protocol-lifecycle-matrix-live.test.js", "test/scenarios/protocol-removal-boundaries.test.js"]),
  "e2e-capacity-concurrency": Object.freeze(["test/scenarios/protocol-capacity.test.js", "test/scenarios/protocol-concurrency.test.js", "test/scenarios/protocol-db-contention.test.js"]),
  "e2e-persistence-retention": Object.freeze(["test/scenarios/protocol-persistence-matrix.test.js", "test/scenarios/protocol-retention-erasure.test.js"]),
  "e2e-transport-security": Object.freeze(["test/scenarios/protocol-security.test.js", "test/scenarios/protocol-cancellation-races.test.js"]),
  "e2e-extension-controls": Object.freeze(["test/chromium/reconnect-restart.test.js", "test/chromium/permissions-lifecycle.test.js"]),
})

export const stressScenarios = Object.freeze(Object.keys(stressScenarioFiles))

export function validateStressScenarios(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("at least one stress scenario is required")
  if (values.some(value => typeof value !== "string" || !value || !stressScenarioFiles[value])) {
    throw new Error("stress scenarios must be non-empty registered scenario IDs")
  }
  if (new Set(values).size !== values.length) throw new Error("stress scenarios must be unique")
  return [...values]
}
