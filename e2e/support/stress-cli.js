#!/usr/bin/env node
import {randomUUID} from "node:crypto"
import {spawn} from "node:child_process"
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"
import {fileURLToPath, pathToFileURL} from "node:url"
import {ArtifactRecorder} from "./artifacts.js"
import {stageAttested} from "./ci-runner.js"
import {detectLeaks} from "./leak-detector.js"
import {captureProcessIdentity, reapProcessGroup} from "./process-tree.js"
import {readReplayManifest} from "./seed-replay.js"
import {runStress} from "./stress-runner.js"
import {stressScenarioFiles, stressScenarios, validateStressScenarios} from "./stress-scenarios.js"
import {removeOwnedWorkspace} from "./temp-workspace.js"
import {reapManifest} from "./world.js"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
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

async function child(command, args, {signal, env, cwd, timeoutMs = 120_000}) {
  const nonce = `webby-stress-${randomUUID()}`
  const childProcess = spawn(command, args, {cwd, env: {...env, WEBBY_STRESS_PROCESS_NONCE: nonce}, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"]})
  const identity = process.platform === "win32" ? null : await captureProcessIdentity(childProcess.pid, "")
  const chunks = []; let bytes = 0; const limit = 8 * 1024 * 1024
  for (const stream of [childProcess.stdout, childProcess.stderr]) stream.on("data", chunk => { process.stdout.write(chunk); if (bytes < limit) { const kept = chunk.subarray(0, limit - bytes); chunks.push(kept); bytes += kept.length } })
  const terminate = async () => identity ? reapProcessGroup(identity, "", {graceMs: 2_000}).catch(() => {}) : childProcess.kill("SIGTERM")
  signal?.addEventListener("abort", terminate, {once: true}); const timer = setTimeout(terminate, timeoutMs); timer.unref?.()
  try {
    const code = await new Promise((resolveExit, reject) => { childProcess.once("error", reject); childProcess.once("exit", value => resolveExit(value ?? 1)) })
    const output = Buffer.concat(chunks)
    if (signal?.aborted) throw signal.reason ?? new Error("stress child cancelled")
    if (code !== 0) throw Object.assign(new Error(`${command} exited ${code}`), {output})
    return output
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", terminate); if (identity) await reapProcessGroup(identity, "", {graceMs: 500}).catch(() => {}) }
}

async function collect(workerTmp, resource) {
  for (const name of (await readdir(workerTmp).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))).filter(value => value.startsWith("webby-e2e-"))) {
    const world = join(workerTmp, name); if (resource.workspaces.includes(world)) continue
    resource.workspaces.push(world); resource.roots.push(world)
    try { const manifest = JSON.parse(await readFile(join(world, "world.json"), "utf8")); resource.pids.push(manifest.pid); resource.ports.push(manifest.bound_port); resource.profiles.push(manifest.browser_profile_path); resource.databases.push(manifest.database_path) }
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

export async function main(args = process.argv.slice(2), env = process.env) {
  const config = await parseStressOptions(args, env); const artifactRoot = resolve(option(args, "artifacts", join(root, "artifacts", "stress")))
  await mkdir(artifactRoot, {recursive: true, mode: 0o700}); await mkdir(join(root, "artifacts"), {recursive: true, mode: 0o700})
  const runTempRoot = await mkdtemp(join(tmpdir(), "webby-stress-run-")); await writeFile(join(root, "artifacts", "run-temp-path"), `${runTempRoot}\n`, {mode: 0o600})
  const controller = new AbortController(); const handlers = Object.fromEntries(["SIGTERM", "SIGINT"].map(name => [name, () => controller.abort(new Error(`stress runner received ${name}`))]))
  for (const [name, handler] of Object.entries(handlers)) process.once(name, handler)
  const resources = new Map(); let result; let failure; let cleanupFailure
  try {
    result = await runStress({...config, artifactRoot, signal: controller.signal,
      execute: async ({run, attempt, seed, scenarioIds, root: attemptRoot, signal}) => {
        const workerTmp = join(runTempRoot, `worker-${run}`); await mkdir(workerTmp, {recursive: true, mode: 0o700})
        const resource = resources.get(run) ?? {workerTmp, roots: [], workspaces: [], profiles: [], databases: [], pids: [], ports: [], pendingCalls: [], staleSessions: []}; resources.set(run, resource)
        const recorder = await new ArtifactRecorder({root: join(attemptRoot, "attested"), scenarioId: "stress-attempt", worldId: `run-${run}-attempt-${attempt}`, seed, versions: {node: process.version}, secrets: secretsFrom(env)}).open(); let error
        try { for (const id of scenarioIds) { const output = await child(process.execPath, ["--test", "--test-concurrency=1", ...stressScenarioFiles[id]], {cwd: root, signal, env: {...env, TMPDIR: workerTmp, WEBBY_E2E_TMP_ROOT: workerTmp, MCP_TELEMETRY: "0", MCP_UPDATE_CHECK: "0"}}); const path = join(attemptRoot, `${id}.log`); await writeFile(path, output, {mode: 0o600}); await recorder.ingest(path, {name: `${id}.log`, kind: "log", essential: true}) } }
        catch (caught) { error = caught; const path = join(attemptRoot, "failure-output.log"); await writeFile(path, caught.output ?? Buffer.from(caught.stack ?? caught.message), {mode: 0o600}); await recorder.ingest(path, {name: "failure-output.log", kind: "log", essential: true}); await recorder.recordFailure("harness", {summary: caught.message}) }
        finally { await collect(workerTmp, resource); await recorder.finalize({status: error ? "failed" : "passed", cleanup: {external_reaper: "required"}}); await stageAttested(recorder, join(artifactRoot, "upload", `run-${run}-attempt-${attempt}`)) }
        if (error) throw error
      }, leakProbe: async ({run}) => detectLeaks(resources.get(run))})
  } catch (error) { failure = error }
  finally {
    for (const resource of resources.values()) try { await collect(resource.workerTmp, resource); await cleanupResources(resource) } catch (error) { cleanupFailure ??= error }
    for (const [name, handler] of Object.entries(handlers)) process.removeListener(name, handler)
    if (!cleanupFailure) await rm(runTempRoot, {recursive: true, force: true})
  }
  if (result) process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], "stress execution and cleanup both failed")
  if (failure) throw failure
  if (cleanupFailure) throw cleanupFailure
  if (result.report.initial_failures) process.exitCode = 1
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
