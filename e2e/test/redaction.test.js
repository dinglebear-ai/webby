import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {promisify} from "node:util"
import test from "node:test"
import {SecretRegistry, assertNoSecrets, redactStructured, redactText, sanitizeFile, sanitizeSqliteDump} from "../support/redaction.js"

const execFileAsync = promisify(execFile)
const canary = "canary-private-token-4815162342"
const registry = new SecretRegistry([canary])

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "webby-redaction-test-"))
  t.after(() => rm(root, {recursive: true, force: true}))
  return root
}

function pngWithText(secret) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const chunk = (type, data) => {
    const bytes = Buffer.from(data)
    const result = Buffer.alloc(12 + bytes.length)
    result.writeUInt32BE(bytes.length, 0); result.write(type, 4); bytes.copy(result, 8)
    return result
  }
  return Buffer.concat([signature, chunk("IHDR", Buffer.alloc(13)), chunk("tEXt", `Comment\0${secret}`), chunk("IDAT", Buffer.from([0])), chunk("IEND", Buffer.alloc(0))])
}

test("text and structured redaction removes direct, header, URL, base64, split-line, and keyed secrets", () => {
  const input = [canary, `Authorization: Bearer ${canary}`, encodeURIComponent(canary), Buffer.from(canary).toString("base64"), canary.split("").join("\n")].join("\n")
  const redacted = redactText(input, registry)
  assert.doesNotMatch(redacted, /canary-private|Y2FuYXJ5/)
  assert.doesNotThrow(() => assertNoSecrets(redacted, registry))
  const structured = redactStructured({authorization: `Bearer ${canary}`, nested: {cookie: canary}, safe: "diagnostic"}, registry)
  assert.deepEqual(structured, {authorization: "[REDACTED]", nested: {cookie: "[REDACTED]"}, safe: "diagnostic"})
})

test("sanitizes JSON, DOM, logs, SQL text, and strips PNG metadata", async t => {
  const root = await workspace(t)
  const fixtures = [
    ["input.json", JSON.stringify({token: canary, detail: `Bearer ${canary}`})],
    ["dom.html", `<main data-token="${canary}">safe diagnosis</main>`],
    ["console.log", `authorization: Bearer ${canary}\nuseful failure`],
    ["dump.sql", `INSERT INTO audit VALUES ('${canary}', 'useful');`],
  ]
  for (const [name, contents] of fixtures) {
    const input = join(root, name); const output = join(root, `safe-${name}`)
    await writeFile(input, contents)
    await sanitizeFile(input, output, {registry})
    const safe = await readFile(output)
    assert.doesNotThrow(() => assertNoSecrets(safe, registry, name))
    assert.match(safe.toString(), /REDACTED/)
  }
  const image = join(root, "capture.png"); const safeImage = join(root, "safe.png")
  await writeFile(image, pngWithText(canary))
  await sanitizeFile(image, safeImage, {registry})
  const imageBytes = await readFile(safeImage)
  assert.doesNotThrow(() => assertNoSecrets(imageBytes, registry, "PNG metadata"))
  assert.equal(imageBytes.includes(Buffer.from("tEXt")), false)
})

test("recursively sanitizes nested ZIP entries and rejects unsafe or unknown formats", async t => {
  const root = await workspace(t)
  const innerRoot = join(root, "inner"); const outerRoot = join(root, "outer")
  await mkdir(innerRoot); await mkdir(outerRoot)
  await writeFile(join(innerRoot, "trace.json"), JSON.stringify({headers: {authorization: `Bearer ${canary}`}, diagnostic: "request failed"}))
  await writeFile(join(innerRoot, "metadata.png"), pngWithText(canary))
  await execFileAsync("zip", ["-q", "-r", join(outerRoot, "nested.zip"), "."], {cwd: innerRoot})
  await writeFile(join(outerRoot, "stdout.log"), `cookie: ${canary}\nimportant line`)
  const archive = join(root, "trace.zip"); const safe = join(root, "safe.zip")
  await execFileAsync("zip", ["-q", "-r", archive, "."], {cwd: outerRoot})
  await sanitizeFile(archive, safe, {registry})
  const {stdout: listing} = await execFileAsync("unzip", ["-Z1", safe])
  assert.match(listing, /nested.zip/); assert.match(listing, /stdout.log/)
  const {stdout: log} = await execFileAsync("unzip", ["-p", safe, "stdout.log"])
  assert.match(log, /important line/); assert.doesNotThrow(() => assertNoSecrets(log, registry))
  const nested = join(root, "safe-nested.zip")
  const {stdout: nestedBytes} = await execFileAsync("unzip", ["-p", safe, "nested.zip"], {encoding: "buffer", maxBuffer: 8 * 1024 * 1024})
  await writeFile(nested, nestedBytes)
  const {stdout: trace} = await execFileAsync("unzip", ["-p", nested, "trace.json"])
  assert.doesNotThrow(() => assertNoSecrets(trace, registry))
  const unknown = join(root, "capture.bin"); await writeFile(unknown, canary)
  await assert.rejects(sanitizeFile(unknown, join(root, "safe.bin"), {registry}), error => error.code === "unsupported_format")
})

