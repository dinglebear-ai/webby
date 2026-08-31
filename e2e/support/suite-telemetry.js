import {mkdir, readFile, writeFile} from "node:fs/promises"
import {dirname} from "node:path"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

const ajv = new Ajv2020({allErrors: true, strict: true}); addFormats(ajv)
const validate = ajv.compile(JSON.parse(await readFile(new URL("./suite-telemetry.schema.json", import.meta.url), "utf8")))
const unique = values => [...new Set(values)].sort()

export function parseScenarioTelemetry(text) {
  if (!text.trim()) return []
  return text.trim().split("\n").map((line, index) => {
    let value
    try { value = JSON.parse(line) } catch { throw new Error(`scenario telemetry line ${index + 1} is malformed`) }
    if (!value || typeof value.scenario_id !== "string" || !["protocol", "chromium"].includes(value.adapter) || !Number.isInteger(value.duration_ms) || value.duration_ms < 0 || !["passed", "failed"].includes(value.status)) throw new Error(`scenario telemetry line ${index + 1} is invalid`)
    return value
  })
}

export function buildSuiteTelemetry({suite, status, startedAt, finishedAt, setupMs = 0, attempts = 1, retries = 0, plannedScenarioIds = [], scenarioRuns = [], infrastructureError}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(suite) || !["passed", "failed"].includes(status)) throw new Error("invalid suite telemetry identity")
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isInteger(retries) || retries < 0 || retries >= attempts) throw new Error("invalid suite attempt telemetry")
  const planned = unique(plannedScenarioIds), observed = unique(scenarioRuns.map(run => run.scenario_id))
  const evidenceComplete = JSON.stringify(planned) === JSON.stringify(observed)
  const failedRuns = scenarioRuns.filter(run => run.status === "failed")
  if (status === "passed" && failedRuns.length > 0) throw new Error(`passed suite telemetry contains failed scenario runs: ${failedRuns.map(run => `${run.adapter}:${run.scenario_id}`).join(",")}`)
  if (status === "passed" && infrastructureError) throw new Error("passed suite telemetry contains an infrastructure error")
  const value = {schema_version: 1, suite, status, started_at: new Date(startedAt).toISOString(), finished_at: new Date(finishedAt).toISOString(), setup_ms: Math.max(0, Math.round(setupMs)), elapsed_ms: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()), attempts, retries, rerun_rate: retries / attempts, flake: status === "passed" && retries > 0, planned_scenario_ids: planned, observed_scenario_ids: observed, evidence_complete: evidenceComplete, scenario_runs: scenarioRuns}
  if (infrastructureError) value.infrastructure_error = String(infrastructureError).slice(0, 512)
  if (!validate(value)) throw new Error(`suite telemetry schema validation failed: ${ajv.errorsText(validate.errors)}`)
  if (status === "passed" && !evidenceComplete) throw new Error(`suite telemetry denominator drifted: planned=${planned.join(",")} observed=${observed.join(",")}`)
  return Object.freeze(value)
}

export async function writeSuiteTelemetry(path, options) {
  const telemetry = buildSuiteTelemetry(options)
  await mkdir(dirname(path), {recursive: true, mode: 0o700})
  await writeFile(path, JSON.stringify(telemetry, null, 2) + "\n", {mode: 0o600})
  return telemetry
}

export async function readPlannedScenarioIds(path, instrumentedIds) {
  const manifest = JSON.parse(await readFile(path, "utf8"))
  const eligible = new Set(manifest.selected)
  const missing = instrumentedIds.filter(id => !eligible.has(id))
  if (missing.length) throw new Error(`suite scenario denominator is absent from the selected manifest: ${missing.join(",")}`)
  return [...instrumentedIds].sort()
}
