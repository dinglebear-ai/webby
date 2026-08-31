import {createHash, randomUUID} from "node:crypto"
import {spawn, spawnSync} from "node:child_process"
import {copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, stat, writeFile} from "node:fs/promises"
import {createConnection} from "node:net"
import {tmpdir} from "node:os"
import {basename, dirname, join, relative, resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {ArtifactRecorder} from "./artifacts.js"
import {openFileHandles, removeOwnedWorkspace} from "./temp-workspace.js"
import {reapManifest} from "./world.js"
import {readScenarioContract} from "./runtime-contracts.js"
import {parseScenarioTelemetry, readPlannedScenarioIds, writeSuiteTelemetry} from "./suite-telemetry.js"

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(e2eRoot, "..")
const artifactRoot = join(e2eRoot, "artifacts")
const ownershipMarker = ".webby-e2e-owned-root.json"

async function writeEmptyCleanupAudit(report, details = {}) {
  Object.assign(report, {empty_audit: true}, details)
  await rm(join(artifactRoot, "upload"), {recursive: true, force: true})
  await rm(join(artifactRoot, "cleanup-attested"), {recursive: true, force: true})
  await mkdir(artifactRoot, {recursive: true, mode: 0o700})
  await writeFile(join(artifactRoot, "cleanup-report.json"), JSON.stringify(report, null, 2) + "\n", {mode: 0o600})
  process.stdout.write(`${JSON.stringify(report)}\n`)
  return 0
}

async function persistCleanupReport(report) {
  await mkdir(artifactRoot, {recursive: true, mode: 0o700})
  const path = join(artifactRoot, "cleanup-report.json")
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", {mode: 0o600})
  return path
}

async function stageCleanupFailure(reportPath, report) {
  const recorderRoot = join(artifactRoot, "cleanup-attested")
  const uploadRoot = join(artifactRoot, "upload", "cleanup")
  await rm(recorderRoot, {recursive: true, force: true})
  await rm(uploadRoot, {recursive: true, force: true})
  const recorder = await new ArtifactRecorder({
    root: recorderRoot,
    scenarioId: "external-cleanup",
    worldId: "ci-runner",
    versions: {node: process.version},
  }).open()
  await recorder.ingest(reportPath, {name: "cleanup-report.json", kind: "report", essential: true})
  await recorder.recordFailure("cleanup", {summary: `${report.failures.length} cleanup failure(s)`})
  await recorder.finalize({status: "failed", cleanup: {external_reaper: "failed"}})
  await stageAttested(recorder, uploadRoot)
}

export async function initializeOwnedTempRoot(prefix = "webby-ci-run-") {
  const root = await mkdtemp(join(tmpdir(), prefix))
  try {
    await writeFile(join(root, ownershipMarker), JSON.stringify({schema_version: 1, nonce: randomUUID(), created_by: "webby-ci-runner"}) + "\n", {flag: "wx", mode: 0o600})
  } catch (error) {
    await rm(root, {recursive: true, force: true}).catch(() => {})
    throw error
  }
  return root
}

async function portClosed(port) {
  return new Promise(resolveClosed => {
    const socket = createConnection({host: "127.0.0.1", port})
    socket.once("connect", () => { socket.destroy(); resolveClosed(false) })
    socket.once("error", () => resolveClosed(true))
    socket.setTimeout(250, () => { socket.destroy(); resolveClosed(false) })
  })
}

async function removeOwnedMixResidue(temporaryRoot, name) {
  const uid = process.getuid?.()
  if (!Number.isInteger(uid) || !new RegExp(`^mix_(lock|pubsub)_user${uid}$`).test(name)) throw new Error(`unattested Mix residue name: ${name}`)
  const residueRoot = join(temporaryRoot, name)
  const rootInfo = await lstat(residueRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`Mix residue is not an owned directory: ${name}`)
  const kind = name.startsWith("mix_lock_") ? "lock" : "pubsub"
  const ports = []
  for (const namespace of await readdir(residueRoot, {withFileTypes: true})) {
    if (!namespace.isDirectory() || namespace.isSymbolicLink() || !/^[A-Za-z0-9_-]{16,64}$/.test(namespace.name)) throw new Error(`invalid Mix residue namespace: ${namespace.name}`)
    const namespaceRoot = join(residueRoot, namespace.name)
    for (const entry of await readdir(namespaceRoot, {withFileTypes: true})) {
      const match = entry.name.match(kind === "lock" ? /^(?:lock_\d+|port_(\d+))$/ : /^port_(\d+)$/)
      if (!entry.isFile() || entry.isSymbolicLink() || !match) throw new Error(`invalid Mix ${kind} residue entry: ${entry.name}`)
      const info = await lstat(join(namespaceRoot, entry.name))
      if (info.size > 1024) throw new Error(`oversized Mix ${kind} residue entry: ${entry.name}`)
      if (match[1]) { const port = Number(match[1]); if ((kind === "pubsub" && info.size !== 0) || port < 1 || port > 65_535) throw new Error(`invalid Mix port entry: ${entry.name}`); ports.push(port) }
    }
  }
  const handles = await openFileHandles(residueRoot)
  if (handles.length) throw new Error(`open handles remain in Mix residue: ${JSON.stringify(handles)}`)
  const openPorts = []
  for (const port of ports) if (!(await portClosed(port))) openPorts.push(port)
  if (openPorts.length) throw new Error(`Mix listeners remain: ${openPorts.join(",")}`)
  await rm(residueRoot, {recursive: true, force: false})
  return {root: name, removed: true, kind: `mix_${kind}`, ports_checked: ports.length}
}

const suites = {
  "protocol-pr": [
    "test/contracts.test.js", "test/browser-protocol-limits.test.js", "test/mcp-contract.test.js",
    "test/scenarios/protocol-happy-path.test.js", "test/scenarios/protocol-security.test.js",
    "test/scenarios/protocol-cancellation-races.test.js",
  ],
  "protocol-full": [
    "test/contracts.test.js", "test/ci-contract.test.js", "test/browser-protocol-limits.test.js", "test/mcp-contract.test.js",
    "test/simulated-browser.test.js", "test/world.test.js", "test/fixture-contract.test.js",
    "test/artifacts.test.js", "test/redaction.test.js", "test/lifecycle-parity.test.js",
    "test/scenarios/protocol-happy-path.test.js", "test/scenarios/protocol-security.test.js",
    "test/scenarios/protocol-cancellation-races.test.js", "test/scenarios/protocol-capacity.test.js",
    "test/scenarios/protocol-capacity-matrix.test.js", "test/scenarios/protocol-concurrency.test.js",
    "test/scenarios/protocol-db-contention.test.js", "test/scenarios/protocol-lifecycle.test.js",
    "test/scenarios/protocol-lifecycle-matrix-live.test.js", "test/scenarios/protocol-persistence-matrix.test.js",
    "test/scenarios/protocol-removal-boundaries.test.js", "test/scenarios/protocol-restart.test.js",
    "test/scenarios/protocol-retention-erasure.test.js", "test/scenarios/fixture-outcome-parity.test.js",
  ],
  "chromium-smoke": [
    "test/chromium/vertical-slice.test.js", "test/chromium/permissions-lifecycle.test.js",
  ],
  "chromium-full": [
    "test/chromium-bootstrap.test.js", "test/chromium/vertical-slice.test.js",
    "test/chromium/pairing-discovery.test.js", "test/chromium/popup-commands.test.js",
    "test/chromium/chrome-events.test.js", "test/chromium/dashboard-commands.test.js",
    "test/chromium/invocation-tools.test.js", "test/chromium/permissions-lifecycle.test.js",
    "test/chromium/reconnect-restart.test.js", "test/chromium/persistence-retention.test.js",
    "test/chromium/parity.test.js",
  ],
  "mcp-compat": ["test/mcp-official-client.test.js"],
}
const suiteScenarioDenominators = Object.freeze({
  "protocol-pr": ["e2e-shared-vertical-slice"],
  "protocol-full": ["e2e-capacity-concurrency", "e2e-command-ci-entrypoints", "e2e-fixture-tool-outcomes", "e2e-lifecycle-removal", "e2e-persistence-retention", "e2e-shared-vertical-slice", "e2e-transport-security"],
  "chromium-smoke": ["e2e-shared-vertical-slice", "e2e-lifecycle-removal"],
  "chromium-full": ["e2e-extension-controls", "e2e-fixture-tool-outcomes", "e2e-lifecycle-removal", "e2e-persistence-retention", "e2e-shared-vertical-slice"],
  "mcp-compat": [],
})
export function fullSuiteScenarioDenominators() {
  return Object.freeze(Object.fromEntries(["protocol-full", "chromium-full"].map(name => [name, Object.freeze([...suiteScenarioDenominators[name]])])))
}
const liveTestAttestations = Object.freeze({
  "protocol-full": Object.freeze({
    "e2e-capacity-concurrency": ["test/scenarios/protocol-capacity-matrix.test.js", "test/scenarios/protocol-concurrency.test.js"],
    "e2e-command-ci-entrypoints": ["test/ci-contract.test.js"],
    "e2e-persistence-retention": ["test/scenarios/protocol-persistence-matrix.test.js", "test/scenarios/protocol-retention-erasure.test.js"],
    "e2e-transport-security": ["test/scenarios/protocol-security.test.js"],
  }),
  "chromium-full": Object.freeze({
    "e2e-extension-controls": ["test/chromium/popup-commands.test.js", "test/chromium/chrome-events.test.js", "test/chromium/dashboard-commands.test.js"],
    "e2e-persistence-retention": ["test/chromium/persistence-retention.test.js"],
  }),
})

async function attestMissingScenarioRuns(name, driver, files, runs, {runNonce, outputDigest}) {
  const seen = new Set(runs.map(run => run.scenario_id))
  const receiptRoot = join(artifactRoot, "runtime-receipts")
  await mkdir(receiptRoot, {recursive: true, mode: 0o700})
  for (const [scenarioId, evidenceFiles] of Object.entries(liveTestAttestations[name] ?? {})) {
    if (seen.has(scenarioId)) continue
    for (const file of evidenceFiles) if (!files.includes(file)) throw new Error(`${name}: attestation file was not executed for ${scenarioId}: ${file}`)
    const executed = []
    for (const file of evidenceFiles) executed.push({file, source_sha256: sha256(await readFile(join(e2eRoot, file)))})
    const receipt = {schema_version: 1, suite: name, scenario_id: scenarioId, adapter: driver, run_nonce: runNonce, output_sha256: outputDigest, executed}
    const bytes = Buffer.from(JSON.stringify(receipt))
    const receiptName = `${scenarioId}-${driver}-runtime-receipt.json`
    await writeFile(join(receiptRoot, receiptName), bytes, {flag: "wx", mode: 0o600})
    runs.push({scenario_id: scenarioId, adapter: driver, duration_ms: 0, status: "passed", evidence_kind: "runtime_test_receipt", evidence_files: [`runtime-receipts/${receiptName}`], evidence_sha256: sha256(bytes), run_nonce: runNonce})
  }
  return runs
}

async function persistScenarioRunReceipts(name, runs, {runNonce, outputDigest}) {
  const receiptRoot = join(artifactRoot, "runtime-receipts")
  await mkdir(receiptRoot, {recursive: true, mode: 0o700})
  return Promise.all(runs.map(async run => {
    if (run.status !== "passed") return run
    if (run.run_nonce !== runNonce || !/^[a-f0-9]{64}$/.test(run.evidence_sha256 ?? "")) throw new Error(`${name}/${run.scenario_id}: runtime boundary receipt is not bound to this run`)
    const receipt = {schema_version: 1, suite: name, scenario_id: run.scenario_id, adapter: run.adapter, run_nonce: runNonce, output_sha256: outputDigest, boundary_evidence_sha256: run.evidence_sha256, boundary_evidence_files: run.evidence_files}
    const bytes = Buffer.from(JSON.stringify(receipt))
    const receiptName = `${run.scenario_id}-${run.adapter}-runtime-receipt.json`
    await writeFile(join(receiptRoot, receiptName), bytes, {flag: "wx", mode: 0o600})
    return {...run, evidence_kind: "runtime_test_receipt", evidence_files: [`runtime-receipts/${receiptName}`], evidence_sha256: sha256(bytes), run_nonce: runNonce}
  }))
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex") }
function safe(value) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new Error(`unsafe identifier: ${value}`)
  return value
}

async function scenarios() {
  const directory = join(e2eRoot, "contracts", "scenarios")
  return Promise.all((await readdir(directory)).filter(name => name.endsWith(".json")).sort().map(async name => {
    const value = await readScenarioContract(join(directory, name))
    return {id: value.id, tier: value.tier, weight: value.weight, drivers: value.drivers, source: `contracts/scenarios/${name}`}
  }))
}

export async function writeShardManifest({lane, driver, shard = 1, total = 1, output, selectedIds}) {
  if (!Number.isInteger(shard) || !Number.isInteger(total) || shard < 1 || total < 1 || shard > total) throw new Error("invalid shard")
  const tiers = lane === "pr" ? new Set(["pr"]) : lane === "main" ? new Set(["pr", "main"]) : new Set(["pr", "main", "nightly"])
  let inventory = (await scenarios()).filter(value => tiers.has(value.tier) && value.drivers.includes(driver))
  if (selectedIds !== undefined) {
    if (!Array.isArray(selectedIds) || new Set(selectedIds).size !== selectedIds.length) throw new Error("selected scenario IDs must be unique")
    const requested = new Set(selectedIds)
    inventory = inventory.filter(value => requested.has(value.id))
    const missing = selectedIds.filter(id => !inventory.some(value => value.id === id))
    if (missing.length) throw new Error(`selected scenarios are ineligible for ${lane}/${driver}: ${missing.join(",")}`)
  }
  const bins = Array.from({length: total}, (_, index) => ({index: index + 1, weight: 0, scenarios: []}))
  for (const scenario of inventory.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))) {
    const target = bins.sort((a, b) => a.weight - b.weight || a.index - b.index)[0]
    target.scenarios.push(scenario)
    target.weight += scenario.weight
  }
  bins.sort((a, b) => a.index - b.index)
  const selected = bins.flatMap(bin => bin.scenarios.map(value => value.id))
  if (selected.length !== inventory.length || new Set(selected).size !== inventory.length) throw new Error("shard union/intersection invariant failed")
  const manifest = {
    schema_version: 1, lane, driver, shard, total, generated_at: new Date().toISOString(),
    toolchains: {node: process.version, playwright: JSON.parse(await readFile(join(e2eRoot, "node_modules/playwright/package.json"))).version},
    inventory_sha256: sha256(Buffer.from(JSON.stringify(inventory))), inventory,
    shards: bins.map(bin => ({...bin, scenarios: bin.scenarios.map(value => value.id)})), selected: bins[shard - 1].scenarios.map(value => value.id),
  }
  await mkdir(dirname(output), {recursive: true, mode: 0o700})
  await writeFile(output, JSON.stringify(manifest, null, 2) + "\n", {mode: 0o600})
  process.stdout.write(`${output}\n`)
  return manifest
}

