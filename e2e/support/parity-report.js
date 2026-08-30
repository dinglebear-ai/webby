import fs from "node:fs";
import path from "node:path";
import {assertScenarioContract} from "./runtime-contracts.js";
import {fileURLToPath} from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {createHash} from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const scenarioDirectory = path.resolve(here, "../contracts/scenarios");
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
};

export function compareParity(protocolRun, chromiumRun, scenarios = loadScenarios()) {
  const errors = [];
  const ajv = new Ajv2020({allErrors: true, strict: true});
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(here, "parity-report.schema.json"), "utf8")));
  if (!validate(protocolRun)) errors.push(`protocol parity contract invalid: ${ajv.errorsText(validate.errors)}`);
  if (!validate(chromiumRun)) errors.push(`chromium parity contract invalid: ${ajv.errorsText(validate.errors)}`);
  const expectedHash = contractHash();
  if (protocolRun.contract_hash !== expectedHash) errors.push("protocol run contract_hash does not match committed contracts");
  if (chromiumRun.contract_hash !== expectedHash) errors.push("chromium run contract_hash does not match committed contracts");
  if (protocolRun.source_revision !== chromiumRun.source_revision) errors.push("parity runs use different source revisions");
  if (protocolRun.seed !== chromiumRun.seed) errors.push("parity runs use different seeds");
  if (protocolRun.contract_version !== 1 || chromiumRun.contract_version !== 1) errors.push("parity input contract_version must be 1");
  if (protocolRun.adapter !== "protocol") errors.push("first parity input must be the protocol adapter");
  if (chromiumRun.adapter !== "chromium") errors.push("second parity input must be the chromium adapter");
  const protocol = indexResults(protocolRun, errors);
  const chromium = indexResults(chromiumRun, errors);
  const compared = [];

  for (const scenario of scenarios.filter((item) => item.drivers.includes("protocol") && item.drivers.includes("chromium"))) {
    const left = protocol.get(scenario.id);
    const right = chromium.get(scenario.id);
    if (!left) errors.push(`protocol omitted shared scenario ${scenario.id}`);
    if (!right) errors.push(`chromium omitted shared scenario ${scenario.id}`);
    if (!left || !right) continue;
    validateResult(left, scenario, "protocol", errors);
    validateResult(right, scenario, "chromium", errors);
    if (JSON.stringify(stable(left.outcomes)) !== JSON.stringify(stable(right.outcomes))) errors.push(`${scenario.id}: normalized outcomes differ`);
    compared.push(scenario.id);
  }
  return {ok: errors.length === 0, errors, compared};
}

function indexResults(run, errors) {
  const result = new Map();
  for (const entry of run.results ?? []) {
    if (result.has(entry.scenario_id)) errors.push(`${run.adapter}: duplicate result ${entry.scenario_id}`);
    result.set(entry.scenario_id, entry);
  }
  return result;
}

function validateResult(result, scenario, adapter, errors) {
  const expected = new Set(scenario.outcomes.map((item) => item.key));
  const actual = new Set(Object.keys(result.outcomes ?? {}));
  for (const key of expected) if (!actual.has(key)) errors.push(`${adapter}/${scenario.id}: missing normalized outcome ${key}`);
  for (const key of actual) if (!expected.has(key)) errors.push(`${adapter}/${scenario.id}: unknown normalized outcome ${key}`);
  const projected = new Set();
  const rawKeys = new Set();
  for (const observable of result.raw_observables ?? []) {
    if (!observable.key || !observable.normalized_as) errors.push(`${adapter}/${scenario.id}: raw observable lacks key or normalized_as`);
    if (!actual.has(observable.normalized_as)) errors.push(`${adapter}/${scenario.id}: raw observable ${observable.key} projects to absent outcome ${observable.normalized_as}`);
    if (actual.has(observable.normalized_as) && JSON.stringify(stable(observable.value)) !== JSON.stringify(stable(result.outcomes[observable.normalized_as]))) errors.push(`${adapter}/${scenario.id}: raw observable ${observable.key} was projected into a different normalized value`);
    projected.add(observable.normalized_as);
    if (rawKeys.has(observable.key)) errors.push(`${adapter}/${scenario.id}: duplicate raw observable ${observable.key}`);
    rawKeys.add(observable.key);
  }
  for (const key of actual) if (!projected.has(key)) errors.push(`${adapter}/${scenario.id}: normalized outcome ${key} has no raw observable provenance`);
  if (projected.size !== (result.raw_observables ?? []).length) errors.push(`${adapter}/${scenario.id}: every raw observable must map one-to-one to a normalized outcome`);
  const committed = scenario.parity?.[adapter];
  if (!committed) errors.push(`${adapter}/${scenario.id}: scenario has no committed parity contract`);
  const expectedRaw = committed?.required_raw_keys ?? [];
  if (JSON.stringify([...result.required_raw_keys ?? []].sort()) !== JSON.stringify([...expectedRaw].sort())) errors.push(`${adapter}/${scenario.id}: emitted raw denominator differs from committed contract`);
  const excluded = new Set((committed?.raw_exclusions ?? []).map((item) => item.key));
  for (const key of expectedRaw) if (!rawKeys.has(key) && !excluded.has(key)) errors.push(`${adapter}/${scenario.id}: required raw observable ${key} is missing`);
  for (const key of rawKeys) if (!expectedRaw.includes(key)) errors.push(`${adapter}/${scenario.id}: unknown raw observable ${key}`);
  if (expectedRaw.length < expected.size) errors.push(`${adapter}/${scenario.id}: committed parity-critical raw denominator is smaller than normalized outcomes`);
}

export function contractHash() {
  const files = ["../contracts/scenario.schema.json", "../contracts/lifecycle-matrix.json", "../contracts/surfaces.json", "world-manifest.schema.json", "parity-report.schema.json", ...fs.readdirSync(scenarioDirectory).filter((name) => name.endsWith(".json")).sort().map((name) => `../contracts/scenarios/${name}`)];
  const hash = createHash("sha256");
  for (const relative of files) hash.update(relative).update("\0").update(fs.readFileSync(path.resolve(here, relative))).update("\0");
  return hash.digest("hex");
}

function loadScenarios() {
  return fs.readdirSync(scenarioDirectory).filter((name) => name.endsWith(".json")).sort().map((name) => assertScenarioContract(JSON.parse(fs.readFileSync(path.join(scenarioDirectory, name), "utf8")), {source: name}));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error("usage: npm run parity -- protocol-results.json chromium-results.json");
    process.exitCode = 2;
  } else {
    const result = compareParity(JSON.parse(fs.readFileSync(process.argv[2], "utf8")), JSON.parse(fs.readFileSync(process.argv[3], "utf8")));
    console.log(`Shared adapter parity: ${result.compared.length} scenarios compared`);
    for (const error of result.errors) console.error(`ERROR: ${error}`);
    if (!result.ok) process.exitCode = 1;
  }
}
