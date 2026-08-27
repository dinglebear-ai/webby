import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const here = path.dirname(fileURLToPath(import.meta.url));
export const e2eRoot = path.resolve(here, "..");
export const repoRoot = path.resolve(e2eRoot, "..");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sorted = (values) => [...new Set(values)].sort();

function matches(source, pattern, map = (match) => match[1]) {
  return sorted([...source.matchAll(pattern)].map(map));
}

const extractors = {
  "phoenix-routes": (source) => {
    let scope = "";
    const routes = [];
    for (const rawLine of source.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("#")) continue;
      const scopeMatch = line.match(/^scope\s+"([^"]+)"/);
      if (scopeMatch) scope = scopeMatch[1] === "/" ? "" : scopeMatch[1];
      const route = line.match(/^(get|post|put|patch|delete|options|head|live)\s+"([^"]+)"/);
      if (route) routes.push(`${route[1] === "live" ? "GET" : route[1].toUpperCase()} ${scope}${route[2]}`.replace(/\/$/, "/"));
      const dashboard = line.match(/^live_dashboard\s+"([^"]+)"/);
      if (dashboard) routes.push(`GET ${scope}${dashboard[1]}`);
      const forward = line.match(/^forward\s+"([^"]+)"/);
      if (forward) routes.push(`ANY ${scope}${forward[1]}`);
    }
    return sorted(routes);
  },
  "socket-topics": (source) => matches(source, /^\s*channel\s+"([^"]+)"/gm),
  "browser-allowlist": (source) => {
    const body = source.match(/@types\s+~w\(([^)]+)\)/)?.[1];
    if (!body) throw new Error("browser @types declaration missing or unknown");
    return sorted(body.trim().split(/\s+/));
  },
  "browser-envelopes": (source) => {
    const values = matches(source, /BrowserProtocol\.envelope\(\s*"([a-z.]+)"/gs);
    const dynamic = [...source.matchAll(/BrowserProtocol\.envelope\(\s*"([^"\n]*#\{[^}]+\}[^"\n]*)"/gs)];
    for (const match of dynamic) {
      if (match[1] !== "pairing.#{payload.status}") throw new Error(`unknown dynamic browser envelope: ${match[1]}`);
      values.push("pairing.approved", "pairing.rejected");
    }
    return sorted(values);
  },
  "mcp-methods": (source) => matches(source, /"method"\s*=>\s*"([a-z/]+)"/g),
  "mcp-actions": (source) => {
    const body = source.match(/@actions\s+~w\(([^)]+)\)/)?.[1];
    if (!body) throw new Error("broker @actions declaration missing or unknown");
    return sorted(body.trim().split(/\s+/));
  },
  "mcp-versions": (source) => matches(source, /"(20\d\d-\d\d-\d\d)"/g),
  "liveview-events": (source) => matches(source, /handle_event\("([a-z-]+)"/g),
  "popup-controls": (source) => matches(source, /<(?:input|select|button)\b[^>]*\bid="([^"]+)"/g),
  "extension-commands": (source) => matches(source, /message\.type\s*===\s*"([^"]+)"/g),
  "extension-events": (source) => matches(source, /envelope\?\.type\s*===\s*"([^"]+)"/g),
  "chrome-listeners": (source) => matches(source, /chrome\.([A-Za-z]+)\.([A-Za-z]+)\.addListener\s*\(/g, (m) => `${m[1]}.${m[2]}`),
  "extension-storage": (source) => {
    const keys = new Set();
    for (const match of source.matchAll(/chrome\.storage\.local\.(?:get|set)\(([^;]+?)\)/gs)) {
      for (const key of match[1].matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)) keys.add(key[1]);
      for (const key of match[1].matchAll(/\b(baseUrl|browserId|ignoredOrigins|pairingId|privateKey|publicKey|scanningMode|scanningPaused)\b/g)) keys.add(key[1]);
    }
    return sorted(keys);
  },
  "mix-aliases": (source) => {
    const block = source.match(/defp aliases do([\s\S]*?)\n\s{2}end/)?.[1];
    if (!block) throw new Error("Mix aliases block missing or unknown");
    return matches(block, /^\s*(?:"([^"]+)"|([a-z][a-z0-9_]*)):\s*\[/gm, (m) => (m[1] || m[2]).replaceAll("_", "."));
  },
  "mix-tasks": (_source, sourcePath) => {
    const directory = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(repoRoot, sourcePath);
    if (!fs.statSync(directory).isDirectory()) throw new Error("Mix task source is not a directory");
    return sorted(fs.readdirSync(directory).filter((name) => name.endsWith(".ex")).map((name) => name.replace(/\.ex$/, "").replaceAll(".", ".")));
  },
  "npm-scripts": (source) => sorted(Object.keys(JSON.parse(source).scripts ?? {})),
  "json-schema-properties": (source) => sorted(Object.keys(JSON.parse(source).properties ?? {})),
  "ci-jobs": (_source, sourcePath) => {
    const directory = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(repoRoot, sourcePath);
    const values = [];
    for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".yml")).sort()) {
      const workflow = fs.readFileSync(path.join(directory, name), "utf8");
      const stem = name.replace(/\.yml$/, "");
      const jobs = workflow.match(/(?:^|\n)jobs:\n([\s\S]*)/)?.[1] ?? "";
      for (const match of jobs.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)) values.push(`${stem}:${match[1]}`);
    }
    return sorted(values);
  }
};

