import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {compareParity, contractHash} from "../support/parity-report.js";
import {combinationErrors, deriveHandlerSurfaces, deterministicShards, discover, e2eRoot, mutationFixture, repoRoot, selectCombinations, validateContracts} from "../support/validate-contracts.js";
import {assertScenarioContract, assertWorldManifest} from "../support/runtime-contracts.js";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const inventoryPath = path.join(e2eRoot, "contracts/surfaces.json");
const inventory = readJson(inventoryPath);
const scenarioDirectory = path.join(e2eRoot, "contracts/scenarios");
const scenarios = fs.readdirSync(scenarioDirectory).filter((name) => name.endsWith(".json")).map((name) => readJson(path.join(scenarioDirectory, name)));

test("all committed contracts are schema-valid, mapped, and fail-closed", () => {
  const result = validateContracts();
  assert.deepEqual(result.errors, []);
  assert.equal(result.report.coverage_percent, 100);
  assert.equal(result.report.surfaces, 182);
});

test("scenario schema rejects missing IDs, drivers, outcomes, timeouts, and cleanup", () => {
  const ajv = new Ajv2020({allErrors: true, strict: true});
  addFormats(ajv);
  const validate = ajv.compile(readJson(path.join(e2eRoot, "contracts/scenario.schema.json")));
  const valid = scenarios[0];
  for (const field of ["id", "drivers", "outcomes", "cleanup"]) {
    const candidate = structuredClone(valid);
    delete candidate[field];
    assert.equal(validate(candidate), false, field);
  }
  const missingTimeout = structuredClone(valid);
  delete missingTimeout.steps[0].wait.timeout_ms;
  assert.equal(validate(missingTimeout), false);
  const unknownOperation = structuredClone(valid);
  unknownOperation.steps[0].action.op = "adapter.invents-semantics";
  assert.equal(validate(unknownOperation), false);
  const unknownPredicate = structuredClone(valid);
  unknownPredicate.cleanup[0].kind = "eventually-maybe";
  assert.equal(validate(unknownPredicate), false);
});

test("runtime contract validation rejects duplicate semantics and non-scalar security dimensions", () => {
  const valid = structuredClone(scenarios.find(scenario => scenario.security_matrices?.length));
  assert.doesNotThrow(() => assertScenarioContract(valid));
  const duplicateStep = structuredClone(valid);
  duplicateStep.steps.push(structuredClone(duplicateStep.steps[0]));
  assert.throws(() => assertScenarioContract(duplicateStep), /duplicate .* step id/);
  const duplicateOutcome = structuredClone(valid);
  duplicateOutcome.outcomes.push(structuredClone(duplicateOutcome.outcomes[0]));
  assert.throws(() => assertScenarioContract(duplicateOutcome), /duplicate .* outcome key/);
  const invalidDimension = structuredClone(valid);
  const matrix = invalidDimension.security_matrices[0];
  matrix.dimensions[Object.keys(matrix.dimensions)[0]][0] = {unsafe: true};
  assert.throws(() => assertScenarioContract(invalidDimension), /runtime schema validation/);
  const invalidTriple = structuredClone(valid);
  invalidTriple.security_matrices[0].mandated_triples[0].undeclared = "nope";
  assert.throws(() => assertScenarioContract(invalidTriple), /undeclared dimension/);
  const invalidParams = structuredClone(valid);
  invalidParams.steps[0].action.params = {adapter_invents_semantics: true};
  assert.throws(() => assertScenarioContract(invalidParams), /parameters are invalid/);
});

test("every registered extractor has a positive golden and unmapped mutation guard", async (context) => {
  for (const registry of inventory.extractor_registry) {
    await context.test(registry.category, () => {
      const expected = inventory.snapshots[registry.category];
      const sourcePath = path.join(repoRoot, registry.source);
      const stat = fs.statSync(sourcePath);
      if (stat.isDirectory()) {
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `webby-${registry.category}-`));
        try {
          for (const name of fs.readdirSync(sourcePath)) fs.copyFileSync(path.join(sourcePath, name), path.join(temporary, name));
          assert.deepEqual(discover(registry.extractor, "directory", temporary), expected);
          if (registry.extractor === "mix-tasks") fs.writeFileSync(path.join(temporary, "unmapped.task.ex"), "defmodule Mix.Tasks.Unmapped.Task do\nend\n");
          else fs.writeFileSync(path.join(temporary, "unmapped.yml"), "jobs:\n  unmapped:\n    runs-on: ubuntu-latest\n");
          assert.notDeepEqual(discover(registry.extractor, "directory", temporary), expected);
        } finally {
          fs.rmSync(temporary, {recursive: true, force: true});
        }
        return;
      }
      const source = fs.readFileSync(sourcePath, "utf8");
      assert.deepEqual(discover(registry.extractor, source, registry.source), expected);
      const mutate = mutationFixture(registry);
      assert.ok(mutate, `missing mutation fixture for ${registry.category}`);
      assert.notDeepEqual(discover(registry.extractor, mutate(source), registry.source), expected);
    });
  }
});

