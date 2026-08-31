import {createHash} from "node:crypto"
import {execFile} from "node:child_process"
import {createReadStream, createWriteStream} from "node:fs"
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, statfs, unlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {basename, dirname, extname, join, relative, resolve, sep} from "node:path"
import {Transform} from "node:stream"
import {pipeline} from "node:stream/promises"
import {promisify} from "node:util"
import {createInflateRaw} from "node:zlib"

const execFileAsync = promisify(execFile)
const textExtensions = new Set([".txt", ".log", ".json", ".jsonl", ".ndjson", ".html", ".htm", ".xml", ".css", ".js", ".map", ".md", ".sql", ".har", ".yaml", ".yml", ".trace", ".network", ".stacks"])
const sensitiveKeys = /^(authorization|cookie|set-cookie|token|access_token|refresh_token|secret|password|private_key|private_jwk|signature|credential)$/i
const genericPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi,
  /\b(?:access_token|refresh_token|secret|password|private_key|signature)=([^&\s]+)/gi,
  /-----BEGIN (?:PRIVATE KEY|ED25519 PRIVATE KEY)-----[\s\S]*?-----END (?:PRIVATE KEY|ED25519 PRIVATE KEY)-----/g,
]

export class RedactionError extends Error {
  constructor(code, message) { super(message); this.name = "RedactionError"; this.code = code }
}

export class SecretRegistry {
  constructor(values = []) { this.values = new Set(); for (const value of values) this.add(value) }
  add(value) {
    if (typeof value !== "string" || value.length < 4) throw new RedactionError("invalid_secret", "registered secrets must be strings of at least four characters")
    this.values.add(value)
  }
  variants() {
    const variants = new Set()
    for (const value of this.values) {
      variants.add(value)
      variants.add(encodeURIComponent(value))
      variants.add(Buffer.from(value).toString("base64"))
      variants.add(Buffer.from(value).toString("base64url"))
      variants.add(value.split("").join("\n"))
      variants.add(value.split("").join("\r\n"))
    }
    return [...variants].sort((a, b) => b.length - a.length)
  }
}

function replaceAll(text, needle) { return needle ? text.split(needle).join("[REDACTED]") : text }

export function redactText(input, registry = new SecretRegistry()) {
  let text = String(input)
  for (const variant of registry.variants()) text = replaceAll(text, variant)
  for (const pattern of genericPatterns) text = text.replace(pattern, match => `${match.split(/[:=\s]/, 1)[0]} [REDACTED]`)
  return text
}

export function redactStructured(value, registry = new SecretRegistry(), seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value, registry)
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) throw new RedactionError("cyclic_structure", "cannot sanitize cyclic structured content")
  seen.add(value)
  const redacted = Array.isArray(value)
    ? value.map(item => redactStructured(item, registry, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKeys.test(key) ? "[REDACTED]" : redactStructured(item, registry, seen)]))
  seen.delete(value)
  return redacted
}

export function assertNoSecrets(bytes, registry, label = "artifact") {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))
  const raw = buffer.toString("latin1")
  const utf8 = buffer.toString("utf8")
  for (const variant of registry.variants()) {
    if (raw.includes(variant) || utf8.includes(variant)) throw new RedactionError("secret_survived", `${label} contains a registered secret variant`)
  }
  if (genericPatterns.some(pattern => { pattern.lastIndex = 0; return pattern.test(utf8) })) throw new RedactionError("secret_pattern_survived", `${label} contains a credential pattern`)
}

function safeArchiveEntry(name) {
  const normalized = name.replaceAll("\\", "/")
  return normalized && !normalized.startsWith("/") && !normalized.split("/").includes("..") && !normalized.includes("\0")
}

const crcTable = Array.from({length: 256}, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})

