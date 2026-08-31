import {createHash, randomUUID} from "node:crypto"
import {copyFile, mkdir, readFile, rm, stat, statfs, unlink, writeFile} from "node:fs/promises"
import {basename, join, resolve} from "node:path"
import {EventJournal} from "./event-journal.js"
import {RedactionError, SecretRegistry, assertNoSecrets, hashFile, redactStructured, sanitizeFile, sanitizeSqliteDump, validateSanitizedFile, walkFiles} from "./redaction.js"

const essentialKinds = new Set(["journal", "failure", "cleanup", "manifest", "versions", "database"])
const allowedKinds = new Set([...essentialKinds, "protocol", "chromium", "fixture", "world", "trace", "screenshot", "video", "dom", "log", "report", "attachment"])

function safeName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.includes("..")) throw new Error("unsafe artifact name")
  return name
}

async function privateDirectory(path) { await mkdir(path, {recursive: true, mode: 0o700}) }
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex") }

export class ArtifactRecorder {
  constructor({root, scenarioId, worldId, seed = 0, versions = {}, secrets = [], limits = {}, jobBudget = {bytes: 0}} = {}) {
    if (!root || !scenarioId || !worldId) throw new Error("artifact root, scenario ID, and world ID are required")
    this.root = resolve(root)
    this.scenarioId = scenarioId
    this.worldId = worldId
    this.seed = seed
    this.versions = versions
    this.registry = new SecretRegistry(secrets)
    this.jobBudget = jobBudget
    this.limits = {
      fileBytes: limits.fileBytes ?? 8 * 1024 * 1024,
      scenarioBytes: limits.scenarioBytes ?? 64 * 1024 * 1024,
      jobBytes: limits.jobBytes ?? 256 * 1024 * 1024,
      reserveBytes: limits.reserveBytes ?? 16 * 1024 * 1024,
      events: limits.events ?? 50_000,
      journalBytes: limits.journalBytes ?? 16 * 1024 * 1024,
      queuedBytes: limits.queuedBytes ?? 512 * 1024,
    }
    this.rawRoot = join(this.root, "raw-quarantine")
    this.stagingRoot = join(this.root, "sanitized-staging")
    this.omissions = []
    this.items = []
    this.accountedBytes = 0
    this.firstFailure = undefined
    this.failedClosed = false
  }

  async open() {
    await privateDirectory(this.root)
    await privateDirectory(this.rawRoot)
    await privateDirectory(this.stagingRoot)
    this.journal = await new EventJournal({
      path: join(this.rawRoot, "events.ndjson"), scenarioId: this.scenarioId, worldId: this.worldId,
      maxEvents: this.limits.events, maxBytes: this.limits.journalBytes, maxQueuedBytes: this.limits.queuedBytes,
    }).open()
    this.producers = Object.fromEntries(["protocol", "chromium", "fixture", "world", "mcp", "dashboard"].map(name => [name, this.producer(name)]))
    return this
  }

  addSecret(value) { this.registry.add(value) }
  producer(name) {
    const journal = this.journal.producer(name)
    return {
      event: journal.record,
      capture: journal.capture,
      secretZone: journal.secretZone,
      artifact: (input, options) => this.ingest(input, {...options, producer: name}),
      diagnostic: (artifactName, data, allowedFields) => this.diagnostic(name, artifactName, data, allowedFields),
      failure: details => this.recordFailure(name, details),
    }
  }

  async recordFailure(producer, details) {
    if (!this.firstFailure) this.firstFailure = {producer, at: new Date().toISOString(), details}
    await this.journal.record(producer, "failure", {first: this.firstFailure.producer === producer && this.firstFailure.details === details, summary: details?.summary ?? String(details)})
  }

  async checkCapacity(incoming, essential) {
    if (incoming > this.limits.fileBytes) throw new RedactionError("file_quota", "artifact exceeds per-file quota")
    const used = this.accountedBytes
    if (used + incoming > this.limits.scenarioBytes) {
      if (!essential) { this.omissions.push({reason: "scenario_quota", bytes: incoming}); return false }
      throw new RedactionError("scenario_quota", "essential artifact exceeds scenario quota")
    }
    if (this.jobBudget.bytes + incoming > this.limits.jobBytes) {
      if (!essential) { this.omissions.push({reason: "job_quota", bytes: incoming}); return false }
      throw new RedactionError("job_quota", "essential artifact exceeds job quota")
    }
    const filesystem = await statfs(this.root)
    const free = Number(filesystem.bavail) * Number(filesystem.bsize)
    if (free - incoming < this.limits.reserveBytes) {
      if (!essential) { this.omissions.push({reason: "free_space", bytes: incoming}); return false }
      throw new RedactionError("free_space", "insufficient free space for essential artifact")
    }
    return true
  }