test("an unmapped discovered route makes inventory validation fail", () => {
  const candidate = structuredClone(inventory);
  candidate.snapshots.http_route.push("GET /unmapped");
  const result = validateContracts({inventory: candidate});
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("http_route")));
});

test("surface coverage fails when executable scenario evidence is removed or drifts", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "webby-surface-evidence-"));
  try {
    fs.cpSync(e2eRoot, path.join(temporaryRoot, "e2e"), {recursive: true, filter: (source) => !source.includes("node_modules")});
    const scenarioPath = path.join(temporaryRoot, "e2e/contracts/scenarios/shared-vertical-slice.json");
    const scenario = readJson(scenarioPath);
    scenario.surface_ids = scenario.surface_ids.filter((id) => id !== "http:get-root");
    fs.writeFileSync(scenarioPath, JSON.stringify(scenario));
    const missing = validateContracts({root: temporaryRoot, inventory: structuredClone(inventory)});
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some((error) => error.includes("http:get-root") && error.includes("does not claim executable surface evidence")));

    scenario.surface_ids.push("surface:not-in-inventory");
    fs.writeFileSync(scenarioPath, JSON.stringify(scenario));
    const extra = validateContracts({root: temporaryRoot, inventory: structuredClone(inventory)});
    assert.equal(extra.ok, false);
    assert.ok(extra.errors.some((error) => error.includes("surface:not-in-inventory") && error.includes("absent from inventory")));
  } finally {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
  }
});

test("surface coverage rejects an executable claim missing its inventory backreference", () => {
  const candidate = structuredClone(inventory);
  const surface = candidate.surfaces.find(({id}) => id === "http:get-root");
  surface.scenarios = surface.scenarios.filter((id) => id !== "e2e-shared-vertical-slice");
  const result = validateContracts({inventory: candidate});
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("http:get-root") && error.includes("executable claim from e2e-shared-vertical-slice is missing from inventory mapping")));
});

test("extractor denominator shrink and unknown contract versions fail closed", () => {
  const router = fs.readFileSync(path.join(repoRoot, "lib/webby_web/router.ex"), "utf8");
  const shrunk = router.replace('get "/health", StatusController, :show', "");
  assert.ok(discover("phoenix-routes", shrunk).length < inventory.extractor_registry.find((item) => item.category === "http_route").minimum_count);
  const candidate = structuredClone(inventory);
  candidate.contract_version = 2;
  assert.ok(validateContracts({inventory: candidate}).errors.some((error) => error.includes("unsupported inventory contract_version")));
});

test("independent handler derivations discover additions without consulting allowlists", () => {
  const channel = fs.readFileSync(path.join(repoRoot, "lib/webby_web/channels/browser_channel.ex"), "utf8");
  const broker = fs.readFileSync(path.join(repoRoot, "lib/webby/mcp/broker.ex"), "utf8");
  assert.ok(deriveHandlerSurfaces("browser_inbound", channel + '\ndefp dispatch(%{type: "novel.message"}, socket), do: {:reply, :ok, socket}\n').includes("novel.message"));
  assert.ok(deriveHandlerSurfaces("mcp_action", broker + '\ndefp dispatch("novel.action", _, _), do: {:ok, %{}}\n').includes("novel.action"));
});

test("exclusions require ownership rationale approval review and expiry", () => {
  const candidate = structuredClone(inventory);
  candidate.surfaces.push({id: "security:excluded", category: "security_surface", symbol: "unsafe", source: "fixture", scenarios: [], exclusion: {owner: "owner"}});
  const result = validateContracts({inventory: candidate});
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("missing rationale")));
  assert.ok(result.errors.some((error) => error.includes("missing approved_by")));
});

