import {execFile} from "node:child_process"
import {access, readFile, stat, unlink} from "node:fs/promises"
import {promisify} from "node:util"
import {processExists, processGroupMembers} from "./process-tree.js"

const execFileAsync = promisify(execFile)

function identifier(value) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error("unsafe SQLite identifier")
  return `"${value}"`
}

export async function sqlite(database, sql) {
  const {stdout} = await execFileAsync("sqlite3", ["-json", database, sql], {maxBuffer: 16 * 1024 * 1024})
  return stdout.trim() ? JSON.parse(stdout) : []
}

export async function executeSql(database, sql) {
  await execFileAsync("sqlite3", [database, sql], {maxBuffer: 16 * 1024 * 1024})
}

export async function checkpointedDiagnostics(world, {tables, recorder, name = "persistence-diagnostics.json"}) {
  if (!recorder?.producers?.world) throw new Error("persistence diagnostics require an artifact recorder")
  await executeSql(world.databasePath, "PRAGMA wal_checkpoint(TRUNCATE);")
  const rows = {}
  for (const [table, columns] of Object.entries(tables)) {
    const selected = columns.map(identifier).join(",")
    rows[table] = await sqlite(world.databasePath, `SELECT ${selected} FROM ${identifier(table)} ORDER BY 1`)
  }
  const walPath = `${world.databasePath}-wal`
  const walBytes = await stat(walPath).then(value => value.size, error => error.code === "ENOENT" ? 0 : Promise.reject(error))
  const diagnostics = {schema_version: 1, checkpoint: "truncate", wal_bytes: walBytes, tables: rows}
  const artifact = await recorder.producers.world.diagnostic(name, diagnostics, ["schema_version", "checkpoint", "wal_bytes", "tables"])
  return {artifact, diagnostics}
}

export async function persistenceOperation(world, payload) {
  if (payload?.op === "browser.erase") {
    const response = await fetch(`${world.baseUrl}/e2e/persistence`, {
      method: "POST",
      headers: {"content-type": "application/json", "x-webby-e2e-capability": world.telemetryCapability},
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    })
    const result = await response.json()
    if (!response.ok || result.status !== "ok") {
      const diagnostics = await Promise.all([world.stdoutPath, world.stderrPath].map(path => readFile(path, "utf8").catch(() => "diagnostics unavailable")))
      throw new Error(`in-world persistence operation failed: ${response.status} ${JSON.stringify(result)}\n${diagnostics.join("\n").slice(-12_000)}`)
    }
    return JSON.stringify(result.result)
  }
  const env = {...world.environment(), PHX_SERVER: "false", WEBBY_E2E_PERSISTENCE_OPERATION: JSON.stringify(payload)}
  const {stdout, stderr} = await execFileAsync("mix", ["run", "--no-start", "e2e/support/persistence-probe.exs"], {
    cwd: new URL("../..", import.meta.url).pathname,
    env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  })
  const result = stdout.split("\n").find(line => line.startsWith("WEBBY_E2E_RESULT="))
  if (!result) throw new Error(`persistence probe produced no result: ${stderr}`)
  return result.slice("WEBBY_E2E_RESULT=".length)
}

export async function queryCount(world, source, since = 0) {
  const events = await world.telemetry(world.telemetryCapability)
  return events.slice(since).filter(event => event.source === source).length
}

export async function telemetryOffset(world) {
  return (await world.telemetry(world.telemetryCapability)).length
}

export async function strictCleanup(world, {browsers = []} = {}) {
  const failures = []
  for (const browser of browsers) {
    try { await browser.resync([]) } catch (error) { failures.push(error) }
    try { await browser.close() } catch (error) { failures.push(error) }
  }
  try {
    const active = await sqlite(world.databasePath, "SELECT count(*) AS count FROM document_sessions WHERE status='active'")
    if (active[0].count !== 0) failures.push(new Error(`${active[0].count} stale active sessions remained`))
  } catch (error) { failures.push(error) }
  const pid = world.pid; const pgid = world.identity?.pgid; const baseUrl = world.baseUrl
  try { await world.teardown({remove: false}) } catch (error) { failures.push(error) }
  if (pid && await processExists(pid)) failures.push(new Error("world process survived teardown"))
  if (pgid && (await processGroupMembers(pgid)).length) failures.push(new Error("world process group survived teardown"))
  try {
    await fetch(`${baseUrl}/health`, {signal: AbortSignal.timeout(250)})
    failures.push(new Error("world listener survived teardown"))
  } catch (error) {
    if (!(error instanceof TypeError) && error.name !== "AbortError" && error.name !== "TimeoutError") failures.push(error)
  }
  try { await executeSql(world.databasePath, "PRAGMA wal_checkpoint(TRUNCATE);") } catch (error) { failures.push(error) }
  for (const suffix of ["-wal", "-shm"]) {
    const path = `${world.databasePath}${suffix}`
    try { await unlink(path) } catch (error) { if (error.code !== "ENOENT") failures.push(error) }
    try { await access(path); failures.push(new Error(`${suffix} remained after cleanup`)) } catch (error) { if (error.code !== "ENOENT") failures.push(error) }
  }
  try { await world.teardown({remove: true}) } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, "strict persistence cleanup failed")
}