  async ingest(input, {name = basename(input), kind = "attachment", essential = essentialKinds.has(kind), producer = "harness"} = {}) {
    if (!allowedKinds.has(kind)) throw new RedactionError("unknown_artifact_kind", `unknown artifact kind: ${kind}`)
    name = safeName(name)
    const inputInfo = await stat(input)
    if (!(await this.checkCapacity(inputInfo.size, essential))) return {omitted: true}
    const id = randomUUID()
    const raw = join(this.rawRoot, `${id}-${name}`)
    const staged = join(this.stagingRoot, `${id}-${name}`)
    await copyFile(input, raw, 0)
    try {
      await sanitizeFile(raw, staged, {registry: this.registry, maxFileBytes: this.limits.fileBytes, maxEntryBytes: this.limits.fileBytes, maxArchiveBytes: this.limits.scenarioBytes, reserveBytes: this.limits.reserveBytes})
      const info = await stat(staged)
      const expandedBytes = await validateSanitizedFile(staged, {registry: this.registry, maxFileBytes: this.limits.fileBytes, maxEntryBytes: this.limits.fileBytes, maxArchiveBytes: this.limits.scenarioBytes, reserveBytes: this.limits.reserveBytes})
      if (!(await this.checkCapacity(expandedBytes, essential))) { await unlink(staged); return {omitted: true} }
      const item = {id, producer, kind, name, raw, staged, bytes: info.size, expanded_bytes: expandedBytes, sha256: await hashFile(staged), essential}
      await this.journal.record(producer, "artifact.sanitized", {id, kind, name, bytes: info.size, sha256: item.sha256})
      this.items.push(item)
      this.accountedBytes += expandedBytes
      this.jobBudget.bytes += expandedBytes
      return item
    } catch (error) {
      this.failedClosed = true
      await unlink(staged).catch(() => {})
      try { await this.journal.record(producer, "artifact.rejected", {kind, name, code: error.code ?? "sanitizer_failure"}) }
      catch (journalError) { throw new AggregateError([error, journalError], "Artifact rejection and rejection journal both failed", {cause: error}) }
      throw error
    }
  }

  async diagnostic(producer, name, data, allowedFields) {
    if (!Array.isArray(allowedFields) || allowedFields.length === 0) throw new RedactionError("missing_diagnostic_allowlist", "structured diagnostics require an explicit field allowlist")
    const unknown = Object.keys(data).filter(key => !allowedFields.includes(key))
    if (unknown.length > 0) throw new RedactionError("diagnostic_schema_violation", `diagnostic contains unknown fields: ${unknown.join(",")}`)
    const source = join(this.rawRoot, `${randomUUID()}-diagnostic-source.json`)
    await writeFile(source, JSON.stringify(data, null, 2) + "\n", {flag: "wx", mode: 0o600})
    return this.ingest(source, {producer, name: safeName(name), kind: producer === "chromium" ? "chromium" : "report", essential: false})
  }

  async database(databasePath, {name = "database.json", tables, producer = "world"} = {}) {
    name = safeName(name)
    const id = randomUUID()
    const staged = join(this.stagingRoot, `${id}-${name}`)
    try {
      await sanitizeSqliteDump(databasePath, staged, {tables, registry: this.registry, maxBuffer: this.limits.fileBytes})
      const info = await stat(staged)
      await this.checkCapacity(info.size, true)
      const item = {id, producer, kind: "database", name, staged, bytes: info.size, expanded_bytes: info.size, sha256: await hashFile(staged), essential: true}
      await this.journal.record(producer, "database.sanitized", {id, name, bytes: info.size, sha256: item.sha256})
      this.items.push(item)
      this.accountedBytes += info.size
      this.jobBudget.bytes += info.size
      return item
    } catch (error) { this.failedClosed = true; await unlink(staged).catch(() => {}); throw error }
  }