test("lifecycle matrix contains every transition and all six terminal assertions", () => {
  const matrix = readJson(path.join(e2eRoot, "contracts/lifecycle-matrix.json"));
  assert.equal(matrix.transitions.length, 15);
  assert.deepEqual(matrix.terminal_assertions.sort(), ["audit.once", "browser.aborted", "caller.terminal", "capacity.released", "late-result.rejected", "session.invalidated"]);
});

test("combination selection validates dimensions and covers every pair", () => {
  for (const scenario of scenarios) {
    const rows = selectCombinations(scenario.combinations, scenario.drivers.includes("chromium") ? "chromium" : "protocol");
    for (const triple of scenario.combinations.mandated_triples) assert.ok(rows.some((row) => Object.entries(triple).every(([key, value]) => Object.is(row[key], value))));
    const dimensions = Object.entries(scenario.combinations.dimensions);
    for (let left = 0; left < dimensions.length; left++) for (let right = left + 1; right < dimensions.length; right++) for (const a of dimensions[left][1]) for (const b of dimensions[right][1]) assert.ok(rows.some((row) => Object.is(row[dimensions[left][0]], a) && Object.is(row[dimensions[right][0]], b)), `${scenario.id}: ${dimensions[left][0]}=${a}, ${dimensions[right][0]}=${b}`);
  }
  const candidate = structuredClone(inventory);
  const lifecycle = readJson(path.join(scenarioDirectory, "lifecycle-removal.json"));
  lifecycle.combinations.mandated_triples[0].undeclared = "nope";
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "webby-contract-root-"));
  try {
    fs.cpSync(e2eRoot, path.join(temporaryRoot, "e2e"), {recursive: true, filter: (source) => !source.includes("node_modules")});
    fs.writeFileSync(path.join(temporaryRoot, "e2e/contracts/scenarios/lifecycle-removal.json"), JSON.stringify(lifecycle));
    assert.ok(validateContracts({root: temporaryRoot, inventory: candidate}).errors.some((error) => error.includes("undeclared dimension")));
  } finally { fs.rmSync(temporaryRoot, {recursive: true, force: true}); }
});

test("combination exclusions are validated, expire, and remove forbidden rows", () => {
  const scenario = structuredClone(scenarios.find(({id}) => id === "e2e-extension-controls"));
  const forbidden = {mode: "all_tabs", paused: true, restart: "chromium"};
  scenario.combinations.exclusions.push({combination: forbidden, owner: "E2E", rationale: "A substantive reviewed test exclusion", approved_by: "maintainer", reviewed_on: "2026-08-27", expires_on: "2027-08-27"});
  assert.deepEqual(combinationErrors(scenario, "2026-08-27"), []);
  const rows = selectCombinations(scenario.combinations, "chromium");
  assert.equal(rows.some((row) => Object.entries(forbidden).every(([key, value]) => Object.is(row[key], value))), false);

  const badDimension = structuredClone(scenario);
  badDimension.combinations.exclusions[0].combination = {undeclared: "value"};
  assert.ok(combinationErrors(badDimension, "2026-08-27").some((error) => error.includes("undeclared dimension")));
  const badValue = structuredClone(scenario);
  badValue.combinations.exclusions[0].combination = {mode: "superuser"};
  assert.ok(combinationErrors(badValue, "2026-08-27").some((error) => error.includes("undeclared value")));
  const expired = structuredClone(scenario);
  expired.combinations.exclusions[0].expires_on = "2026-08-26";
  assert.ok(combinationErrors(expired, "2026-08-27").some((error) => error.includes("expired")));
});

test("weighted deterministic shards have exact union and empty intersections", () => {
  const first = deterministicShards(scenarios, 3);
  assert.deepEqual(first, deterministicShards([...scenarios].reverse(), 3));
  const flattened = first.flatMap((shard) => shard.scenario_ids);
  assert.deepEqual([...flattened].sort(), scenarios.map((scenario) => scenario.id).sort());
  assert.equal(new Set(flattened).size, flattened.length);
});

