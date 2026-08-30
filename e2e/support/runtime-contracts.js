import fs from "node:fs"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

const readJson = url => JSON.parse(fs.readFileSync(url, "utf8"))
const ajv = new Ajv2020({allErrors: true, strict: true})
addFormats(ajv)

const scenarioValidator = ajv.compile(readJson(new URL("../contracts/scenario.schema.json", import.meta.url)))
const worldValidator = ajv.compile(readJson(new URL("./world-manifest.schema.json", import.meta.url)))

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
