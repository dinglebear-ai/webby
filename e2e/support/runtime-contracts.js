import fs from "node:fs"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

const readJson = url => JSON.parse(fs.readFileSync(url, "utf8"))
const ajv = new Ajv2020({allErrors: true, strict: true})
addFormats(ajv)

const scenarioValidator = ajv.compile(readJson(new URL("../contracts/scenario.schema.json", import.meta.url)))
const worldValidator = ajv.compile(readJson(new URL("./world-manifest.schema.json", import.meta.url)))

// Operation payloads are part of the executable contract, not an adapter-owned
// escape hatch. Keep the registry explicit so adding a parameter requires a
// reviewed contract change before a scenario can rely on it.
const operationParameters = Object.freeze({
  "health.request": {optional: ["id"], types: {id: "string"}},
  "browser.pair": {}, "discovery.publish": {}, "dashboard.register": {},
  "credential.create": {}, "mcp.negotiate": {}, "mcp.invoke": {}, "audit.observe": {},
  "transport.reject-matrix": {}, "websocket.reject-matrix": {}, "limits.exercise": {},
  "lifecycle.trigger": {}, "lifecycle.observe-terminal": {}, "lifecycle.recover": {},
  "capacity.fill": {}, "capacity.overflow": {}, "race.execute": {}, "capacity.reuse": {},
  "world.start": {}, "world.restart": {}, "retention.drain": {}, "privacy.erase": {},
  "extension.configure": {}, "extension.pair-scan": {}, "extension.permissions": {}, "extension.restart": {},
  "fixture.discover": {}, "fixture.invoke-matrix": {}, "fixture.mutate": {}, "commands.validate": {},
})

function assertUnique(values, label) {
  const seen = new Set()
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

function validate(validator, value, label) {
  if (!validator(value)) throw new Error(`${label} failed runtime schema validation: ${ajv.errorsText(validator.errors, {separator: "; "})}`)
}

export function assertScenarioContract(scenario, {source = "scenario"} = {}) {
  validate(scenarioValidator, scenario, source)
  assertUnique(scenario.steps.map(step => step.id), `${source} step id`)
  assertUnique(scenario.outcomes.map(outcome => outcome.key), `${source} outcome key`)
  for (const step of scenario.steps) assertOperationParameters(step.action, `${source}/${step.id}`)
  for (const matrix of scenario.security_matrices ?? []) {
    for (const [name, values] of Object.entries(matrix.dimensions)) assertUnique(values.map(value => JSON.stringify(value)), `${source}/${matrix.id} dimension value ${name}`)
    for (const [index, triple] of matrix.mandated_triples.entries()) {
      for (const [name, value] of Object.entries(triple)) {
        if (!Object.hasOwn(matrix.dimensions, name)) throw new Error(`${source}/${matrix.id} mandated triple ${index} uses undeclared dimension ${name}`)
        if (!matrix.dimensions[name].some(candidate => Object.is(candidate, value))) throw new Error(`${source}/${matrix.id} mandated triple ${index} uses undeclared value ${name}=${JSON.stringify(value)}`)
      }
    }
  }
  return scenario
}

function assertOperationParameters(action, source) {
  const contract = operationParameters[action.op]
  if (!contract) throw new Error(`${source}: operation parameter contract is missing for ${action.op}`)
  const params = action.params ?? {}
  const allowed = new Set([...(contract.required ?? []), ...(contract.optional ?? [])])
  const unknown = Object.keys(params).filter(key => !allowed.has(key))
  const missing = (contract.required ?? []).filter(key => !Object.hasOwn(params, key))
  if (unknown.length || missing.length) throw new Error(`${source}: ${action.op} parameters are invalid; unknown=${unknown.join(",")} missing=${missing.join(",")}`)
  for (const [key, type] of Object.entries(contract.types ?? {})) if (Object.hasOwn(params, key) && (typeof params[key] !== type || (type === "string" && params[key].length === 0))) throw new Error(`${source}: ${action.op} parameter ${key} must be a nonempty ${type}`)
}

export function assertWorldManifest(manifest, {source = "world manifest"} = {}) {
  validate(worldValidator, manifest, source)
  if (manifest.environment_marker !== "isolated-e2e") throw new Error(`${source} has an unsafe environment marker`)
  return manifest
}

export async function readScenarioContract(url) {
  return assertScenarioContract(JSON.parse(await fs.promises.readFile(url, "utf8")), {source: String(url)})
}

export async function readWorldManifest(path) {
  return assertWorldManifest(JSON.parse(await fs.promises.readFile(path, "utf8")), {source: path})
}
