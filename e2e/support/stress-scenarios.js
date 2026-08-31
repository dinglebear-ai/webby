export const stressScenarioFiles = Object.freeze({
  "e2e-shared-vertical-slice": Object.freeze(["test/scenarios/protocol-happy-path.test.js"]),
  "e2e-lifecycle-removal": Object.freeze(["test/scenarios/protocol-lifecycle-matrix-live.test.js", "test/scenarios/protocol-removal-boundaries.test.js", "test/world.test.js"]),
  "e2e-capacity-concurrency": Object.freeze(["test/scenarios/protocol-capacity.test.js", "test/scenarios/protocol-concurrency.test.js", "test/scenarios/protocol-db-contention.test.js"]),
  "e2e-persistence-retention": Object.freeze(["test/scenarios/protocol-persistence-matrix.test.js", "test/scenarios/protocol-retention-erasure.test.js", "test/scenarios/protocol-restart.test.js"]),
  "e2e-transport-security": Object.freeze(["test/scenarios/protocol-security.test.js", "test/scenarios/protocol-cancellation-races.test.js"]),
  "e2e-extension-controls": Object.freeze(["test/chromium/reconnect-restart.test.js", "test/chromium/permissions-lifecycle.test.js"]),
})

export const stressScenarios = Object.freeze(Object.keys(stressScenarioFiles))
export const requiredStressMeasurements = Object.freeze({
  "e2e-capacity-concurrency": Object.freeze({pending_calls: 100, scan_tabs: Object.freeze([10, 100, 1000])}),
})

export function validateStressScenarios(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("at least one stress scenario is required")
  if (values.some(value => typeof value !== "string" || !value || !stressScenarioFiles[value])) {
    throw new Error("stress scenarios must be non-empty registered scenario IDs")
  }
  if (new Set(values).size !== values.length) throw new Error("stress scenarios must be unique")
  return [...values]
}


export function measuredCeilings(scenarioEvidence) {
  const measurements = scenarioEvidence.filter(value => value.status === "passed").flatMap(value => value.measurements ?? [])
  return {
    pending_calls: Math.max(0, ...measurements.map(value => value.pending_calls ?? 0)),
    scan_tabs: [...new Set(measurements.flatMap(value => value.scan_tabs ?? []))].sort((left, right) => left - right),
  }
}

export function validateRequiredMeasurements(scenarioId, measurements) {
  const required = requiredStressMeasurements[scenarioId]
  if (!required) return true
  if (!Array.isArray(measurements)) throw new Error(`${scenarioId} required measurements are missing`)
  const pending = measurements.filter(value => value && Object.hasOwn(value, "pending_calls")).map(value => value.pending_calls)
  const scans = measurements.filter(value => value && Object.hasOwn(value, "scan_tabs")).map(value => value.scan_tabs)
  if (pending.length !== 1 || !Number.isInteger(pending[0]) || pending[0] !== required.pending_calls) throw new Error(`${scenarioId} must observe pending_calls=${required.pending_calls} exactly once`)
  if (scans.length !== 1 || !Array.isArray(scans[0]) || scans[0].some(value => !Number.isInteger(value) || value < 1) || JSON.stringify(scans[0]) !== JSON.stringify(required.scan_tabs)) throw new Error(`${scenarioId} must observe scan_tabs=${required.scan_tabs.join(",")} exactly once and in order`)
  return true
}