test("world manifest is a versioned fail-closed IPC contract", () => {
  const ajv = new Ajv2020({allErrors: true, strict: true});
  addFormats(ajv);
  const validate = ajv.compile(readJson(path.join(e2eRoot, "support/world-manifest.schema.json")));
  const manifest = {
    manifest_version: 1,
    world_id: "world_1",
    scenario_id: "scenario_1",
    seed: 42,
    environment_marker: "isolated-e2e",
    instance_nonce: "a".repeat(32),
    pid: 123,
    process_group_id: 123,
    process_started: "Wed Aug 27 12:00:00 2026",
    process_executable: "/usr/bin/beam.smp",
    process_cwd: "/tmp/webby",
    base_url: "http://127.0.0.1:6477",
    fixture_url: "http://127.0.0.1:6478",
    database_path: "/tmp/webby.db",
    browser_profile_path: "/tmp/profile",
    artifact_directory: "/tmp/artifacts",
    telemetry_path: "/tmp/artifacts/telemetry.ndjson",
    telemetry_capability_path: "/tmp/config/telemetry-capability",
    stdout_path: "/tmp/artifacts/stdout.log",
    stderr_path: "/tmp/artifacts/stderr.log",
    started_at: "2026-08-27T12:00:00Z",
    versions: {node: "24.0.0", webby: "0.1.0"},
    metrics: {startup_kind: "cold", startup_ms: 100, migration_ms: 50, peak_rss_kb: 1000, disk_bytes: 4096},
  };
  assert.equal(validate(manifest), true);
  assert.equal(validate({...manifest, manifest_version: 2}), false);
  assert.equal(validate({...manifest, secret: "must-not-be-accepted"}), false);
  assert.doesNotThrow(() => assertWorldManifest(manifest));
  assert.throws(() => assertWorldManifest({...manifest, environment_marker: "production"}), /runtime schema validation/);
});

test("parity accepts complete shared outcomes and rejects drift omission and silent projection", () => {
  const shared = scenarios.filter((scenario) => scenario.drivers.includes("protocol") && scenario.drivers.includes("chromium"));
  const makeRun = (adapter) => ({contract_version: 1, contract_hash: contractHash(), source_revision: "a".repeat(40), toolchain_fingerprint: (adapter === "protocol" ? "b" : "c").repeat(64), world_nonce: `${adapter}-` + "w".repeat(32), seed: "parity-seed-1", adapter, results: shared.map((scenario) => { const raw = scenario.outcomes.map(({key}) => ({key: `${adapter}.${key}`, value: "pass", normalized_as: key})); return {scenario_id: scenario.id, outcomes: Object.fromEntries(scenario.outcomes.map(({key}) => [key, "pass"])), raw_observables: raw, required_raw_keys: scenario.parity[adapter].required_raw_keys};})});
  const protocol = makeRun("protocol");
  const chromium = makeRun("chromium");
  assert.equal(compareParity(protocol, chromium, scenarios).ok, true);

  const drift = structuredClone(chromium);
  drift.results[0].outcomes[Object.keys(drift.results[0].outcomes)[0]] = "fail";
  assert.ok(compareParity(protocol, drift, scenarios).errors.some((error) => error.includes("differ")));

  const omitted = structuredClone(chromium);
  omitted.results.shift();
  assert.ok(compareParity(protocol, omitted, scenarios).errors.some((error) => error.includes("omitted")));

  const projected = structuredClone(chromium);
  projected.results[0].raw_observables.pop();
  assert.ok(compareParity(protocol, projected, scenarios).errors.some((error) => error.includes("no raw observable provenance")));

  const disguised = structuredClone(chromium);
  disguised.results[0].raw_observables[0].value = "raw-drift";
  assert.ok(compareParity(protocol, disguised, scenarios).errors.some((error) => error.includes("projected into a different")));

  const unknown = structuredClone(chromium);
  unknown.results[0].raw_observables.push({key: "chromium.unknown-terminal", value: "pass", normalized_as: Object.keys(unknown.results[0].outcomes)[0]});
  assert.ok(compareParity(protocol, unknown, scenarios).errors.some((error) => error.includes("unknown raw observable")));

  const selfOmitted = structuredClone(chromium);
  selfOmitted.results[0].raw_observables.pop();
  selfOmitted.results[0].required_raw_keys.pop();
  const omissionErrors = compareParity(protocol, selfOmitted, scenarios).errors;
  assert.ok(omissionErrors.some((error) => error.includes("differs from committed contract")));
  assert.ok(omissionErrors.some((error) => error.includes("required raw observable")));

  const unbound = structuredClone(chromium);
  unbound.contract_hash = "0".repeat(64);
  assert.ok(compareParity(protocol, unbound, scenarios).errors.some((error) => error.includes("does not match committed")));
});
