import {mkdir, readFile, writeFile} from "node:fs/promises"
import {dirname} from "node:path"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

const ajv = new Ajv2020({allErrors: true, strict: true}); addFormats(ajv)
const validate = ajv.compile(JSON.parse(await readFile(new URL("./suite-telemetry.schema.json", import.meta.url), "utf8")))
const unique = values => [...new Set(values)].sort()
const adapters = new Set(["protocol", "chromium"])

function validDate(value, name) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid ${name} timestamp`)
  return date
}

function assertUnique(values, name) {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string" || value.length === 0)) throw new Error(`${name} must contain nonempty strings`)
  if (new Set(values).size !== values.length) throw new Error(`${name} contains duplicate scenario IDs`)
}

function assertScenarioRun(run, index) {
  if (!run || typeof run.scenario_id !== "string" || run.scenario_id.length === 0 || !adapters.has(run.adapter) || !Number.isInteger(run.duration_ms) || run.duration_ms < 0 || !["passed", "failed"].includes(run.status)) throw new Error(`scenario telemetry line ${index + 1} is invalid`)
}

export function parseScenarioTelemetry(text) {
  if (!text.trim()) return []
  return text.trim().split("\n").map((line, index) => {
    let value
    try { value = JSON.parse(line) } catch { throw new Error(`scenario telemetry line ${index + 1} is malformed`) }
    assertScenarioRun(value, index)
    return value
  })
}

export function buildSuiteTelemetry({suite, status, startedAt, finishedAt, setupMs = 0, attempts = 1, retries = 0, plannedScenarioIds = [], scenarioRuns = [], infrastructureError, adapter}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(suite) || !["passed", "failed"].includes(status)) throw new Error("invalid suite telemetry identity")
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isInteger(retries) || retries < 0 || retries >= attempts) throw new Error("invalid suite attempt telemetry")
  const started = validDate(startedAt, "started_at"), finished = validDate(finishedAt, "finished_at")
  if (finished < started) throw new Error("suite telemetry finished_at precedes started_at")
  if (!Number.isFinite(setupMs) || setupMs < 0) throw new Error("invalid suite setup telemetry")
  assertUnique(plannedScenarioIds, "planned scenario IDs")
  if (!Array.isArray(scenarioRuns)) throw new Error("scenario runs must be an array")
  scenarioRuns.forEach(assertScenarioRun)
  assertUnique(scenarioRuns.map(run => run.scenario_id), "observed scenario IDs")
  const expectedAdapter = adapter ?? (suite.startsWith("protocol-") ? "protocol" : suite.startsWith("chromium-") ? "chromium" : undefined)
  if (expectedAdapter !== undefined && !adapters.has(expectedAdapter)) throw new Error("invalid suite adapter")
  if (expectedAdapter && scenarioRuns.some(run => run.adapter !== expectedAdapter)) throw new Error(`suite telemetry adapter drifted: expected ${expectedAdapter}`)
  const planned = unique(plannedScenarioIds), observed = unique(scenarioRuns.map(run => run.scenario_id))
  const evidenceComplete = JSON.stringify(planned) === JSON.stringify(observed)
  const failedRuns = scenarioRuns.filter(run => run.status === "failed")
  if (status === "passed" && failedRuns.length > 0) throw new Error(`passed suite telemetry contains failed scenario runs: ${failedRuns.map(run => `${run.adapter}:${run.scenario_id}`).join(",")}`)
  if (status === "passed" && infrastructureError) throw new Error("passed suite telemetry contains an infrastructure error")
  const value = {schema_version: 1, suite, status, started_at: started.toISOString(), finished_at: finished.toISOString(), setup_ms: Math.round(setupMs), elapsed_ms: finished.getTime() - started.getTime(), attempts, retries, rerun_rate: retries / attempts, flake: status === "passed" && retries > 0, planned_scenario_ids: planned, observed_scenario_ids: observed, evidence_complete: evidenceComplete, scenario_runs: scenarioRuns}
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

export async function readPlannedScenarioIds(path, expectedIds) {
  const manifest = JSON.parse(await readFile(path, "utf8"))
  assertUnique(manifest.selected, "manifest selected scenario IDs")
  const selected = unique(manifest.selected)
  const expected = unique(expectedIds)
  if (JSON.stringify(selected) !== JSON.stringify(expected)) throw new Error(`suite scenario denominator differs from selected manifest: expected=${expected.join(",")} selected=${selected.join(",")}`)
  return selected
}