export async function stageAttested(recorder, upload = join(artifactRoot, "upload")) {
  const candidates = await recorder.uploadCandidates()
  if (candidates.length === 0) throw new Error("artifact attestation produced no upload candidates")
  await mkdir(upload, {recursive: true, mode: 0o700})
  for (const candidate of candidates) {
    const artifact = relative(recorder.stagingRoot, candidate)
    if (!artifact || artifact.startsWith("..")) throw new Error("attested upload candidate escaped staging")
    const target = join(upload, artifact)
    await mkdir(dirname(target), {recursive: true, mode: 0o700})
    await copyFile(candidate, target)
  }
  await copyFile(recorder.attestationPath, join(upload, "upload-attestation.json"))
}

export async function runSuite(name) {
  const invokedAt = Date.now()
  const files = suites[name]
  if (!files) throw new Error(`unknown suite: ${name}`)
  // Reap the previous run before rotating its evidence pointer. Deleting the
  // artifact directory first used to erase the only path to an interrupted
  // run's temporary root, making the following cleanup a false green.
  let previousRoot
  try { previousRoot = (await readFile(join(artifactRoot, "run-temp-path"), "utf8")).trim() }
  catch (error) { if (error.code !== "ENOENT") throw error }
  if (previousRoot && await cleanupWorlds({recordedRoot: previousRoot}) !== 0) throw new Error(`previous E2E run cleanup failed: ${previousRoot}`)
  await mkdir(artifactRoot, {recursive: true, mode: 0o700})
  for (const path of ["scenario-manifest.json", "test-output.log", "suite-telemetry.json", "cleanup-report.json"]) await rm(join(artifactRoot, path), {force: true})
  for (const directory of ["attested", "upload", "cleanup-attested", "runtime-receipts"]) await rm(join(artifactRoot, directory), {recursive: true, force: true})
  const manifestPath = join(artifactRoot, "scenario-manifest.json")
  let runTemp
  try {
    runTemp = await initializeOwnedTempRoot()
    await writeFile(join(artifactRoot, "run-temp-path"), `${await realpath(runTemp)}\n`, {mode: 0o600})
  } catch (error) {
    if (runTemp) await rm(runTemp, {recursive: true, force: true}).catch(() => {})
    throw error
  }
  const driver = name.startsWith("chromium") ? "chromium" : "protocol"
  // Chromium smoke deliberately includes the main-tier lifecycle-removal
  // contract, so its executable manifest must use the main denominator even
  // though the suite is a required pull-request gate.
  const lane = name === "protocol-pr" ? "pr" : "main"
  await writeShardManifest({lane, driver, output: manifestPath, selectedIds: suiteScenarioDenominators[name]})
  const logPath = join(artifactRoot, "test-output.log")
  const scenarioTelemetryPath = join(runTemp, "scenario-runs.ndjson")
  const runNonce = randomUUID()
  const chunks = []; let bytes = 0; const limit = 8 * 1024 * 1024
  const startedAt = new Date()
  const capture = stream => stream.on("data", chunk => {
    process.stdout.write(chunk); if (bytes < limit) { const kept = chunk.subarray(0, limit - bytes); chunks.push(kept); bytes += kept.length }
  })
  let status = 1; let infrastructureError
  try {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
      cwd: e2eRoot, env: {...process.env, TMPDIR: runTemp, WEBBY_E2E_TMP_ROOT: runTemp, WEBBY_E2E_RUN_NONCE: runNonce, WEBBY_E2E_SCENARIO_TELEMETRY: scenarioTelemetryPath, WEBBY_E2E_SCENARIO_DENOMINATOR: suiteScenarioDenominators[name].map(id => `${driver}:${id}`).join(","), MCP_TELEMETRY: "0", MCP_UPDATE_CHECK: "0"}, stdio: ["ignore", "pipe", "pipe"],
    })
    capture(child.stdout); capture(child.stderr)
    status = await new Promise(resolveStatus => { child.once("error", error => { infrastructureError = error.message; resolveStatus(1) }); child.once("exit", code => resolveStatus(code ?? 1)) })
  } catch (error) { infrastructureError = error.message }
  await writeFile(logPath, Buffer.concat(chunks), {mode: 0o600})
  const finishedAt = new Date()
  let scenarioRuns = []
  try { scenarioRuns = parseScenarioTelemetry(await readFile(scenarioTelemetryPath, "utf8")) } catch (error) { if (error.code !== "ENOENT") { infrastructureError ??= error.message; status = 1 } }
  finally { await rm(scenarioTelemetryPath, {force: true}) }
  if (status === 0) {
    const outputDigest = sha256(Buffer.concat(chunks))
    scenarioRuns = await persistScenarioRunReceipts(name, scenarioRuns, {runNonce, outputDigest})
    scenarioRuns = await attestMissingScenarioRuns(name, driver, files, scenarioRuns, {runNonce, outputDigest})
  }
  const plannedScenarioIds = await readPlannedScenarioIds(manifestPath, suiteScenarioDenominators[name])
  const observedScenarioIds = [...new Set(scenarioRuns.map(run => run.scenario_id))].sort()
  if (status === 0 && JSON.stringify(plannedScenarioIds) !== JSON.stringify(observedScenarioIds)) { status = 1; infrastructureError = `scenario telemetry denominator drifted: planned=${plannedScenarioIds.join(",")} observed=${observedScenarioIds.join(",")}` }
  await writeSuiteTelemetry(join(artifactRoot, "suite-telemetry.json"), {
    suite: name, status: status === 0 ? "passed" : "failed", startedAt, finishedAt,
    setupMs: startedAt.getTime() - invokedAt, attempts: 1, retries: 0, plannedScenarioIds, scenarioRuns, infrastructureError, adapter: driver,
  })
  if (status !== 0) {
    const root = join(artifactRoot, "attested")
    const secrets = Object.entries(process.env).filter(([key, value]) => value && String(value).length >= 4 && /token|secret|password|authorization|cookie|signature|api[_-]?key/i.test(key)).map(([, value]) => String(value))
    const recorder = await new ArtifactRecorder({root, scenarioId: safe(name), worldId: "ci-runner", versions: {node: process.version}, secrets}).open()
    await recorder.ingest(logPath, {name: "test-output.log", kind: "log", essential: true})
    await recorder.ingest(manifestPath, {name: "scenario-manifest.json", kind: "manifest", essential: true})
    await recorder.recordFailure("harness", {summary: `${name} exited ${status}`})
    await recorder.finalize({status: "failed", cleanup: {external_reaper: "pending"}})
    await stageAttested(recorder)
  }
  return status
}

