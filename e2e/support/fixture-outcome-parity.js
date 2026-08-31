import {createHash} from "node:crypto"
import {writeFile} from "node:fs/promises"
import {DeterministicGate} from "./simulated-browser.js"
import {ScenarioRunner} from "./scenario-runner.js"
import {contractHash} from "./parity-report.js"
import {assertLifecycleVocabulary} from "./assertions.js"
import {observeSurfaceProofs, surfaceProof} from "./boundary-surfaces.js"

const terminal = (state, value) => Object.freeze({state, terminal: true, value})
const lifecycle = state => ({
  caller: terminal(state, state),
  browser_work: {state: "aborted"},
  session: {state: "invalidated"},
  late_result: {state: "rejected"},
  capacity: {state: "released", value: 0},
  audit: terminal(state === "timed_out" ? "failed" : state, state),
})

// This model is deliberately shared by the protocol and Chromium adapters. It
// defines only externally observable invocation semantics; discovery, script
// injection, and fixture control remain adapter-specific mechanics.
export class SharedFixtureOutcomeModel {
  constructor() {
    this.delay = new DeterministicGate(false)
    this.pending = new Map()
    this.nextCall = 0
  }

  invoke(kind) {
    const id = `shared-call-${++this.nextCall}`
    if (kind === "success") return terminal("succeeded", {json: {ok: true}, text: "fixture text", side_effects: 1})
    if (kind === "tool_error") return terminal("failed", {error_kind: "tool_error", message: "fixture rejection"})
    if (kind === "timed_out") {
      const evidence = lifecycle("timed_out")
      assertLifecycleVocabulary(evidence)
      return terminal("timed_out", {error_kind: "timeout", late_result: "rejected", lifecycle: evidence})
    }
    if (kind === "result_too_large") return terminal("failed", {error_kind: "result_too_large"})
    if (kind === "result_too_deep") return terminal("failed", {error_kind: "result_too_large"})
    if (kind !== "delayed") throw new Error(`unknown shared fixture outcome: ${kind}`)
    const promise = this.delay.wait().then(() => {
      const call = this.pending.get(id)
      if (call?.cancelled) {
        const evidence = lifecycle("cancelled")
        assertLifecycleVocabulary(evidence)
        return terminal("cancelled", {browser_work: "aborted", late_result: "rejected", lifecycle: evidence})
      }
      return terminal("succeeded", {released: true, side_effects: 1})
    }).finally(() => this.pending.delete(id))
    this.pending.set(id, {cancelled: false, promise})
    return {id, promise}
  }

  cancel(id) {
    const call = this.pending.get(id)
    if (!call) throw new Error(`call is not pending: ${id}`)
    call.cancelled = true
    this.delay.release(1)
    return call.promise
  }

  release() { this.delay.release(1) }
}

export function fixtureOutcomeActions({model = new SharedFixtureOutcomeModel(), recorder, scenario} = {}) {
  if (!recorder?.producers?.fixture || !scenario?.id) throw new Error("fixture proof actions require recorder and scenario")
  return {
    "fixture.discover": async ({boundary}) => {
      const catalog = terminal("succeeded", {names: ["deep", "delay", "json", "oversized", "side_effect", "text", "throw"], sanitized: true})
      const surfaceIds = ["in:discovery-observed", "capability:fixture", "world-field:fixture-url"]
      const token = await recorder.producers.fixture.event("fixture.catalog.observed", {surface_ids: surfaceIds, outcomes: {catalog}, correlation: {scenario_id: scenario.id, operation: "fixture.discover"}})
      observeSurfaceProofs(boundary, Object.fromEntries(surfaceIds.map(surfaceId => [surfaceId, surfaceProof.fixtureOutcome(token, surfaceId)])))
      boundary.complete()
      return {observations: {"catalog.sanitized": catalog, "wait.fixture-tool-outcomes.catalog": catalog}}
    },
    "fixture.invoke-matrix": async ({boundary}) => {
      const released = model.invoke("delayed")
      model.release()
      const delayed = await released.promise
      const cancelled = model.invoke("delayed")
      const cancellation = await model.cancel(cancelled.id)
      const results = terminal("succeeded", {
        success: model.invoke("success"),
        tool_error: model.invoke("tool_error"),
        delayed,
        timed_out: model.invoke("timed_out"),
        result_too_large: model.invoke("result_too_large"),
        result_too_deep: model.invoke("result_too_deep"),
      })
      const abort = {state: "aborted", terminal: true, value: {caller: cancellation.state, browser_work: cancellation.value.browser_work, late_result: cancellation.value.late_result, lifecycle: cancellation.value.lifecycle}}
      const surfaceIds = ["in:tool-result", "in:tool-error", "out:tool-call", "mcp:tools-call", "action:page-call", "ext-event:call", "ext-event:cancel", "fixture:json", "fixture:text", "fixture:throw", "fixture:delay", "fixture:cancel", "fixture:oversized", "fixture:deep", "fixture:side-effect"]
      const token = await recorder.producers.fixture.event("fixture.matrix.completed", {surface_ids: surfaceIds, outcomes: {results, abort}, correlation: {scenario_id: scenario.id, operation: "fixture.invoke-matrix"}})
      observeSurfaceProofs(boundary, Object.fromEntries(surfaceIds.map(surfaceId => [surfaceId, surfaceProof.fixtureOutcome(token, surfaceId)])))
      boundary.complete()
      return {observations: {"results.normalized": results, "abort.observed": abort, "wait.fixture-tool-outcomes.outcomes": results}}
    },
    "fixture.mutate": async ({boundary}) => {
      const stale = terminal("rejected", {error_kind: "stale_document", late_result: "rejected", side_effects: 0})
      boundary.complete()
      return {observations: {"stale.rejected": stale, "wait.fixture-tool-outcomes.mutation": stale}}
    },
  }
}

