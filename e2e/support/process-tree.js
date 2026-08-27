import {execFile} from "node:child_process"
import {readlink} from "node:fs/promises"
import {promisify} from "node:util"

const execFileAsync = promisify(execFile)

async function ps(pid, field) {
  const {stdout} = await execFileAsync("ps", ["-o", `${field}=`, "-p", String(pid)])
  return stdout.trim()
}

export async function processIdentity(pid) {
  let cwd
  try {
    cwd = await readlink(`/proc/${pid}/cwd`)
  } catch {
    const {stdout} = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    cwd = stdout.split("\n").find(line => line.startsWith("n"))?.slice(1)
  }
  return {
    pid,
    pgid: Number(await ps(pid, "pgid")),
    started: await ps(pid, "lstart"),
    command: await ps(pid, "command"),
    executable: await ps(pid, "comm"),
    cwd,
    uid: Number(await ps(pid, "uid")),
  }
}

export async function captureProcessIdentity(pid, nonce, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const identity = await processIdentity(pid)
      if (identity.pgid === pid && identity.command.includes(nonce)) return identity
      lastError = new Error("spawned process identity did not match its dedicated group and nonce")
    } catch (error) { lastError = error }
    if (!(await processExists(pid))) throw lastError ?? new Error("spawned process exited before identity capture")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw lastError ?? new Error("timed out capturing process identity")
}

export async function verifyProcess(identity, nonce) {
  let current
  try { current = await processIdentity(identity.pid) } catch { return false }
  return current.pgid === identity.pgid &&
    current.started === identity.started &&
    current.uid === identity.uid &&
    current.executable === identity.executable &&
    current.cwd === identity.cwd &&
    current.command.includes(nonce) &&
    current.pgid === current.pid
}

export async function processExists(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === "EPERM" }
}

export async function processGroupMembers(pgid) {
  const {stdout} = await execFileAsync("ps", ["-axo", "pid=,pgid=,state=,uid=,command="])
  return stdout.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/)
    return match && {pid: Number(match[1]), pgid: Number(match[2]), state: match[3], uid: Number(match[4]), command: match[5]}
  }).filter(member => member && member.pgid === pgid && !member.state.startsWith("Z"))
}

async function listenerPids(pgid) {
  try {
    const {stdout} = await execFileAsync("lsof", ["-nP", "-a", "-g", String(pgid), "-iTCP", "-sTCP:LISTEN", "-Fp"])
    return stdout.split("\n").filter(line => line.startsWith("p")).map(line => Number(line.slice(1)))
  } catch (error) {
    if (error.code === 1) return []
    throw error
  }
}

async function waitForEmptyGroup(pgid, deadline) {
  while ((await processGroupMembers(pgid)).length > 0 || (await listenerPids(pgid)).length > 0) {
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return true
}

export async function reapProcessGroup(identity, nonce, {graceMs = 2_000} = {}) {
  const leaderVerified = await verifyProcess(identity, nonce)
  const members = await processGroupMembers(identity.pgid)
  if (!leaderVerified) {
    if (await processExists(identity.pid)) throw new Error("process identity mismatch; refusing to signal")
    if (members.length === 0) return {alreadyGone: true}
    if (members.some(member => member.uid !== identity.uid || !member.command.includes(nonce))) {
      throw new Error("orphan process group identity mismatch; refusing to signal")
    }
  }
  process.kill(-identity.pgid, "SIGTERM")
  if (!(await waitForEmptyGroup(identity.pgid, Date.now() + graceMs))) {
    const survivors = await processGroupMembers(identity.pgid)
    if (survivors.some(member => member.uid !== identity.uid)) throw new Error("process group ownership changed during reap")
    process.kill(-identity.pgid, "SIGKILL")
    if (!(await waitForEmptyGroup(identity.pgid, Date.now() + graceMs))) throw new Error("process group or listener survived SIGKILL")
  }
  return {alreadyGone: false}
}