function unixType(mode) { return mode & 0o170000 }
function parseExtraMode(extra) {
  let offset = 0
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset); const length = extra.readUInt16LE(offset + 2); offset += 4
    if (offset + length > extra.length) throw new RedactionError("invalid_zip", "truncated ZIP extra field")
    if (id === 0x756e && length >= 6) return extra.readUInt16LE(offset + 4)
    offset += length
  }
}

function parseZip(bytes, options) {
  const minimum = Math.max(0, bytes.length - 65_557)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= minimum; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { eocd = offset; break }
  }
  if (eocd < 0) throw new RedactionError("invalid_zip", "ZIP end-of-central-directory record is missing")
  const disk = bytes.readUInt16LE(eocd + 4); const centralDisk = bytes.readUInt16LE(eocd + 6)
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8); const entryCount = bytes.readUInt16LE(eocd + 10)
  const centralSize = bytes.readUInt32LE(eocd + 12); const centralOffset = bytes.readUInt32LE(eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) throw new RedactionError("unsupported_zip", "multi-disk and ZIP64 archives are not supported")
  if (entryCount > options.maxArchiveEntries || centralOffset + centralSize > eocd) throw new RedactionError("archive_entry_limit", "archive central directory exceeds limits")
  let offset = centralOffset; let expanded = 0
  const names = new Set(); const localOffsets = new Set(); const entries = []
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new RedactionError("invalid_zip", "invalid ZIP central-directory entry")
    const madeBy = bytes.readUInt16LE(offset + 4); const flags = bytes.readUInt16LE(offset + 8); const method = bytes.readUInt16LE(offset + 10)
    const crc = bytes.readUInt32LE(offset + 16); const compressed = bytes.readUInt32LE(offset + 20); const uncompressed = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28); const extraLength = bytes.readUInt16LE(offset + 30); const commentLength = bytes.readUInt16LE(offset + 32)
    const external = bytes.readUInt32LE(offset + 38); const localOffset = bytes.readUInt32LE(offset + 42)
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (end > bytes.length || flags & 1 || ![0, 8].includes(method)) throw new RedactionError("unsupported_zip", "encrypted, truncated, or unsupported-compression ZIP entry")
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    if (!(flags & 0x800) && [...nameBytes].some(byte => byte > 0x7f)) throw new RedactionError("unsupported_zip", "non-UTF-8 ZIP entry names are not supported")
    const name = nameBytes.toString("utf8")
    if (!safeArchiveEntry(name) || names.has(name) || localOffsets.has(localOffset)) throw new RedactionError("unsafe_archive_entry", "ZIP contains an unsafe, duplicate, or hardlink-like entry")
    names.add(name); localOffsets.add(localOffset)
    const extra = bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength)
    const unixMode = (madeBy >>> 8) === 3 ? external >>> 16 : 0
    const mode = parseExtraMode(extra) ?? unixMode
    const directory = name.endsWith("/")
    const type = unixType(mode)
    if (directory ? ![0, 0o040000].includes(type) : ![0, 0o100000].includes(type)) throw new RedactionError("unsafe_archive_type", "ZIP symlink, hardlink, device, or special entry is forbidden")
    if (uncompressed > options.maxEntryBytes) throw new RedactionError("archive_entry_size_limit", "ZIP entry exceeds expanded-size limit")
    expanded += uncompressed
    if (expanded > options.maxArchiveBytes) throw new RedactionError("archive_size_limit", "ZIP total expanded size exceeds limit")
    const ratio = uncompressed === 0 ? 1 : compressed === 0 ? Infinity : uncompressed / compressed
    if (ratio > options.maxCompressionRatio) throw new RedactionError("archive_compression_ratio", "ZIP compression ratio exceeds limit")
    entries.push({name, nameBytes, directory, flags, method, crc, compressed, uncompressed, localOffset})
    offset = end
  }
  if (offset !== centralOffset + centralSize) throw new RedactionError("invalid_zip", "ZIP central-directory size mismatch")
  const ranges = []
  for (const entry of entries) {
    const local = entry.localOffset
    if (local + 30 > centralOffset || bytes.readUInt32LE(local) !== 0x04034b50) throw new RedactionError("invalid_zip", "invalid ZIP local header")
    const flags = bytes.readUInt16LE(local + 6); const method = bytes.readUInt16LE(local + 8)
    const nameLength = bytes.readUInt16LE(local + 26); const extraLength = bytes.readUInt16LE(local + 28)
    const name = bytes.subarray(local + 30, local + 30 + nameLength)
    const dataOffset = local + 30 + nameLength + extraLength
    const dataEnd = dataOffset + entry.compressed
    if (flags !== entry.flags || method !== entry.method || !name.equals(entry.nameBytes) || dataOffset > centralOffset || dataEnd > centralOffset) throw new RedactionError("invalid_zip", "ZIP local header disagrees with central directory")
    entry.dataOffset = dataOffset
    ranges.push({start: local, end: dataEnd})
  }
  ranges.sort((a, b) => a.start - b.start)
  if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end)) throw new RedactionError("unsafe_archive_entry", "ZIP local records overlap or alias data")
  return entries
}