export function discover(extractor, source, sourcePath = "fixture") {
  const implementation = extractors[extractor];
  if (!implementation) throw new Error(`unregistered extractor: ${extractor}`);
  const result = implementation(source, sourcePath);
  if (!Array.isArray(result) || result.length === 0) throw new Error(`${extractor} returned zero surfaces`);
  return result;
}

export function selectCombinations(combinations, driver) {
  const entries = Object.entries(combinations.dimensions ?? {});
  const cartesian = entries.reduce((rows, [key, values]) => rows.flatMap((row) => values.map((value) => ({...row, [key]: value}))), [{}])
    .filter((row) => !(combinations.exclusions ?? []).some((exclusion) => includesRow(row, exclusion.combination)));
  if (cartesian.length === 0) throw new Error("combination exclusions removed every row");
  if (driver === "protocol" && combinations.cartesian_driver === "protocol") return cartesian;
  const uncovered = new Set();
  for (let left = 0; left < entries.length; left++) for (let right = left + 1; right < entries.length; right++) for (const a of entries[left][1]) for (const b of entries[right][1]) uncovered.add(`${entries[left][0]}=${JSON.stringify(a)}|${entries[right][0]}=${JSON.stringify(b)}`);
  const selected = [];
  while (uncovered.size > 0) {
    let best;
    let score = -1;
    for (const row of cartesian) {
      const keys = pairKeys(row);
      const candidate = keys.filter((key) => uncovered.has(key)).length;
      if (candidate > score) { best = row; score = candidate; }
    }
    if (!best || score <= 0) throw new Error("pairwise selector could not cover declared dimensions");
    selected.push(best);
    for (const key of pairKeys(best)) uncovered.delete(key);
  }
  for (const triple of combinations.mandated_triples ?? []) {
    if ((combinations.exclusions ?? []).some((exclusion) => includesRow(triple, exclusion.combination))) throw new Error(`mandated triple is forbidden by an exclusion: ${JSON.stringify(triple)}`);
    if (!selected.some((row) => includesRow(row, triple))) selected.push(triple);
  }
  return selected;
}

function pairKeys(row) {
  const entries = Object.entries(row);
  const keys = [];
  for (let left = 0; left < entries.length; left++) for (let right = left + 1; right < entries.length; right++) keys.push(`${entries[left][0]}=${JSON.stringify(entries[left][1])}|${entries[right][0]}=${JSON.stringify(entries[right][1])}`);
  return keys;
}

const includesRow = (row, subset) => Object.entries(subset).every(([key, value]) => Object.hasOwn(row, key) && Object.is(row[key], value));

export function deterministicShards(scenarios, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error("shardCount must be positive");
  const shards = Array.from({length: shardCount}, () => ({weight: 0, scenario_ids: []}));
  for (const scenario of [...scenarios].sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id))) {
    const target = shards.reduce((best, shard, index) => shard.weight < shards[best].weight ? index : best, 0);
    shards[target].scenario_ids.push(scenario.id);
    shards[target].weight += scenario.weight;
  }
  return shards.map((shard) => ({...shard, scenario_ids: shard.scenario_ids.sort()}));
}

