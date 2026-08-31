import {randomUUID} from "node:crypto"
import {chmod, link, lstat, mkdir, mkdtemp, open, realpath, rm, stat, unlink} from "node:fs/promises"
import {tmpdir} from "node:os"
import {dirname, join, relative, resolve, sep} from "node:path"
import {execFile} from "node:child_process"
import {promisify} from "node:util"

const execFileAsync = promisify(execFile)

export async function createTempWorkspace(prefix = "webby-e2e-") {
  const created = await mkdtemp(join(tmpdir(), prefix))
  const root = await realpath(created)
  await chmod(root, 0o700)
  const directories = Object.fromEntries(
    await Promise.all(["data", "artifacts", "config", "profile"].map(async name => {
      const path = join(root, name)
      await mkdir(path, {mode: 0o700})
      return [name, path]
    })),
  )
  return {root, ...directories}
}

export function assertInside(root, path) {
  const rel = relative(resolve(root), resolve(path))
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error(`unsafe path outside world root: ${path}`)
  }
}

export async function assertOwnedRegular(path, {mode, uid = process.getuid?.()} = {}) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`not an owned regular file: ${path}`)
  if (uid !== undefined && info.uid !== uid) throw new Error(`wrong owner: ${path}`)
  if (mode !== undefined && (info.mode & 0o777) !== mode) throw new Error(`wrong mode: ${path}`)
  return info
}

export async function atomicPrivateWrite(path, bytes) {
  const parent = dirname(path)
  const parentInfo = await lstat(parent)
  const uid = process.getuid?.()
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error(`unsafe parent directory: ${parent}`)
  if (uid !== undefined && parentInfo.uid !== uid) throw new Error(`wrong parent owner: ${parent}`)
  if ((parentInfo.mode & 0o777) !== 0o700) throw new Error(`wrong parent mode: ${parent}`)
  if (await realpath(parent) !== resolve(parent)) throw new Error(`non-canonical parent directory: ${parent}`)
  const temporary = join(parent, `.${randomUUID()}.tmp`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    const currentParent = await lstat(parent)
    if (currentParent.dev !== parentInfo.dev || currentParent.ino !== parentInfo.ino || currentParent.isSymbolicLink()) {
      throw new Error(`parent directory was substituted: ${parent}`)
    }
    await link(temporary, path)
    await unlink(temporary)
    await assertOwnedRegular(path, {mode: 0o600, uid})
    const afterParent = await lstat(parent)
    if (afterParent.dev !== parentInfo.dev || afterParent.ino !== parentInfo.ino) throw new Error(`parent directory changed during publish: ${parent}`)
    const directory = await open(parent, "r")
    try { await directory.sync() } finally { await directory.close() }
  } catch (error) {
    await unlink(temporary).catch(() => {})
    if (error.code === "EEXIST") throw new Error(`refusing to replace existing path: ${path}`)
    throw error
  }
}

export async function removeOwnedWorkspace(root) {
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("world root was substituted")
  if (process.getuid && info.uid !== process.getuid()) throw new Error("world root owner changed")
  const canonical = await realpath(root)
  if (canonical !== resolve(root)) throw new Error("world root canonical path changed")
  if ((info.mode & 0o777) !== 0o700) throw new Error("world root permissions changed")
  const handles = await openFileHandles(root)
  if (handles.length > 0) {
    throw new Error(`world root has open file handles: ${handles.map(handle => `${handle.pid}:${handle.path}`).join(", ")}`)
  }
  await rm(root, {recursive: true})
}

export async function openFileHandles(root) {
  let stdout
  try {
    ({stdout} = await execFileAsync("lsof", ["-nP", "+D", root, "-Fpn"]))
  } catch (error) {
    // Some lsof builds return 1 for +D even when they emitted matching file
    // records. Treat the output as authoritative; only an empty result is none.
    if (error.code !== 1 || typeof error.stdout !== "string") throw error
    stdout = error.stdout
  }
  let pid
  const handles = []
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    if (line.startsWith("n") && pid) handles.push({pid, path: line.slice(1)})
  }
  return handles
}

export async function diskBytes(root, {symlinkRoots = []} = {}) {
  let total = 0
  const {readdir} = await import("node:fs/promises")
  const allowed = symlinkRoots.map(path => resolve(path))
  const symlinkAllowed = path => allowed.some(root => path === root || path.startsWith(`${root}${sep}`))
  async function walk(path) {
    for (const entry of await readdir(path, {withFileTypes: true})) {
      const child = join(path, entry.name)
      if (entry.isSymbolicLink()) {
        if (!symlinkAllowed(resolve(child))) throw new Error(`symlink in world: ${child}`)
        total += (await lstat(child)).size
        continue
      }
      if (entry.isDirectory()) await walk(child)
      else total += (await stat(child)).size
    }
  }
  await walk(root)
  return total
}