async function extractZipEntry(archivePath, archiveBytes, entry, output, options) {
  const offset = entry.localOffset
  if (offset + 30 > archiveBytes.length || archiveBytes.readUInt32LE(offset) !== 0x04034b50) throw new RedactionError("invalid_zip", "invalid ZIP local header")
  const dataOffset = entry.dataOffset
  await mkdir(dirname(output), {recursive: true, mode: 0o700})
  const parent = await realpath(dirname(output))
  const extractionRoot = await realpath(options.extractionRoot)
  if (parent !== extractionRoot && !parent.startsWith(extractionRoot + sep)) throw new RedactionError("unsafe_archive_entry", "ZIP output escaped extraction root")
  if (entry.compressed === 0) {
    if (entry.uncompressed !== 0 || entry.crc !== 0) throw new RedactionError("invalid_zip", "empty ZIP entry metadata is inconsistent")
    await writeFile(output, Buffer.alloc(0), {flag: "wx", mode: 0o600})
    return
  }
  let expanded = 0; let crc = 0xffffffff
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      expanded += chunk.length
      if (expanded > entry.uncompressed || expanded > options.maxEntryBytes || options.extractedBytes + expanded > options.maxArchiveBytes) return callback(new RedactionError("archive_size_limit", "ZIP expanded beyond declared or configured limits"))
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
      statfs(options.extractionRoot).then(filesystem => {
        const free = Number(filesystem.bavail) * Number(filesystem.bsize)
        callback(free - chunk.length < options.reserveBytes ? new RedactionError("free_space", "insufficient free space during ZIP extraction") : null, chunk)
      }, callback)
    },
  })
  const source = createReadStream(archivePath, {start: dataOffset, end: dataOffset + entry.compressed - 1})
  const streams = entry.method === 8 ? [source, createInflateRaw(), meter, createWriteStream(output, {flags: "wx", mode: 0o600})] : [source, meter, createWriteStream(output, {flags: "wx", mode: 0o600})]
  try { await pipeline(streams) }
  catch (error) { await unlink(output).catch(() => {}); throw error }
  if (expanded !== entry.uncompressed || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) { await unlink(output).catch(() => {}); throw new RedactionError("invalid_zip", "ZIP entry size or CRC mismatch") }
  const info = await lstat(output)
  if (!info.isFile() || info.isSymbolicLink() || !(await realpath(output)).startsWith(extractionRoot + sep)) { await unlink(output).catch(() => {}); throw new RedactionError("unsafe_archive_entry", "extracted ZIP entry is not an owned regular file") }
  options.extractedBytes += expanded
}

