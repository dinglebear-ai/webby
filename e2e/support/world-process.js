import {spawn} from "node:child_process"

const nonce = process.argv[2]
if (!nonce) throw new Error("world process nonce is required")

const child = spawn("mix", ["run", "--no-start", "e2e/support/world-bootstrap.exs", "--", nonce], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
})

// SIGTERM/SIGINT are delivered to the entire detached process group. Keep the
// nonce-bearing group leader alive for a bounded handoff after Mix exits so an
// external reaper can still verify the group before signalling any survivors.
// This does not relax orphan verification: once the handoff expires, the
// existing reaper continues to reject descendants that cannot prove the nonce.
const handoffMs = Number(process.env.WEBBY_E2E_REAPER_HANDOFF_MS ?? "2000")
if (!Number.isInteger(handoffMs) || handoffMs < 100 || handoffMs > 10_000) throw new Error("invalid reaper handoff timeout")
let shutdownSignal
let forcedTimer
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (shutdownSignal) return
    shutdownSignal = signal
    if (!child.killed) child.kill(signal)
    forcedTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL") }, handoffMs)
  })
}

child.once("error", error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  clearTimeout(forcedTimer)
  const terminalSignal = shutdownSignal ?? signal
  if (terminalSignal) {
    setTimeout(() => {
      process.removeAllListeners("SIGTERM")
      process.removeAllListeners("SIGINT")
      process.kill(process.pid, terminalSignal)
    }, handoffMs)
  } else process.exit(code ?? 1)
})