export async function cleanupWorlds({temporaryRoot: suppliedRoot, recordedRoot: suppliedRecordedRoot} = {}) {
  const report = {schema_version: 1, roots: [], failures: []}
  let recordedRoot
  try { recordedRoot = suppliedRecordedRoot ?? (await readFile(join(artifactRoot, "run-temp-path"), "utf8")).trim() } catch (error) { if (error.code !== "ENOENT") throw error }
  if (!recordedRoot && !suppliedRoot && !process.env.WEBBY_E2E_TMP_ROOT) {
    return writeEmptyCleanupAudit(report)
  }
  let temporaryRoot
  try { temporaryRoot = await realpath(resolve(suppliedRoot ?? process.env.WEBBY_E2E_TMP_ROOT ?? recordedRoot)) }
  catch (error) {
    if (error.code !== "ENOENT" || suppliedRoot || process.env.WEBBY_E2E_TMP_ROOT) throw error
    return writeEmptyCleanupAudit(report, {recorded_root_absent: true})
  }
  const canonicalTmp = await realpath(tmpdir())
  if (temporaryRoot === canonicalTmp || !temporaryRoot.startsWith(`${canonicalTmp}/`) || !basename(temporaryRoot).startsWith("webby-ci-run-")) throw new Error("cleanup refused: root is outside the private Webby temp namespace")
  let marker
  try { marker = JSON.parse(await readFile(join(temporaryRoot, ownershipMarker), "utf8")) } catch { throw new Error("cleanup refused: ownership marker is missing or invalid") }
  if (marker.schema_version !== 1 || marker.created_by !== "webby-ci-runner" || typeof marker.nonce !== "string") throw new Error("cleanup refused: ownership marker is invalid")
  const manifests = []
  async function discover(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await discover(path)
      else if (entry.isFile() && entry.name === "world.json" && basename(dirname(path)).startsWith("webby-e2e-")) manifests.push(path)
    }
  }
  await discover(temporaryRoot)
  for (const manifestPath of manifests) {
    const root = await realpath(dirname(manifestPath)); const manifest = join(root, "world.json")
    try {
      await stat(manifest); const reaped = await reapManifest(manifest); const handles = await openFileHandles(root)
      if (handles.length) throw new Error(`open handles remain: ${JSON.stringify(handles)}`)
      await removeOwnedWorkspace(root); report.roots.push({root: basename(root), reaped, removed: true})
    } catch (error) {
      if (error.code !== "ENOENT") report.failures.push({root: basename(root), error: error.message})
    }
  }
  if (report.failures.length === 0) {
    let residue = (await readdir(temporaryRoot)).filter(name => name !== ownershipMarker)
    for (const name of residue.filter(value => value.startsWith("mix_lock_") || value.startsWith("mix_pubsub_"))) {
      try { report.roots.push(await removeOwnedMixResidue(temporaryRoot, name)) }
      catch (error) { report.failures.push({root: name, error: error.message}) }
    }
    residue = (await readdir(temporaryRoot)).filter(name => name !== ownershipMarker)
    if (residue.length) report.failures.push({root: basename(temporaryRoot), error: `unattested residue remains: ${residue.join(",")}`})
    else { await rm(join(temporaryRoot, ownershipMarker)); await rmdir(temporaryRoot) }
  }
  let reportPath = await persistCleanupReport(report)
  if (report.failures.length) {
    try { await stageCleanupFailure(reportPath, report) }
    catch (error) {
      report.failures.push({root: "cleanup-evidence", error: `failed to attest cleanup report: ${error.message}`})
      reportPath = await persistCleanupReport(report)
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
  return report.failures.length === 0 ? 0 : 1
}

async function executable(name, args) {
  const lookup = spawnSync(process.platform === "win32" ? "where" : "which", [name], {encoding: "utf8"})
  const path = lookup.stdout.trim().split("\n")[0]
  const version = spawnSync(name, args, {encoding: "utf8"})
  return {name, path, sha256: path ? sha256(await readFile(path)) : null, version: `${version.stdout}${version.stderr}`.trim().split("\n")[0]}
}

export async function toolchains() {
  const values = await Promise.all([executable("node", ["--version"]), executable("npm", ["--version"]), executable("elixir", ["--version"]), executable("mix", ["--version"])])
  try {
    const {chromium} = await import("playwright")
    const path = chromium.executablePath()
    values.push({name: "playwright-chromium", path, sha256: sha256(await readFile(path)), version: JSON.parse(await readFile(join(e2eRoot, "node_modules/playwright/package.json"))).version})
  } catch (error) { values.push({name: "playwright-chromium", installed: false, error: error.code ?? error.message}) }
  process.stdout.write(`${JSON.stringify(values, null, 2)}\n`)
}

export async function replay(path) {
  const manifest = JSON.parse(await readFile(join(resolve(path), "replay-manifest.json"), "utf8"))
  if (manifest.schema_version !== 1 || !manifest.scenario_id || !Array.isArray(manifest.items)) throw new Error("invalid replay manifest")
  process.stdout.write(`${JSON.stringify({scenario_id: manifest.scenario_id, seed: manifest.seed, status: manifest.status, items: manifest.items.map(item => item.name)}, null, 2)}\n`)
}