async function sanitizeZip(input, output, options) {
  const workspace = await mkdtemp(join(tmpdir(), "webby-redact-zip-"))
  const sanitized = join(workspace, "output")
  try {
    await mkdir(sanitized, {mode: 0o700})
    const archiveBytes = await readFile(input)
    const entries = parseZip(archiveBytes, options)
    const extraction = {...options, extractionRoot: workspace, extractedBytes: 0}
    for (const entry of entries.filter(entry => !entry.directory)) {
      const source = resolve(workspace, "entry", entry.name)
      await extractZipEntry(input, archiveBytes, entry, source, extraction)
      const destination = resolve(sanitized, entry.name)
      await execFileAsync("mkdir", ["-p", dirname(destination)])
      await sanitizeFile(source, destination, {...options, depth: options.depth + 1})
    }
    await execFileAsync("zip", ["-q", "-r", output, "."], {cwd: sanitized, maxBuffer: options.maxArchiveBytes})
  } finally { await rm(workspace, {recursive: true, force: true}) }
}

function sanitizePng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!bytes.subarray(0, 8).equals(signature)) throw new RedactionError("invalid_png", "invalid PNG signature")
  const chunks = [signature]
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) throw new RedactionError("invalid_png", "truncated PNG chunk")
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii")
    if (["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) chunks.push(bytes.subarray(offset, end))
    offset = end
    if (type === "IEND") break
  }
  if (offset !== bytes.length) throw new RedactionError("invalid_png", "PNG contains trailing or malformed data")
  return Buffer.concat(chunks)
}

export async function sanitizeFile(input, output, options = {}) {
  const settings = {
    registry: options.registry ?? new SecretRegistry(),
    maxFileBytes: options.maxFileBytes ?? 8 * 1024 * 1024,
    maxArchiveBytes: options.maxArchiveBytes ?? 32 * 1024 * 1024,
    maxArchiveEntries: options.maxArchiveEntries ?? 1_000,
    maxEntryBytes: options.maxEntryBytes ?? 8 * 1024 * 1024,
    maxCompressionRatio: options.maxCompressionRatio ?? 100,
    reserveBytes: options.reserveBytes ?? 0,
    maxDepth: options.maxDepth ?? 4,
    depth: options.depth ?? 0,
  }
  if (settings.depth > settings.maxDepth) throw new RedactionError("archive_depth_limit", "nested archive depth exceeded")
  const info = await stat(input)
  if (!info.isFile() || info.size > settings.maxFileBytes) throw new RedactionError("file_size_limit", "artifact is not a bounded regular file")
  const extension = extname(input).toLowerCase()
  if (extension === ".zip") return sanitizeZip(input, output, settings)
  const bytes = await readFile(input)
  let sanitized
  if (extension === ".png") sanitized = sanitizePng(bytes)
  else if (textExtensions.has(extension)) {
    const text = bytes.toString("utf8")
    if (Buffer.from(text).compare(bytes) !== 0) throw new RedactionError("invalid_text", "text artifact is not valid UTF-8")
    if ([".json", ".har"].includes(extension)) sanitized = Buffer.from(JSON.stringify(redactStructured(JSON.parse(text), settings.registry), null, 2) + "\n")
    else if ([".jsonl", ".ndjson"].includes(extension)) sanitized = Buffer.from(text.split("\n").filter(Boolean).map(line => JSON.stringify(redactStructured(JSON.parse(line), settings.registry))).join("\n") + "\n")
    else sanitized = Buffer.from(redactText(text, settings.registry))
  } else throw new RedactionError("unsupported_format", `unsupported artifact format: ${extension || basename(input)}`)
  assertNoSecrets(sanitized, settings.registry, input)
  await writeFile(output, sanitized, {flag: "wx", mode: 0o600})
}

