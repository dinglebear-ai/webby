export const fixtureToolRows = Object.freeze({
  echo: "tool.echo", typed: "tool.typed", immediate: "tool.immediate",
  delayed: "tool.delayed.release", side_effect: "tool.side_effect", reject: "tool.reject",
  oversized: "tool.oversized", deep: "tool.deep", "catalog.add": "catalog.add",
  "catalog.remove": "catalog.remove", dynamic: "catalog.dynamic",
})
export const cancellationRows = Object.freeze(["cancel.before", "cancel.during", "cancel.after", "timeout.late"])
export const documentRows = Object.freeze(["document.navigation", "document.reload", "document.tab_close"])
export const multiTabRows = Object.freeze(["document.multi_tab"])
export const capacityRows = Object.freeze(["capacity.global_limit", "capacity.release"])
const contractOutcomeRows = Object.freeze({json: "tool.echo", text: "tool.immediate", throw: "tool.reject", delay: "tool.delayed.release", cancel: "cancel.during", oversized: "tool.oversized", deep: "tool.deep", "side-effect": "tool.side_effect"})

export const reviewedCrashExclusions = Object.freeze([
  Object.freeze({id: "crash.renderer", source: "extension/src/service_worker.js", symbol: "classifyToolError", owner: "webby-ihb.19", reviewed_on: "2026-08-27", rationale: "Page.crash destroys the shared renderer and cannot safely preserve subsequent exact-document assertions."}),
  Object.freeze({id: "crash.worker", source: "extension/src/service_worker.js", symbol: "classifyToolError", owner: "webby-ihb.19", reviewed_on: "2026-08-27", rationale: "Stopping a Manifest V3 worker is a restart, not a deterministic worker crash; forced termination invalidates the shared extension lane."}),
])

export function expectedLiveRows(catalogNames) {
  const catalog = new Set(catalogNames)
  const mapped = Object.keys(fixtureToolRows)
  const missing = mapped.filter(name => name !== "dynamic" && !catalog.has(name))
  const unknown = catalogNames.filter(name => !Object.hasOwn(fixtureToolRows, name))
  if (missing.length || unknown.length) throw new Error(`fixture inventory drift: missing=${missing.join(",")} unknown=${unknown.join(",")}`)
  return new Set([...Object.values(fixtureToolRows), ...cancellationRows, ...documentRows, ...multiTabRows, ...capacityRows, "tool.missing", "catalog.stale"])
}

export function assertExecutedCoverage(catalogNames, executed, contract) {
  const outcomes = contract?.combinations?.dimensions?.outcome
  if (!Array.isArray(outcomes)) throw new Error("fixture outcome contract has no outcome dimension")
  const unmappedOutcomes = outcomes.filter(outcome => !Object.hasOwn(contractOutcomeRows, outcome))
  if (unmappedOutcomes.length) throw new Error(`fixture contract outcome drift: ${unmappedOutcomes.join(",")}`)
  const unexecutedOutcomes = outcomes.filter(outcome => !executed.has(contractOutcomeRows[outcome]))
  if (unexecutedOutcomes.length) throw new Error(`fixture contract outcomes were not live-executed: ${unexecutedOutcomes.join(",")}`)
  const expected = expectedLiveRows(catalogNames)
  const missing = [...expected].filter(id => !executed.has(id))
  const unexpected = [...executed].filter(id => !expected.has(id))
  if (missing.length || unexpected.length) throw new Error(`live row drift: missing=${missing.join(",")} unexpected=${unexpected.join(",")}`)
  const eligible = expected.size + reviewedCrashExclusions.length
  return {eligible, mapped: expected.size, excluded: reviewedCrashExclusions.length, percent: Math.round(expected.size / eligible * 10000) / 100}
}
