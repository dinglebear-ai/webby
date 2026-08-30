import {spawn} from "node:child_process"
import {mkdtemp, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {ArtifactRecorder} from "./artifacts.js"
import {captureProcessIdentity, processExists, reapProcessGroup} from "./process-tree.js"

const fixture = new URL("./process-tree-fixture.js", import.meta.url).pathname
const exited = child => new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({code, signal})) })

export async function injectTermination(signal) {
  const nonce = `fault-${signal}-${Date.now()}`
  const child = spawn(process.execPath, [fixture, "listener", nonce], {detached: true, stdio: ["ignore", "pipe", "ignore"]})
  await new Promise(resolve => child.stdout.once("data", resolve))
  const identity = await captureProcessIdentity(child.pid, nonce)
  process.kill(-identity.pgid, signal)
  const outcome = await Promise.race([exited(child), new Promise((_, reject) => setTimeout(() => reject(new Error(`${signal} was not bounded`)), 2_000))])
  if (await processExists(child.pid)) await reapProcessGroup(identity, nonce, {graceMs: 250})
  return outcome
}

export async function injectHungClose() {
  const controller = new AbortController(); const close = new Promise(resolve => controller.signal.addEventListener("abort", () => resolve("forced"), {once: true}))
  const timer = setTimeout(() => controller.abort(), 25)
  try { return await Promise.race([close, new Promise((_, reject) => setTimeout(() => reject(new Error("hung close was not bounded")), 250))]) } finally { clearTimeout(timer) }
}

export async function injectRecorderPressure(kind) {
  const root = await mkdtemp(join(tmpdir(), `webby-stress-${kind}-`)); const input = join(root, "payload.log"); await writeFile(input, "x".repeat(256))
  const limits = kind === "disk-pressure" ? {reserveBytes: Number.MAX_SAFE_INTEGER} : {fileBytes: 32}
  const recorder = await new ArtifactRecorder({root: join(root, "recorder"), scenarioId: kind, worldId: "fault", limits}).open()
  try { await recorder.ingest(input, {kind: "log", essential: true}); throw new Error(`${kind} injection did not fail closed`) }
  catch (error) { if (error.message.includes("did not fail closed")) throw error; await recorder.journal.close(); return error.code }
}
