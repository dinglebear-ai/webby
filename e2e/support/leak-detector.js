import {lstat, readdir} from "node:fs/promises"
import {createConnection} from "node:net"
import {openFileHandles} from "./temp-workspace.js"
import {processExists} from "./process-tree.js"

async function portOpen(port) {
  return new Promise(resolve => {
    const socket = createConnection({host: "127.0.0.1", port})
    socket.once("connect", () => { socket.destroy(); resolve(true) })
    socket.once("error", () => resolve(false)); socket.setTimeout(250, () => { socket.destroy(); resolve(false) })
  })
}

async function exists(path) { try { await lstat(path); return true } catch (error) { if (error.code === "ENOENT") return false; throw error } }

export async function detectLeaks({pids = [], ports = [], roots = [], workspaces = [], profiles = [], databases = [], pendingCalls = [], staleSessions = []} = {}) {
  const processes = []; for (const pid of pids) if (await processExists(pid)) processes.push(pid)
  const listeners = []; for (const port of ports) if (await portOpen(port)) listeners.push(port)
  const handles = []; for (const root of roots) if (await exists(root)) handles.push(...await openFileHandles(root))
  const presentProfiles = []; for (const path of profiles) if (await exists(path)) presentProfiles.push(path)
  const presentDatabases = []; for (const path of databases) if (await exists(path)) presentDatabases.push(path)
  const presentWorkspaces = []; for (const path of workspaces) if (await exists(path)) presentWorkspaces.push(path)
  return {processes, listeners, handles, workspaces: presentWorkspaces, profiles: presentProfiles, databases: presentDatabases, pending_calls: [...pendingCalls], stale_sessions: [...staleSessions]}
}

export function assertNoLeaks(report) {
  const failures = Object.entries(report).filter(([, values]) => values.length > 0)
  if (failures.length) throw new Error(`resource leaks: ${failures.map(([name, values]) => `${name}=${values.length}`).join(", ")}`)
  return report
}

export async function isolatedRoots(parent) {
  const names = await readdir(parent).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))
  return names.filter(name => name.startsWith("webby-stress-worker-"))
}