function independent(category, symbols) {
  if (category === "http_route") {
    const script = `defmodule E2ERoutes do
      def walk({:scope, _, args}, prefix) do
        path = Enum.find(args, &is_binary/1) || ""
        body = args |> List.last() |> Keyword.fetch!(:do)
        walk(body, if(path == "/", do: prefix, else: prefix <> path))
      end
      def walk({name, _, [route | _]}, prefix) when name in [:get, :post, :put, :patch, :delete, :options, :head, :live] and is_binary(route), do: [if(name == :live, do: "GET", else: name |> Atom.to_string() |> String.upcase()) <> " " <> prefix <> route]
      def walk({:live_dashboard, _, [route | _]}, prefix) when is_binary(route), do: ["GET " <> prefix <> route]
      def walk({:forward, _, [route | _]}, prefix) when is_binary(route), do: ["ANY " <> prefix <> route]
      def walk({_, _, args}, prefix) when is_list(args), do: Enum.flat_map(args, &walk(&1, prefix))
      def walk({_key, value}, prefix), do: walk(value, prefix)
      def walk(list, prefix) when is_list(list), do: Enum.flat_map(list, &walk(&1, prefix))
      def walk(_, _), do: []
    end
    {:ok, ast} = Code.string_to_quoted(File.read!("lib/webby_web/router.ex"))
    ast |> E2ERoutes.walk("") |> Enum.uniq() |> Enum.sort() |> Enum.each(&IO.puts("E2E_ROUTE=" <> &1))`;
    const run = spawnSync("elixir", ["-e", script], {cwd: repoRoot, encoding: "utf8", timeout: 30000});
    if (run.status !== 0) throw new Error(`Elixir AST route extraction failed: ${run.stderr.trim()}`);
    const astRoutes = sorted([...run.stdout.matchAll(/^E2E_ROUTE=(.+)$/gm)].map((match) => match[1]));
    if (astRoutes.length === 0) throw new Error("Elixir AST route extraction produced zero routes");
    return astRoutes;
  }
  if (category === "browser_inbound") {
    const channel = fs.readFileSync(path.join(repoRoot, "lib/webby_web/channels/browser_channel.ex"), "utf8");
    return deriveHandlerSurfaces(category, channel);
  }
  if (category === "mcp_action") {
    const broker = fs.readFileSync(path.join(repoRoot, "lib/webby/mcp/broker.ex"), "utf8");
    return deriveHandlerSurfaces(category, broker);
  }
  throw new Error(`unregistered independent derivation: ${category}`);
}

export function deriveHandlerSurfaces(category, source) {
  if (category === "browser_inbound") {
    const found = new Set(matches(source, /%\{type:\s*"([a-z.]+)"/g));
    for (const guard of source.matchAll(/when type in \[([^\]]+)\]/g)) for (const item of guard[1].matchAll(/"([a-z.]+)"/g)) found.add(item[1]);
    return sorted(found);
  }
  if (category === "mcp_action") {
    const found = new Set(matches(source, /defp dispatch\(\s*"([a-z.]+)"/g));
    for (const guard of source.matchAll(/when action in (?:\[([^\]]+)\]|~w\(([^)]+)\))/g)) {
      for (const item of (guard[1] ?? "").matchAll(/"([a-z.]+)"/g)) found.add(item[1]);
      for (const item of (guard[2] ?? "").trim().split(/\s+/)) if (item) found.add(item);
    }
    return sorted(found);
  }
  throw new Error(`unregistered handler derivation: ${category}`);
}

