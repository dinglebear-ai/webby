import {spawn} from "node:child_process"

const nonce = process.argv[2]
if (!nonce) throw new Error("world process nonce is required")

const child = spawn("mix", ["run", "--no-start", "e2e/support/world-bootstrap.exs", "--", nonce], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
})

child.once("error", error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