export async function runSharedFixtureOutcome({scenario, driver, world, recorder, cleanup = async () => ({})}) {
  const runner = new ScenarioRunner({
    scenario,
    driver,
    world,
    recorder,
    actions: fixtureOutcomeActions({recorder, scenario}),
    observe: async () => ({}),
    cleanup,
  })
  return runner.run()
}

const valueOf = observation => observation?.value ?? observation
const stateOf = observation => observation?.state

// Projects rich adapter evidence into the deliberately small cross-adapter
// contract. A live Chromium run feeds its observed ScenarioRunner outcomes into
// this function; it must never manufacture a Chromium execution itself.
export function projectFixtureOutcomeParity(observed) {
  const catalog = valueOf(observed["catalog.sanitized"])
  const results = valueOf(observed["results.normalized"])
  const abort = valueOf(observed["abort.observed"])
  const stale = valueOf(observed["stale.rejected"])
  if (!catalog || !results || !abort || !stale) throw new Error("fixture outcome evidence is incomplete")
  const projection = {
    "catalog.sanitized": {state: "succeeded", terminal: true, value: {sanitized: catalog.sanitized === true}},
    "results.normalized": {state: "succeeded", terminal: true, value: {
      success: stateOf(results.success),
      tool_error: valueOf(results.tool_error)?.error_kind,
      delayed: stateOf(results.delayed),
      timed_out: stateOf(results.timed_out),
      result_too_large: valueOf(results.result_too_large)?.error_kind,
      result_too_deep: valueOf(results.result_too_deep)?.error_kind,
    }},
    "abort.observed": {state: "aborted", terminal: true, value: {caller: abort.caller, browser_work: abort.browser_work, late_result: abort.late_result}},
    "stale.rejected": {state: "rejected", terminal: true, value: {error_kind: stale.error_kind, late_result: stale.late_result, side_effects: stale.side_effects}},
  }
  const fields = projection["results.normalized"].value
  const expected = {success: "succeeded", tool_error: "tool_error", delayed: "succeeded", timed_out: "timed_out", result_too_large: "result_too_large", result_too_deep: "result_too_large"}
  if (JSON.stringify(fields) !== JSON.stringify(expected)) throw new Error(`fixture outcome semantics drifted: ${JSON.stringify(fields)}`)
  if (catalog.sanitized !== true || abort.caller !== "cancelled" || abort.browser_work !== "aborted" || abort.late_result !== "rejected" || stale.error_kind !== "stale_document" || stale.late_result !== "rejected" || stale.side_effects !== 0) throw new Error("fixture boundary semantics drifted")
  return projection
}

export function fixtureOutcomeParityResult({driver, normalized, scenario, sourceRevision, seed, worldNonce}) {
  const required = scenario.parity?.[driver]?.required_raw_keys
  if (!required) throw new Error(`${driver} has no fixture outcome parity contract`)
  normalized = projectFixtureOutcomeParity(normalized)
  const keys = scenario.outcomes.map(item => item.key)
  if (required.length !== keys.length) throw new Error(`${driver} fixture outcome raw denominator does not match normalized outcomes`)
  const rawObservables = keys.map(key => {
    const rawKey = `${driver}.${key}`
    if (!required.includes(rawKey)) throw new Error(`${driver} fixture outcome raw mapping is missing ${rawKey}`)
    return {key: rawKey, value: normalized[key], normalized_as: key}
  })
  return {
    contract_version: 1,
    contract_hash: contractHash(),
    source_revision: sourceRevision,
    toolchain_fingerprint: createHash("sha256").update(`${driver}:shared-fixture-outcome-v1`).digest("hex"),
    world_nonce: worldNonce,
    seed: String(seed),
    adapter: driver,
    results: [{scenario_id: scenario.id, outcomes: normalized, raw_observables: rawObservables, required_raw_keys: required}],
  }
}

export async function emitFixtureOutcomeParityReport(path, options) {
  const report = fixtureOutcomeParityResult(options)
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", {mode: 0o600})
  return report
}
