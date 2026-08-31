import {spawn} from "node:child_process"
import {createServer} from "node:net"

const [mode, nonce] = process.argv.slice(2)
if (mode === "listener") {
  const server = createServer()
  server.listen({host: "127.0.0.1", port: 0}, () => process.stdout.write(`${server.address().port}\n`))
} else if (mode === "leader") {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "listener", nonce], {stdio: ["ignore", "pipe", "inherit"]})
  child.stdout.once("data", chunk => {
    process.stdout.write(chunk)
    process.stdin.once("data", () => process.exit(0))
  })
} else {
  throw new Error("unknown fixture mode")
}
