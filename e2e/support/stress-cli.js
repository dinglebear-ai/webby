#!/usr/bin/env node
import {randomUUID} from "node:crypto"
import {execFile, spawn} from "node:child_process"
import {mkdir, readFile, readdir, rm, stat, writeFile} from "node:fs/promises"
import {join, resolve} from "node:path"
import {fileURLToPath, pathToFileURL} from "node:url"
import {promisify} from "node:util"
import {ArtifactRecorder} from "./artifacts.js"
import {cleanupWorlds, initializeOwnedTempRoot, stageAttested} from "./ci-runner.js"
import {collectCleanup, throwCleanupFailures} from "./cleanup-plan.js"
import {detectLeaks} from "./leak-detector.js"
import {captureProcessIdentity, reapProcessGroup} from "./process-tree.js"
import {readReplayManifest} from "./seed-replay.js"
import {runStress} from "./stress-runner.js"
import {stressScenarioFiles, stressScenarios, validateRequiredMeasurements, validateStressScenarios} from "./stress-scenarios.js"
import {removeOwnedWorkspace} from "./temp-workspace.js"
import {forceReapSpawnedGroup, reapManifest} from "./world.js"
import {readWorldManifest} from "./runtime-contracts.js"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const execFileAsync = promisify(execFile)
const option = (args, name, fallback) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
function integer(args, name, fallback, minimum) { const value = Number(option(args, name, fallback)); if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`); return value }
const secretsFrom = env => Object.entries(env).filter(([key, value]) => value && String(value).length >= 4 && /token|secret|password|authorization|cookie|signature|api[_-]?key/i.test(key)).map(([, value]) => String(value))

export async function parseStressOptions(args = process.argv.slice(2), env = process.env) {
  const replayPath = option(args, "replay")
  const conflicts = ["seed", "scenarios", "repetitions", "concurrency", "retries"].filter(name => args.some(value => value.startsWith(`--${name}=`)))
  if (replayPath && conflicts.length) throw new Error(`--replay conflicts with ${conflicts.map(name => `--${name}`).join(", ")}`)
  if (replayPath) { const replay = await readReplayManifest(replayPath); return {seed: replay.seed, scenarios: validateStressScenarios(replay.scenario_ids), repetitions: 1, concurrency: 1, retries: 0, exactReplay: true} }
  return {seed: option(args, "seed", env.WEBBY_STRESS_SEED ?? new Date().toISOString().slice(0, 10)), scenarios: validateStressScenarios(option(args, "scenarios")?.split(",") ?? stressScenarios), repetitions: integer(args, "repetitions", env.WEBBY_STRESS_REPETITIONS ?? "1", 1), concurrency: integer(args, "concurrency", env.WEBBY_STRESS_CONCURRENCY ?? "1", 1), retries: integer(args, "retries", env.WEBBY_STRESS_RETRIES ?? "0", 0), exactReplay: false}
}

export async function runStressChild(command, args, {signal, env, cwd, timeoutMs = 120_000}) {
  const nonce = `webby-stress-${randomUUID()}`
  const commandArgs = command === process.execPath ? [`--title=${nonce}`, ...args] : args
  const childProcess = spawn(command, commandArgs, {cwd, env: {...env, WEBBY_STRESS_PROCESS_NONCE: nonce}, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"]})
  const exited = new Promise((resolveExit, reject) => {
    childProcess.once("error", reject)
    childProcess.once("exit", value => resolveExit(value ?? 1))
  })
  let identity
  const chunks = []; let bytes = 0; const limit = 8 * 1024 * 1024
  for (const stream of [childProcess.stdout, childProcess.stderr]) stream.on("data", chunk => { process.stdout.write(chunk); if (bytes < limit) { const kept = chunk.subarray(0, limit - bytes); chunks.push(kept); bytes += kept.length } })
  let timedOut = false; let termination
  const terminate = () => termination ??= (identity ? reapProcessGroup(identity, nonce, {graceMs: 2_000}) : process.platform === "win32" ? Promise.resolve(childProcess.kill("SIGTERM")) : forceReapSpawnedGroup(childProcess, childProcess.pid, {graceMs: 2_000}))
  signal?.addEventListener("abort", terminate, {once: true}); const timer = setTimeout(() => { timedOut = true; void terminate() }, timeoutMs); timer.unref?.()
  let exitTimer
  try {
    try {
      identity = process.platform === "win32" ? null : await captureProcessIdentity(childProcess.pid, nonce)
    } catch (error) {
      if (timedOut) { await termination; throw Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), {output: Buffer.concat(chunks), cause: error}) }
      if (signal?.aborted) { await termination; throw signal.reason ?? new Error("stress child cancelled") }
      throw error
    }
    const boundedExit = new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error(`${command} child did not exit after bounded reap`)), timeoutMs + 5_000) })
    const code = await Promise.race([exited, boundedExit])
    const output = Buffer.concat(chunks)
    if (signal?.aborted) throw signal.reason ?? new Error("stress child cancelled")
    if (timedOut) throw Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), {output})
    if (code !== 0) throw Object.assign(new Error(`${command} exited ${code}`), {output})
    return output
  } finally {
    clearTimeout(timer); clearTimeout(exitTimer); signal?.removeEventListener("abort", terminate)
    if (identity) await reapProcessGroup(identity, nonce, {graceMs: 500})
    else if (childProcess.pid && !termination) await forceReapSpawnedGroup(childProcess, childProcess.pid)
  }
}

export async function collectStressResources(workerTmp, resource) {
  for (const name of (await readdir(workerTmp).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))).filter(value => value.startsWith("webby-e2e-"))) {
    const world = join(workerTmp, name); if (resource.workspaces.includes(world)) continue
    resource.workspaces.push(world); resource.roots.push(world)
    try {
      const manifest = await readWorldManifest(join(world, "world.json")); resource.pids.push(manifest.pid)
      for (const url of [manifest.base_url, manifest.fixture_url]) { const port = Number(new URL(url).port); if (port) resource.ports.push(port) }
      resource.profiles.push(manifest.browser_profile_path); resource.databases.push(manifest.database_path)
      const {stdout} = await execFileAsync("sqlite3", [manifest.database_path, "SELECT 'pending:' || id FROM invocation_audits WHERE outcome='started' UNION ALL SELECT 'session:' || id FROM document_sessions WHERE status='active';"])
      for (const line of stdout.trim().split("\n").filter(Boolean)) line.startsWith("pending:") ? resource.pendingCalls.push(line.slice(8)) : resource.staleSessions.push(line.slice(8))
    }
    catch (error) { if (error.code !== "ENOENT") throw error }
  }
}

async function cleanupResources(resource) {
  const failures = []
  for (const world of resource.workspaces) {
    try { await reapManifest(join(world, "world.json")); await removeOwnedWorkspace(world) }
    catch (error) { if (error.code !== "ENOENT") failures.push(`${world}: ${error.message}`) }
  }
  const report = await detectLeaks(resource)
  const residue = Object.entries(report).filter(([, values]) => values.length)
  if (residue.length) failures.push(residue.map(([name, values]) => `${name}=${values.length}`).join(", "))
  if (failures.length) throw new Error(`stress final cleanup failed: ${failures.join("; ")}`)
}

export async function finalizeStressResources(resources, {collect = collectStressResources, cleanup = cleanupResources} = {}) {
  const failures = []
  let index = 0
  for (const resource of resources) {
    index += 1
    const result = await collectCleanup([
      [`resource-${index}-collect`, () => collect(resource.workerTmp, resource)],
      [`resource-${index}-cleanup`, () => cleanup(resource)],
    ])
    failures.push(...result.failures)
  }
  return failures
}

export async function scenarioTimeoutMs(files) {
  let total = 60_000
  for (const file of files) {
    const source = await readFile(join(root, file), "utf8")
    const declared = [...source.matchAll(/timeout:\s*([0-9][0-9_]*)/g)].map(match => Number(match[1].replaceAll("_", "")))
    total += Math.max(120_000, ...declared)
  }
  return Math.min(total, 30 * 60_000)
}

export function stressMeasurements(output) {
  return output.toString("utf8").split("\n").flatMap(line => {
    const match = line.match(/(?:^|#\s*)WEBBY_STRESS_MEASUREMENT=(\{.*\})\s*$/)
    return match ? [JSON.parse(match[1])] : []
  })
}

export async function validateScenarioEvidence(evidence, scenarioIds, artifact) {
  if (!Array.isArray(evidence) || evidence.length !== scenarioIds.length) throw new Error("selected scenario IDs did not bind one-to-one to executed evidence")
  const attested = artifact?.attestation?.files?.map(file => file.path) ?? []
  const candidates = artifact?.uploadCandidates ?? []
  for (const [index, value] of evidence.entries()) {
    const expectedId = scenarioIds[index]; const expectedFiles = stressScenarioFiles[expectedId]
    if (value?.scenario_id !== expectedId || value.status !== "passed" || new Set(evidence.map(item => item.scenario_id)).size !== evidence.length) throw new Error("scenario execution evidence ID/order/status was invalid")
    if (!Array.isArray(value.executed_files) || value.executed_files.length !== expectedFiles.length || value.executed_files.some((file, fileIndex) => file !== expectedFiles[fileIndex])) throw new Error(`scenario execution evidence files were forged for ${expectedId}`)
    if (!Number.isInteger(value.duration_ms) || value.duration_ms < 1 || !Array.isArray(value.measurements)) throw new Error(`scenario execution measurements were invalid for ${expectedId}`)
    const attestedMatches = attested.filter(path => path === value.attested_log || path.endsWith(`-${value.attested_log}`))
    const candidateMatches = candidates.filter(path => path.endsWith(`/${value.attested_log}`) || path.endsWith(`-${value.attested_log}`))
    const logPath = candidateMatches[0]
    if (attestedMatches.length !== 1 || candidateMatches.length !== 1 || !(await stat(logPath)).isFile()) throw new Error(`scenario execution log was not finalized and attested for ${expectedId}`)
    if (JSON.stringify(stressMeasurements(await readFile(logPath))) !== JSON.stringify(value.measurements)) throw new Error(`scenario execution measurements did not match the attested log for ${expectedId}`)
    validateRequiredMeasurements(expectedId, value.measurements)
    for (const file of expectedFiles) if (!(await stat(join(root, file))).isFile()) throw new Error(`registered scenario file is absent: ${file}`)
  }
  return evidence
}

export function throwStressFailures(primary, finalErrors = []) {
  throwCleanupFailures(finalErrors, "stress scenario execution and finalization failed", {primaryError: primary})
}

async function runStressScenario({id, attemptRoot, workerTmp, recorder, signal, env}) {
  const started = Date.now()
  const files = stressScenarioFiles[id]
  const output = await runStressChild(
    process.execPath,
    ["--test", "--test-concurrency=1", ...files],
    {
      cwd: root,
      signal,
      env: {...env, TMPDIR: workerTmp, WEBBY_E2E_TMP_ROOT: workerTmp, MCP_TELEMETRY: "0", MCP_UPDATE_CHECK: "0"},
      timeoutMs: await scenarioTimeoutMs(files),
    },
  )
  const logName = `${id}.log`
  const path = join(attemptRoot, logName)
  await writeFile(path, output, {mode: 0o600})
  await recorder.ingest(path, {name: logName, kind: "log", essential: true})
  return {scenario_id: id, executed_files: [...files], status: "passed", duration_ms: Math.max(1, Date.now() - started), measurements: stressMeasurements(output), attested_log: logName}
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const config = await parseStressOptions(args, env); const artifactRoot = resolve(option(args, "artifacts", join(root, "artifacts", "stress")))
  await mkdir(artifactRoot, {recursive: true, mode: 0o700}); await mkdir(join(root, "artifacts"), {recursive: true, mode: 0o700})
  const runTempPath = join(root, "artifacts", "run-temp-path")
  let previousRoot
  try { previousRoot = (await readFile(runTempPath, "utf8")).trim() }
  catch (error) { if (error.code !== "ENOENT") throw error }
  if (previousRoot && await cleanupWorlds({recordedRoot: previousRoot}) !== 0) throw new Error(`previous stress run cleanup failed: ${previousRoot}`)
  let runTempRoot
  try {
    runTempRoot = await initializeOwnedTempRoot("webby-ci-run-stress-")
    await writeFile(runTempPath, `${runTempRoot}\n`, {mode: 0o600})
  } catch (error) {
    if (runTempRoot) await rm(runTempRoot, {recursive: true, force: true}).catch(() => {})
    throw error
  }
  const controller = new AbortController(); const handlers = Object.fromEntries(["SIGTERM", "SIGINT"].map(name => [name, () => controller.abort(new Error(`stress runner received ${name}`))]))
  for (const [name, handler] of Object.entries(handlers)) process.once(name, handler)
  const resources = new Map(); let result; let failure; let cleanupFailures = []
  try {
    result = await runStress({...config, artifactRoot, signal: controller.signal,
      execute: async ({run, attempt, seed, scenarioIds, root: attemptRoot, signal}) => {
        const workerTmp = join(runTempRoot, `worker-${run}`); await mkdir(workerTmp, {recursive: true, mode: 0o700})
        const resource = resources.get(run) ?? {workerTmp, roots: [], workspaces: [], profiles: [], databases: [], pids: [], ports: [], pendingCalls: [], staleSessions: []}; resources.set(run, resource)
        const recorder = await new ArtifactRecorder({root: join(attemptRoot, "attested"), scenarioId: "stress-attempt", worldId: `run-${run}-attempt-${attempt}`, seed, versions: {node: process.version}, secrets: secretsFrom(env)}).open(); let error
        const finalErrors = []
        const evidence = []
        try {
          for (const id of scenarioIds) {
            evidence.push(await runStressScenario({id, attemptRoot, workerTmp, recorder, signal, env}))
          }
        }
        catch (caught) {
          error = caught; const path = join(attemptRoot, "failure-output.log")
          for (const operation of [() => writeFile(path, caught.output ?? Buffer.from(caught.stack ?? caught.message), {mode: 0o600}), () => recorder.ingest(path, {name: "failure-output.log", kind: "log", essential: true}), () => recorder.recordFailure("harness", {summary: caught.message})]) try { await operation() } catch (failureArtifactError) { finalErrors.push(failureArtifactError) }
        }
        let artifact
        try { await collectStressResources(workerTmp, resource) } catch (collectError) { finalErrors.push(collectError) }
        try { artifact = await recorder.finalize({status: error ? "failed" : "passed", cleanup: {external_reaper: "required"}}) } catch (finalizeError) { finalErrors.push(finalizeError) }
        if (artifact) try { await validateScenarioEvidence(evidence, scenarioIds, artifact); await stageAttested(recorder, join(artifactRoot, "upload", `run-${run}-attempt-${attempt}`)) } catch (stageError) { finalErrors.push(stageError) }
        throwStressFailures(error, finalErrors)
        return evidence
      }, leakProbe: async ({run}) => detectLeaks(resources.get(run))})
  } catch (error) { failure = error }
  finally {
    cleanupFailures = await finalizeStressResources(resources.values())
    for (const [name, handler] of Object.entries(handlers)) process.removeListener(name, handler)
    if (cleanupFailures.length === 0) {
      const removal = await collectCleanup([["stress-temporary-root", () => rm(runTempRoot, {recursive: true, force: true})]])
      cleanupFailures.push(...removal.failures)
    }
  }
  if (result) process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
  throwCleanupFailures(cleanupFailures, "stress execution and cleanup failed", {primaryError: failure})
  if (result.report.initial_failures) process.exitCode = 1
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