export function validateContracts({root = repoRoot, inventory = readJson(path.join(e2eRoot, "contracts/surfaces.json"))} = {}) {
  const errors = [];
  if (inventory.contract_version !== 1) errors.push(`unsupported inventory contract_version: ${inventory.contract_version}`);
  const scenarioDirectory = path.join(root, "e2e/contracts/scenarios");
  const scenarioFiles = fs.readdirSync(scenarioDirectory).filter((name) => name.endsWith(".json")).sort();
  const schema = readJson(path.join(root, "e2e/contracts/scenario.schema.json"));
  const ajv = new Ajv2020({allErrors: true, strict: true});
  addFormats(ajv);
  const validateScenario = ajv.compile(schema);
  const scenarios = new Map();

  for (const name of scenarioFiles) {
    const scenario = readJson(path.join(scenarioDirectory, name));
    if (!validateScenario(scenario)) errors.push(`${name}: ${ajv.errorsText(validateScenario.errors)}`);
    if (Boolean(scenario.owner) !== Boolean(scenario.deferred_to)) errors.push(`${scenario.id}: owner and deferred_to must be declared together`);
    if (scenario.deferred_to && scenario.owner !== scenario.deferred_to) errors.push(`${scenario.id}: deferred scenario owner must match deferred_to`);
    if (scenarios.has(scenario.id)) errors.push(`duplicate scenario id: ${scenario.id}`);
    scenarios.set(scenario.id, scenario);
    for (const step of scenario.steps ?? []) {
      if (/\b(?:sleep|setTimeout)\b/i.test(JSON.stringify(step.action))) errors.push(`${scenario.id}/${step.id}: fixed sleeps are forbidden`);
      if (step.wait?.timeout_ms > inventory.timeout_hierarchy_ms?.step) errors.push(`${scenario.id}/${step.id}: wait exceeds the global step timeout`);
    }
    validateCombinations(scenario, errors);
    validateParityContract(scenario, errors);
  }

  const covered = new Map();
  for (const surface of inventory.surfaces ?? []) {
    if (!surface.id || !surface.category || !surface.symbol || !surface.source) errors.push(`invalid surface row: ${JSON.stringify(surface)}`);
    if (covered.has(surface.id)) errors.push(`duplicate surface id: ${surface.id}`);
    covered.set(surface.id, surface);
    const mapped = surface.scenarios ?? [];
    const exclusion = surface.exclusion;
    if (mapped.length === 0 && !exclusion) errors.push(`${surface.id}: uncovered without exclusion`);
    for (const id of mapped) if (!scenarios.has(id)) errors.push(`${surface.id}: unknown scenario ${id}`);
    if (exclusion) validateExclusion(exclusion, `${surface.id} exclusion`, errors, surface.category === "security_surface");
  }
  for (const exclusion of inventory.exclusions ?? []) validateExclusion(exclusion, "inventory exclusion", errors, true);

  for (const registry of inventory.extractor_registry ?? []) {
    const sourcePath = path.join(root, registry.source);
    let source;
    try {
      source = fs.statSync(sourcePath).isDirectory() ? "directory" : fs.readFileSync(sourcePath, "utf8");
      const actual = discover(registry.extractor, source, registry.source);
      const expected = sorted(inventory.snapshots[registry.category] ?? []);
      if (actual.length < registry.minimum_count) errors.push(`${registry.category}: denominator shrank from minimum ${registry.minimum_count} to ${actual.length}`);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${registry.category}: source/snapshot disagreement\n  source: ${actual.join(", ")}\n  snapshot: ${expected.join(", ")}`);
      if (registry.independent_derivation) {
        const derived = sorted(independent(registry.category, expected));
        if (JSON.stringify(derived) !== JSON.stringify(expected)) errors.push(`${registry.category}: independent derivation disagreement: ${derived.join(", ")}`);
      }
      const rows = sorted((inventory.surfaces ?? []).filter((item) => item.category === registry.category).map((item) => item.symbol));
      if (JSON.stringify(rows) !== JSON.stringify(expected)) errors.push(`${registry.category}: inventory rows disagree with snapshot`);
    } catch (error) {
      errors.push(`${registry.category}: extractor failed closed: ${error.message}`);
    }
  }

  validateTimeouts(inventory.timeout_hierarchy_ms, errors);
  validateLifecycle(root, scenarios, errors);
  const total = inventory.surfaces?.length ?? 0;
  const excluded = (inventory.surfaces ?? []).filter((surface) => surface.exclusion).length;
  return {ok: errors.length === 0, errors, report: {contract_version: inventory.contract_version, scenarios: scenarios.size, surfaces: total, mapped: total - excluded, excluded, coverage_percent: total === 0 ? 0 : 100}};
}

function validateParityContract(scenario, errors, today = new Date().toISOString().slice(0, 10)) {
  const adapters = Object.keys(scenario.parity ?? {}).sort();
  if (JSON.stringify(adapters) !== JSON.stringify([...scenario.drivers].sort())) errors.push(`${scenario.id}: committed parity adapters must exactly match eligible drivers`);
  for (const adapter of adapters) {
    const contract = scenario.parity[adapter];
    const exclusions = new Set((contract.raw_exclusions ?? []).map((item) => item.key));
    if (contract.required_raw_keys.length < scenario.outcomes.length) errors.push(`${scenario.id}/${adapter}: raw denominator is smaller than normalized outcomes`);
    for (const exclusion of contract.raw_exclusions ?? []) {
      if (!contract.required_raw_keys.includes(exclusion.key)) errors.push(`${scenario.id}/${adapter}: raw exclusion ${exclusion.key} is not in the committed denominator`);
      if (exclusion.reviewed_on > today) errors.push(`${scenario.id}/${adapter}: raw exclusion review date is in the future`);
      if (exclusion.expires_on < today) errors.push(`${scenario.id}/${adapter}: raw exclusion ${exclusion.key} expired on ${exclusion.expires_on}`);
    }
    if (exclusions.size !== (contract.raw_exclusions ?? []).length) errors.push(`${scenario.id}/${adapter}: duplicate raw exclusion keys`);
  }
}

export function combinationErrors(scenario, today = new Date().toISOString().slice(0, 10)) {
  const errors = [];
  const combinations = scenario.combinations ?? {};
  const dimensions = combinations.dimensions ?? {};
  for (const [index, triple] of (combinations.mandated_triples ?? []).entries()) {
    for (const [key, value] of Object.entries(triple)) {
      if (!Object.hasOwn(dimensions, key)) errors.push(`${scenario.id}: mandated triple ${index} uses undeclared dimension ${key}`);
      else if (!dimensions[key].some((candidate) => Object.is(candidate, value))) errors.push(`${scenario.id}: mandated triple ${index} uses undeclared value ${key}=${JSON.stringify(value)}`);
    }
  }
  for (const [index, exclusion] of (combinations.exclusions ?? []).entries()) {
    for (const field of ["owner", "rationale", "approved_by", "reviewed_on", "expires_on"]) if (!exclusion[field]) errors.push(`${scenario.id}: combination exclusion ${index} missing ${field}`);
    for (const [key, value] of Object.entries(exclusion.combination ?? {})) {
      if (!Object.hasOwn(dimensions, key)) errors.push(`${scenario.id}: combination exclusion ${index} uses undeclared dimension ${key}`);
      else if (!dimensions[key].some((candidate) => Object.is(candidate, value))) errors.push(`${scenario.id}: combination exclusion ${index} uses undeclared value ${key}=${JSON.stringify(value)}`);
    }
    if (exclusion.reviewed_on > today) errors.push(`${scenario.id}: combination exclusion ${index} review date is in the future`);
    if (exclusion.expires_on < today) errors.push(`${scenario.id}: combination exclusion ${index} expired on ${exclusion.expires_on}`);
  }
  try {
    const selected = selectCombinations(combinations, scenario.drivers.includes("chromium") ? "chromium" : "protocol");
    if (combinations.pairwise) {
      const required = new Set(selectCombinations({...combinations, cartesian_driver: "protocol"}, "protocol").flatMap(pairKeys));
      const actual = new Set(selected.flatMap(pairKeys));
      for (const pair of required) if (!actual.has(pair)) errors.push(`${scenario.id}: pairwise selection omitted ${pair}`);
    }
  } catch (error) {
    errors.push(`${scenario.id}: invalid combination contract: ${error.message}`);
  }
  return errors;
}

function validateCombinations(scenario, errors) {
  errors.push(...combinationErrors(scenario));
}

function validateExclusion(exclusion, label, errors, security) {
  const fields = ["source_symbol", "owner", "rationale", "approved_by", "reviewed_on", "expires_on"];
  for (const field of fields) if (!exclusion?.[field]) errors.push(`${label}: missing ${field}`);
  if (security && !exclusion?.approved_by) errors.push(`${label}: security exclusion lacks approval`);
}

function validateTimeouts(timeouts, errors) {
  const order = ["action", "step", "scenario", "shard", "job", "workflow"];
  for (let index = 1; index < order.length; index++) {
    if (!(timeouts?.[order[index - 1]] < timeouts?.[order[index]])) errors.push(`timeout ordering must satisfy ${order[index - 1]} < ${order[index]}`);
  }
  if ((timeouts?.diagnostic_grace ?? 0) + (timeouts?.cleanup_grace ?? 0) >= (timeouts?.workflow ?? 0) - (timeouts?.job ?? 0)) errors.push("diagnostic and cleanup grace must fit inside workflow outer budget");
}

function validateLifecycle(root, scenarios, errors) {
  const matrix = readJson(path.join(root, "e2e/contracts/lifecycle-matrix.json"));
  if (matrix.contract_version !== 1) errors.push(`unsupported lifecycle contract_version: ${matrix.contract_version}`);
  const required = ["close", "replacement", "catalog-change", "ignore", "pause", "permission-revoke", "browser-revoke", "credential-revoke", "disconnect", "reconnect", "resync-omission", "server-restart", "service-worker-restart", "chromium-restart", "retention"];
  const assertions = ["caller.terminal", "browser.aborted", "session.invalidated", "late-result.rejected", "capacity.released", "audit.once"];
  if (JSON.stringify(sorted(matrix.transitions.map((item) => item.id))) !== JSON.stringify(sorted(required))) errors.push("lifecycle matrix transition set is incomplete");
  if (JSON.stringify(sorted(matrix.terminal_assertions)) !== JSON.stringify(sorted(assertions))) errors.push("lifecycle matrix terminal assertions are incomplete");
  if (!scenarios.has(matrix.scenario)) errors.push(`lifecycle matrix references unknown scenario ${matrix.scenario}`);
  const shared = scenarios.get("e2e-shared-vertical-slice");
  if (JSON.stringify(sorted(shared?.drivers ?? [])) !== JSON.stringify(["chromium", "protocol"])) errors.push("shared vertical slice must be eligible for both adapters");
}

export function mutationFixture(registry) {
  const mutations = {
    "phoenix-routes": '\nput "/__unmapped", StatusController, :show\n',
    "socket-topics": '\nchannel "browser:new", BrowserChannel\n',
    "browser-allowlist": (source) => source.replace(/@types\s+~w\(([^)]+)/, "$& new.message"),
    "browser-envelopes": '\nBrowserProtocol.envelope("new.event", %{})\n',
    "mcp-methods": '\n%{"method" => "new/method"}\n',
    "mcp-actions": (source) => source.replace(/@actions\s+~w\(([^)]+)/, "$& new.action"),
    "mcp-versions": '\n"2099-01-01"\n',
    "liveview-events": '\ndef handle_event("new-event", _, socket), do: {:noreply, socket}\n',
    "popup-controls": '\n<button id="new-control"></button>\n',
    "extension-commands": '\nif (message.type === "new-command") {}\n',
    "extension-events": '\nif (envelope?.type === "new.event") {}\n',
    "chrome-listeners": '\nchrome.runtime.onSuspend.addListener(() => {})\n',
    "extension-storage": '\nchrome.storage.local.get("newStorageKey")\n',
    "mix-aliases": (source) => source.replace(/defp aliases do\s*\[/, "$&\n      new_alias: [],"),
    "npm-scripts": (source) => JSON.stringify({...JSON.parse(source), scripts: {...JSON.parse(source).scripts, unmapped: "true"}}),
    "json-schema-properties": (source) => JSON.stringify({...JSON.parse(source), properties: {...JSON.parse(source).properties, unmapped: {type: "string"}}}),
    "ci-jobs": null,
    "mix-tasks": null
  };
  const mutation = mutations[registry.extractor];
  if (typeof mutation === "function") return mutation;
  if (typeof mutation === "string") return (source) => source + mutation;
  return null;
}

function main() {
  const result = validateContracts();
  console.log(`Webby E2E contract coverage: ${result.report.mapped}/${result.report.surfaces} mapped, ${result.report.excluded} excluded (${result.report.coverage_percent}%)`);
  console.log(`Scenarios: ${result.report.scenarios}; contract version: ${result.report.contract_version}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
