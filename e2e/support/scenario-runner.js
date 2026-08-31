import {createHash} from "node:crypto"
import {appendFile, readFile, readdir} from "node:fs/promises"
import {join} from "node:path"
import {assertPredicate} from "./assertions.js"
import {assertScenarioContract, readScenarioContract} from "./runtime-contracts.js"
import {loadSurfaceInventory, validateObservedSurfaces} from "./surface-evidence.js"
import {createBoundaryObservation, observedBoundarySurfaces, validateBoundaryDenominator} from "./boundary-surfaces.js"

const handleKinds = new Set(["world", "browser", "pairing", "credential", "page", "session", "document", "call", "audit"])
const sha256 = value => createHash("sha256").update(value).digest("hex")
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const stable = value => JSON.stringify(canonical(value))

export class ScenarioInfrastructureError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "ScenarioInfrastructureError"; this.code = code; this.details = details }
}

export class LogicalHandles {
  constructor({world, contract}) {
    this.worldId = world.worldId
    this.worldNonce = world.instanceNonce
    this.contractHash = sha256(stable(contract))
    this.values = new Map()
  }
  bind(name, kind, runtimeId) {
    if (!handleKinds.has(kind) || typeof runtimeId !== "string" || runtimeId.length === 0) throw new ScenarioInfrastructureError("invalid_handle", `invalid ${kind} handle`)
    const handle = Object.freeze({name, kind, runtimeId, worldId: this.worldId, worldNonce: this.worldNonce, contractHash: this.contractHash})
    this.values.set(name, handle)
    return handle
  }
  get(name, expectedKind) {
    const handle = this.values.get(name)
    if (!handle) throw new ScenarioInfrastructureError("missing_handle", `logical handle is not bound: ${name}`)
    if (expectedKind && handle.kind !== expectedKind) throw new ScenarioInfrastructureError("wrong_handle_kind", `${name} is ${handle.kind}, not ${expectedKind}`)
    if (handle.worldId !== this.worldId || handle.worldNonce !== this.worldNonce || handle.contractHash !== this.contractHash) throw new ScenarioInfrastructureError("stale_handle", `logical handle is stale: ${name}`)
    return handle.runtimeId
  }
  import(name, handle) { this.values.set(name, handle); return this.get(name) }
}

export async function loadScenarioMatrix({directory = new URL("../contracts/scenarios/", import.meta.url), tags = {}} = {}) {
  const files = (await readdir(directory)).filter(name => name.endsWith(".json")).sort()
  const scenarios = await Promise.all(files.map(name => readScenarioContract(join(directory.pathname, name))))
  return scenarios.filter(scenario => Object.entries(tags).every(([key, wanted]) => {
    const actual = scenario[key]
    return Array.isArray(actual) ? actual.includes(wanted) : actual === wanted
  }))
}

export class ScenarioRunner {
  constructor({scenario, driver, world, recorder, actions, observe, cleanup, defaultTimeoutMs = 30_000} = {}) {
    if (!scenario || !driver || !world || !recorder?.producers?.world) throw new ScenarioInfrastructureError("invalid_runner", "scenario, driver, live world, and recorder are required")
    assertScenarioContract(scenario, {source: "ScenarioRunner scenario"})
    if (!scenario.drivers?.includes(driver)) throw new ScenarioInfrastructureError("ineligible_driver", `${driver} is not eligible for ${scenario.id}`)
    if (typeof actions !== "object" || typeof observe !== "function" || typeof cleanup !== "function") throw new ScenarioInfrastructureError("invalid_runner", "actions, observer, and cleanup are required")
    this.scenario = scenario; this.driver = driver; this.world = world; this.recorder = recorder; this.actions = actions; this.observe = observe; this.cleanup = cleanup; this.defaultTimeoutMs = defaultTimeoutMs
    this.handles = new LogicalHandles({world, contract: scenario})
    this.observations = {}; this.observedSurfaceIds = new Set(); this.lastSequence = recorder.journal.sequence
    this.boundaryEvidenceRequired = observedBoundarySurfaces(scenario.id, scenario.steps[0].action.op) !== undefined
    if (this.boundaryEvidenceRequired) validateBoundaryDenominator(scenario)
    if (!scenario.artifacts?.includes("timeline") || !scenario.artifacts?.includes("world-manifest")) throw new ScenarioInfrastructureError("missing_artifact_requirement", "scenario must require timeline and world manifest artifacts")
  }

  async event(type, data) {
    const event = await this.recorder.producers.world.event(type, data)
    if (event.sequence <= this.lastSequence || event.sequence !== this.recorder.journal.sequence) throw new ScenarioInfrastructureError("journal_gap", `journal sequence is stale or inconsistent at ${event.sequence}`)
    this.lastSequence = event.sequence
  }

  async assertJournalContinuity() {
    await this.recorder.journal.pending
    const text = await readFile(this.recorder.journal.path, "utf8")
    const events = text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    for (let index = 0; index < events.length; index++) if (events[index].sequence !== index + 1) throw new ScenarioInfrastructureError("journal_gap", `journal event ${index + 1} is missing or stale`)
    if (events.at(-1)?.sequence !== this.recorder.journal.sequence) throw new ScenarioInfrastructureError("journal_gap", "journal tail does not match the recorder")
  }