  async finalize({status = "passed", cleanup = {}} = {}) {
    await this.journal.close()
    const journalInput = join(this.rawRoot, "events.ndjson")
    const journalOutput = join(this.stagingRoot, "events.ndjson")
    try {
      await sanitizeFile(journalInput, journalOutput, {registry: this.registry, maxFileBytes: this.limits.journalBytes})
      this.items.push({id: "journal", producer: "harness", kind: "journal", name: "events.ndjson", staged: journalOutput, bytes: (await stat(journalOutput)).size, sha256: await hashFile(journalOutput), essential: true})
      const truncationInput = `${journalInput}.truncation.json`
      try {
        await stat(truncationInput)
        const truncationOutput = join(this.stagingRoot, "journal-truncation.json")
        await sanitizeFile(truncationInput, truncationOutput, {registry: this.registry})
        this.items.push({id: "journal-truncation", producer: "harness", kind: "failure", name: "journal-truncation.json", staged: truncationOutput, bytes: (await stat(truncationOutput)).size, sha256: await hashFile(truncationOutput), essential: true})
      } catch (error) { if (error.code !== "ENOENT") throw error }
      const replay = {
        schema_version: 1, scenario_id: this.scenarioId, world_id: this.worldId, seed: this.seed,
        status, versions: this.versions, first_failure: redactStructured(this.firstFailure, this.registry), cleanup: redactStructured(cleanup, this.registry),
        omissions: this.omissions, items: this.items.map(({raw: _raw, staged: _staged, ...item}) => item),
      }
      const replayPath = join(this.stagingRoot, "replay-manifest.json")
      const cleanupPath = join(this.stagingRoot, "cleanup-report.json")
      await writeFile(replayPath, JSON.stringify(replay, null, 2) + "\n", {flag: "wx", mode: 0o600})
      await writeFile(cleanupPath, JSON.stringify({schema_version: 1, scenario_id: this.scenarioId, world_id: this.worldId, ...cleanup}, null, 2) + "\n", {flag: "wx", mode: 0o600})
      for (const path of [replayPath, cleanupPath]) assertNoSecrets(await readFile(path), this.registry, path)
      const files = await walkFiles(this.stagingRoot)
      const attested = []
      let stagingExpandedBytes = 0
      for (const file of files) {
        const expandedBytes = await validateSanitizedFile(file.path, {registry: this.registry, maxFileBytes: this.limits.fileBytes, maxEntryBytes: this.limits.fileBytes, maxArchiveBytes: this.limits.scenarioBytes, reserveBytes: this.limits.reserveBytes})
        stagingExpandedBytes += expandedBytes
        if (stagingExpandedBytes > this.limits.scenarioBytes) throw new RedactionError("scenario_quota", "sanitized staging exceeds expanded scenario quota")
        assertNoSecrets(await readFile(file.path), this.registry, file.relative)
        attested.push({path: file.relative, bytes: (await stat(file.path)).size, expanded_bytes: expandedBytes, sha256: await hashFile(file.path)})
      }
      const finalAdditionalBytes = stagingExpandedBytes - this.accountedBytes
      if (this.jobBudget.bytes + finalAdditionalBytes > this.limits.jobBytes) throw new RedactionError("job_quota", "sanitized staging exceeds expanded job quota")
      const filesystem = await statfs(this.stagingRoot)
      if (Number(filesystem.bavail) * Number(filesystem.bsize) < this.limits.reserveBytes) throw new RedactionError("free_space", "sanitized staging violated free-space reserve")
      const statement = {schema_version: 1, scenario_id: this.scenarioId, world_id: this.worldId, files: attested}
      const statementBytes = Buffer.from(JSON.stringify(statement))
      const attestation = {...statement, attestation_sha256: digest(statementBytes)}
      const attestationPath = join(this.root, "upload-attestation.json")
      await writeFile(attestationPath, JSON.stringify(attestation, null, 2) + "\n", {flag: "wx", mode: 0o600})
      this.attestation = attestation
      this.attestationPath = attestationPath
      const uploadCandidates = await this.uploadCandidates()
      if (uploadCandidates.length !== files.length) throw new RedactionError("attestation_failed", "sanitized staging did not verify against its attestation")
      this.jobBudget.bytes += finalAdditionalBytes
      this.accountedBytes = stagingExpandedBytes
      if (status === "passed") await rm(this.rawRoot, {recursive: true, force: true})
      return {replay, attestation, retention: {raw_quarantine: status === "passed" ? "deleted" : "retained-private", sanitized_staging: "retained"}, uploadCandidates}
    } catch (error) {
      this.failedClosed = true
      this.attestation = undefined
      if (this.attestationPath) {
        try { await unlink(this.attestationPath) }
        catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") throw new AggregateError([error, cleanupError], "Attestation failed and partial attestation cleanup failed", {cause: error})
        }
      }
      throw error
    }
  }

  async uploadCandidates() {
    if (this.failedClosed || !this.attestation) return []
    let attestation
    try { attestation = JSON.parse(await readFile(this.attestationPath, "utf8")) }
    catch { return [] }
    if (JSON.stringify(attestation) !== JSON.stringify(this.attestation)) return []
    const files = await walkFiles(this.stagingRoot)
    const current = await Promise.all(files.map(async file => ({path: file.relative, bytes: (await stat(file.path)).size, expanded_bytes: await validateSanitizedFile(file.path, {registry: this.registry, maxFileBytes: this.limits.fileBytes, maxEntryBytes: this.limits.fileBytes, maxArchiveBytes: this.limits.scenarioBytes, reserveBytes: this.limits.reserveBytes}), sha256: await hashFile(file.path)})))
    if (JSON.stringify(current) !== JSON.stringify(attestation.files)) return []
    const unsigned = {schema_version: attestation.schema_version, scenario_id: attestation.scenario_id, world_id: attestation.world_id, files: attestation.files}
    if (digest(Buffer.from(JSON.stringify(unsigned))) !== attestation.attestation_sha256) return []
    return files.map(file => file.path)
  }
}
