function cleanupError(error, label) {
  const value = error instanceof Error ? error : new Error(String(error))
  if (!Object.hasOwn(value, "cleanup_label") && Object.isExtensible(value)) {
    Object.defineProperty(value, "cleanup_label", {value: label, enumerable: true, configurable: true})
  }
  if (value.cleanup_label === label) return value
  const labeled = new Error(`${label}: ${value.message}`, {cause: value})
  labeled.name = value.name
  labeled.code = value.code
  labeled.cleanup_label = label
  return labeled
}

function cleanupStep(step, index) {
  const [label, operation, onSuccess] = Array.isArray(step)
    ? step
    : [step?.label, step?.operation ?? step?.run, step?.onSuccess]
  if (typeof label !== "string" || !label.trim()) throw new Error(`cleanup step ${index + 1} requires a label`)
  if (typeof operation !== "function") throw new Error(`cleanup step ${label} requires an operation`)
  if (onSuccess !== undefined && typeof onSuccess !== "function") throw new Error(`cleanup step ${label} onSuccess must be a function`)
  return {label, operation, onSuccess}
}

export async function collectCleanup(steps) {
  if (!Array.isArray(steps)) throw new Error("cleanup steps must be an array")
  const plan = steps.map(cleanupStep)
  const outcomes = []
  const failures = []
  for (const step of plan) {
    try {
      const value = await step.operation()
      await step.onSuccess?.(value)
      outcomes.push({label: step.label, status: "fulfilled", value})
    } catch (error) {
      const failure = cleanupError(error, step.label)
      failures.push(failure)
      outcomes.push({label: step.label, status: "rejected", error: failure})
    }
  }
  return {outcomes, failures}
}

export function throwCleanupFailures(failures, message = "Cleanup failed", {primaryError} = {}) {
  if (!Array.isArray(failures)) throw new Error("cleanup failures must be an array")
  const ordered = []
  if (primaryError) ordered.push(primaryError)
  for (const failure of failures) if (failure && failure !== primaryError) ordered.push(failure)
  if (ordered.length === 1) throw ordered[0]
  if (ordered.length > 1) throw new AggregateError(ordered, message, {cause: primaryError ?? ordered[0]})
}

export async function runCleanupPlan(steps, {message = "Cleanup failed", primaryError} = {}) {
  const result = await collectCleanup(steps)
  throwCleanupFailures(result.failures, message, {primaryError})
  return result.outcomes
}

export function cleanupRunStatus({primaryError, failures = []} = {}) {
  if (!Array.isArray(failures)) throw new Error("cleanup failures must be an array")
  return primaryError || failures.length > 0 ? "failed" : "passed"
}