test("rejects crafted ZIP symlinks and compression bombs from central-directory metadata before extraction", async t => {
  const root = await workspace(t)
  const source = join(root, "source"); await mkdir(source)
  await writeFile(join(source, "target.log"), "safe")
  await execFileAsync("ln", ["-s", "target.log", join(source, "link.log")])
  const symlinkArchive = join(root, "symlink.zip")
  await execFileAsync("zip", ["-q", "-y", symlinkArchive, "link.log"], {cwd: source})
  await assert.rejects(sanitizeFile(symlinkArchive, join(root, "safe-symlink.zip"), {registry}), error => error.code === "unsafe_archive_type")

  await writeFile(join(source, "bomb.log"), Buffer.alloc(1024 * 1024))
  const bombArchive = join(root, "bomb.zip")
  await execFileAsync("zip", ["-q", "-9", bombArchive, "bomb.log"], {cwd: source})
  assert.ok((await readFile(bombArchive)).length < 10_000)
  await assert.rejects(sanitizeFile(bombArchive, join(root, "safe-bomb.zip"), {registry, maxCompressionRatio: 20, maxArchiveBytes: 2 * 1024 * 1024}), error => error.code === "archive_compression_ratio")

  const ordinaryArchive = join(root, "ordinary.zip")
  await execFileAsync("zip", ["-q", ordinaryArchive, "target.log"], {cwd: source})
  await assert.rejects(sanitizeFile(ordinaryArchive, join(root, "safe-space.zip"), {registry, reserveBytes: Number.MAX_SAFE_INTEGER}), error => error.code === "free_space")

  await writeFile(join(source, "second.log"), "other")
  const aliases = join(root, "aliases.zip")
  await execFileAsync("zip", ["-q", aliases, "target.log", "second.log"], {cwd: source})
  const aliasBytes = await readFile(aliases)
  const centralOffsets = []
  for (let offset = 0; offset + 46 <= aliasBytes.length; offset++) if (aliasBytes.readUInt32LE(offset) === 0x02014b50) centralOffsets.push(offset)
  assert.equal(centralOffsets.length, 2)
  aliasBytes.writeUInt32LE(aliasBytes.readUInt32LE(centralOffsets[0] + 42), centralOffsets[1] + 42)
  await writeFile(aliases, aliasBytes)
  await assert.rejects(sanitizeFile(aliases, join(root, "safe-aliases.zip"), {registry}), error => error.code === "unsafe_archive_entry")

  const deviceArchive = join(root, "device.zip")
  await execFileAsync("zip", ["-q", deviceArchive, "target.log"], {cwd: source})
  const deviceBytes = await readFile(deviceArchive)
  const central = deviceBytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  assert.ok(central >= 0)
  deviceBytes.writeUInt32LE((0o020666 << 16) >>> 0, central + 38)
  await writeFile(deviceArchive, deviceBytes)
  await assert.rejects(sanitizeFile(deviceArchive, join(root, "safe-device.zip"), {registry}), error => error.code === "unsafe_archive_type")
})

test("SQLite diagnostics export only allowlisted tables and columns", async t => {
  const root = await workspace(t)
  const database = join(root, "world.sqlite3"); const output = join(root, "database.json")
  await execFileAsync("sqlite3", [database, `CREATE TABLE audits(id INTEGER, summary TEXT, token TEXT); INSERT INTO audits VALUES(1, 'failure remained diagnosable', '${canary}'); CREATE TABLE private_state(secret TEXT); INSERT INTO private_state VALUES('${canary}');`])
  await sanitizeSqliteDump(database, output, {tables: {audits: ["id", "summary", "token"]}, registry})
  const dump = JSON.parse(await readFile(output, "utf8"))
  assert.equal(dump.tables.audits[0].summary, "failure remained diagnosable")
  assert.equal(dump.tables.audits[0].token, "[REDACTED]")
  assert.equal(dump.tables.private_state, undefined)
  await assert.rejects(sanitizeSqliteDump(database, join(root, "missing.json"), {registry}), error => error.code === "missing_database_allowlist")
})