  async bounded(operation, timeoutMs, label) {
    const controller = new AbortController()
    const pending = Promise.resolve().then(() => operation(controller.signal))
    let timer
    try {
      return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ScenarioInfrastructureError("scenario_timeout", `${label} timed out`)) }, timeoutMs ?? this.defaultTimeoutMs) })])
    } catch (error) {
      controller.abort(error)
      let drainTimer
      let drainError
      try {
        await Promise.race([
          pending.catch(() => undefined),
          new Promise((_, reject) => { drainTimer = setTimeout(() => reject(new ScenarioInfrastructureError("scenario_drain_timeout", `${label} did not drain after cancellation`, {cause: error})), timeoutMs ?? this.defaultTimeoutMs) }),
        ])
      } catch (failure) { drainError = failure }
      finally { clearTimeout(drainTimer) }
      if (drainError) throw new AggregateError([error, drainError], `${label} failed and did not drain`, {cause: error})
      throw error
    } finally { clearTimeout(timer) }
  }

  async run() {
    const startedAt = Date.now()
    await this.event("scenario.started", {scenario_id: this.scenario.id, driver: this.driver, seed: this.world.seed, contract_hash: this.handles.contractHash})
    let completed
    let primaryError
    try {
      for (const step of this.scenario.steps) {
        const action = this.actions[step.action.op]
        if (!action) throw new ScenarioInfrastructureError("missing_action", `no action registered for ${step.action.op}`)
        const boundary = createBoundaryObservation(this.scenario.id, step.action.op)
        await this.event("scenario.step.started", {step_id: step.id, operation: step.action.op})
        const result = await this.bounded(signal => action({params: step.action.params ?? {}, handles: this.handles, observations: this.observations, signal, boundary}), step.wait.timeout_ms, step.id)
        const boundaryEvidence = boundary?.consume()
        for (const surfaceId of boundaryEvidence?.surface_ids ?? []) this.observedSurfaceIds.add(surfaceId)
        if (result?.handles) for (const [name, value] of Object.entries(result.handles)) this.handles.bind(name, this.scenario.handles[name], String(value))
        Object.assign(this.observations, result?.observations)
        Object.assign(this.observations, await this.bounded(signal => this.observe(step, this, signal), step.wait.timeout_ms, `${step.id} observation`))
        if (!Object.hasOwn(this.observations, step.wait.predicate.subject)) throw new ScenarioInfrastructureError("missing_observation", `action ${step.action.op} did not produce ${step.wait.predicate.subject}`)
        assertPredicate(step.wait.predicate, this.observations, step.id)
        await this.event("scenario.step.completed", {step_id: step.id, operation: step.action.op})
      }
      for (const outcome of this.scenario.outcomes) {
        if (!Object.hasOwn(this.observations, outcome.predicate.subject)) throw new ScenarioInfrastructureError("missing_observation", `outcome subject was not observed: ${outcome.predicate.subject}`)
        assertPredicate(outcome.predicate, this.observations, outcome.key)
      }
      if (this.boundaryEvidenceRequired) {
        if (this.observedSurfaceIds.size === 0) throw new ScenarioInfrastructureError("missing_surface_evidence", `${this.driver}/${this.scenario.id}: runtime surface evidence is required`)
        const surfaceEvidence = validateObservedSurfaces({scenario: this.scenario, driver: this.driver, observed: [...this.observedSurfaceIds], inventory: await loadSurfaceInventory()})
        await this.recorder.producers.world.diagnostic("surface-evidence.json", surfaceEvidence, Object.keys(surfaceEvidence))
      }
      await this.event("scenario.completed", {scenario_id: this.scenario.id, outcome_keys: this.scenario.outcomes.map(item => item.key)})
      await this.assertJournalContinuity()
      completed = {observations: this.observations, handles: this.handles, normalized: Object.fromEntries(this.scenario.outcomes.map(item => [item.key, this.observations[item.predicate.subject]]))}
    } catch (error) {
      primaryError = error
      try { await this.recorder.producers.world.failure({summary: error.message, code: error.code ?? "scenario_failed", scenario_id: this.scenario.id}) }
      catch (journalError) { primaryError = new AggregateError([error, journalError], "Scenario failed and failure evidence could not be journaled", {cause: error}) }
    }
    let cleanupError
    try {
      const cleanup = await this.bounded(signal => this.cleanup(this, signal), this.defaultTimeoutMs, "scenario cleanup")
      for (const predicate of this.scenario.cleanup) assertPredicate(predicate, cleanup, predicate.subject)
    } catch (error) { cleanupError = error }
    const telemetryDenominator = new Set((process.env.WEBBY_E2E_SCENARIO_DENOMINATOR ?? "").split(",").filter(Boolean))
    if (this.boundaryEvidenceRequired && process.env.WEBBY_E2E_SCENARIO_TELEMETRY && telemetryDenominator.has(`${this.driver}:${this.scenario.id}`)) {
      await appendFile(process.env.WEBBY_E2E_SCENARIO_TELEMETRY, JSON.stringify({scenario_id: this.scenario.id, adapter: this.driver, duration_ms: Date.now() - startedAt, status: primaryError || cleanupError ? "failed" : "passed"}) + "\n", {mode: 0o600})
    }
    if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], "Scenario and cleanup both failed", {cause: primaryError})
    if (primaryError) throw primaryError
    if (cleanupError) throw cleanupError
    return completed
  }
}