export async function validateSanitizedFile(input, options = {}) {
  const settings = {
    registry: options.registry ?? new SecretRegistry(),
    maxFileBytes: options.maxFileBytes ?? 8 * 1024 * 1024,
    maxArchiveBytes: options.maxArchiveBytes ?? 32 * 1024 * 1024,
    maxArchiveEntries: options.maxArchiveEntries ?? 1_000,
    maxEntryBytes: options.maxEntryBytes ?? 8 * 1024 * 1024,
    maxCompressionRatio: options.maxCompressionRatio ?? 100,
    reserveBytes: options.reserveBytes ?? 0,
    maxDepth: options.maxDepth ?? 4,
    depth: options.depth ?? 0,
  }
  if (settings.depth > settings.maxDepth) throw new RedactionError("archive_depth_limit", "nested archive depth exceeded")
  const info = await stat(input)
  if (!info.isFile() || info.size > settings.maxFileBytes) throw new RedactionError("file_size_limit", "artifact is not a bounded regular file")
  const extension = extname(input).toLowerCase()
  if (extension === ".zip") {
    const workspace = await mkdtemp(join(tmpdir(), "webby-validate-zip-"))
    try {
      const archiveBytes = await readFile(input)
      const entries = parseZip(archiveBytes, settings)
      const extraction = {...settings, extractionRoot: workspace, extractedBytes: 0}
      let expanded = 0
      for (const [index, entry] of entries.filter(entry => !entry.directory).entries()) {
        const extracted = join(workspace, `${index}${extname(entry.name).toLowerCase()}`)
        await extractZipEntry(input, archiveBytes, entry, extracted, extraction)
        expanded += await validateSanitizedFile(extracted, {...settings, depth: settings.depth + 1})
        if (expanded > settings.maxArchiveBytes) throw new RedactionError("archive_size_limit", "nested ZIP expanded size exceeds limit")
      }
      return expanded
    } finally { await rm(workspace, {recursive: true, force: true}) }
  }
  const bytes = await readFile(input)
  if (extension === ".png") {
    sanitizePng(bytes)
    assertNoSecrets(bytes, settings.registry, input)
    return bytes.length
  }
  if (!textExtensions.has(extension)) throw new RedactionError("unsupported_format", `unsupported artifact format: ${extension || basename(input)}`)
  const text = bytes.toString("utf8")
  if (Buffer.from(text).compare(bytes) !== 0) throw new RedactionError("invalid_text", "text artifact is not valid UTF-8")
  if ([".json", ".har"].includes(extension)) JSON.parse(text)
  if ([".jsonl", ".ndjson"].includes(extension)) for (const line of text.split("\n").filter(Boolean)) JSON.parse(line)
  assertNoSecrets(bytes, settings.registry, input)
  return bytes.length
}

export async function sanitizeSqliteDump(databasePath, output, {tables, registry = new SecretRegistry(), maxBuffer = 8 * 1024 * 1024} = {}) {
  if (!tables || Object.keys(tables).length === 0) throw new RedactionError("missing_database_allowlist", "database diagnostics require an explicit table/column allowlist")
  const result = {}
  for (const [table, columns] of Object.entries(tables)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table) || !columns.every(column => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column))) throw new RedactionError("invalid_database_allowlist", "invalid database identifier")
    const {stdout} = await execFileAsync("sqlite3", ["-json", databasePath, `SELECT ${columns.map(column => `\"${column}\"`).join(",")} FROM \"${table}\";`], {maxBuffer})
    result[table] = redactStructured(stdout.trim() ? JSON.parse(stdout) : [], registry)
  }
  const bytes = Buffer.from(JSON.stringify({schema_version: 1, tables: result}, null, 2) + "\n")
  assertNoSecrets(bytes, registry, "sanitized database dump")
  await writeFile(output, bytes, {flag: "wx", mode: 0o600})
}

export async function hashFile(path) { return createHash("sha256").update(await readFile(path)).digest("hex") }

export async function walkFiles(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const child = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new RedactionError("symlink_artifact", `artifact tree contains symlink: ${child}`)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) files.push({path: child, relative: relative(root, child)})
      else throw new RedactionError("unsupported_artifact_node", `unsupported artifact node: ${child}`)
    }
  }
  await walk(root)
  return files.sort((a, b) => a.relative.localeCompare(b.relative))
}
