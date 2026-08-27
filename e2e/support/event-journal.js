import {open, writeFile} from "node:fs/promises"

export class ArtifactOverflowError extends Error {
  constructor(message, details) { super(message); this.name = "ArtifactOverflowError"; this.code = "artifact_overflow"; this.details = details }
}

export class EventJournal {
  constructor({path, scenarioId, worldId, maxEvents = 50_000, maxBytes = 16 * 1024 * 1024, maxQueuedBytes = 512 * 1024, truncationPath} = {}) {
    if (!path || !scenarioId || !worldId) throw new Error("journal path, scenario ID, and world ID are required")
    this.path = path
    this.truncationPath = truncationPath ?? `${path}.truncation.json`
    this.scenarioId = scenarioId
    this.worldId = worldId
    this.maxEvents = maxEvents
    this.maxBytes = maxBytes
    this.maxQueuedBytes = maxQueuedBytes
    this.events = 0
    this.bytes = 0
    this.queuedBytes = 0
    this.sequence = 0
    this.secretDepth = 0
    this.closed = false
    this.overflow = undefined
    this.overflowPromise = undefined
    this.pending = Promise.resolve()
  }

  async open() {
    this.handle = await open(this.path, "wx", 0o600)
    await this.record("harness", "journal.opened", {journal_version: 1})
    return this
  }

  producer(producer) {
    if (!/^[a-z][a-z0-9_-]*$/.test(producer)) throw new Error("invalid producer name")
    return {
      record: (type, data) => this.record(producer, type, data),
      capture: (kind, operation) => this.capture(kind, operation, producer),
      secretZone: (label, operation) => this.withSecretZone(`${producer}:${label}`, operation),
    }
  }

  async record(producer, type, data = {}) {
    if (this.closed) throw new Error("journal is closed")
    if (this.overflowPromise) throw await this.overflowPromise
    const event = {
      journal_version: 1,
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      scenario_id: this.scenarioId,
      world_id: this.worldId,
      producer,
      type,
      data,
    }
    const bytes = Buffer.from(JSON.stringify(event) + "\n")
    const reason = this.events + 1 > this.maxEvents ? "event_limit" : this.bytes + bytes.length > this.maxBytes ? "byte_limit" : this.queuedBytes + bytes.length > this.maxQueuedBytes ? "backpressure_limit" : undefined
    if (reason) throw await this.latchOverflow(reason, bytes.length)
    this.events += 1
    this.bytes += bytes.length
    this.queuedBytes += bytes.length
    const write = this.pending.then(() => this.handle.write(bytes)).finally(() => { this.queuedBytes -= bytes.length })
    this.pending = write.catch(() => {})
    await write
    return event
  }

  latchOverflow(reason, rejectedBytes) {
    this.overflowPromise ??= (async () => {
      await this.pending
      const details = {schema_version: 1, code: "artifact_overflow", reason, retained_events: this.events, retained_bytes: this.bytes, rejected_bytes: rejectedBytes, first_failure_preserved: true}
      this.overflow = new ArtifactOverflowError(`artifact journal overflow: ${reason}`, details)
      try { await writeFile(this.truncationPath, JSON.stringify(details, null, 2) + "\n", {flag: "wx", mode: 0o600}) }
      catch (error) { details.truncation_error = error.code ?? "write_failed" }
      return this.overflow
    })()
    return this.overflowPromise
  }

  async withSecretZone(label, operation) {
    if (typeof operation !== "function") throw new Error("secret-zone operation is required")
    this.secretDepth += 1
    try {
      await this.record("harness", "secret_zone.entered", {label, capture_suspended: true})
      return await operation()
    }
    finally {
      await this.record("harness", "secret_zone.exited", {label, capture_suspended: true}).catch(() => {})
      this.secretDepth -= 1
    }
  }

  async capture(kind, operation, producer = "harness") {
    const forbidden = new Set(["trace", "screenshot", "video", "dom", "clipboard", "attachment", "extension-storage"])
    if (this.secretDepth > 0 && forbidden.has(kind)) {
      await this.record(producer, "capture.prohibited", {kind, reason: "secret_zone"})
      const error = new Error(`capture prohibited in secret zone: ${kind}`)
      error.code = "secret_zone_capture_prohibited"
      throw error
    }
    const result = await operation()
    await this.record(producer, "capture.completed", {kind})
    return result
  }

  async close() {
    if (this.closed) return
    if (this.overflowPromise) await this.overflowPromise
    if (!this.overflow) await this.record("harness", "journal.closed", {events: this.events + 1})
    await this.pending
    await this.handle?.sync()
    await this.handle?.close()
    this.closed = true
  }
}
