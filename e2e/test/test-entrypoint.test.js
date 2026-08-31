import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import {resolve} from "node:path"
import test from "node:test"

const e2eRoot = resolve(new URL("..", import.meta.url).pathname)

test("default test entrypoint is an explicit serialized deterministic inventory", async () => {
  const packageJson = JSON.parse(await readFile(resolve(e2eRoot, "package.json"), "utf8"))
  const command = packageJson.scripts.test
  assert.match(command, /^node --test --test-concurrency=1(?: test\/[a-z0-9./-]+\.test\.js)+$/)
  assert.match(command, /test\/cleanup-plan\.test\.js/)
  assert.match(command, /test\/contracts\.test\.js/)
  for (const livePath of [
    "test/chromium/", "test/scenarios/protocol-", "test/dashboard-commands.test.js",
    "test/mcp-contract.test.js", "test/mcp-official-client.test.js", "test/simulated-browser.test.js",
    "test/world.test.js", "test/stress/live-faults.test.js",
  ]) assert.equal(command.includes(livePath), false, `${livePath} must remain in an explicit live lane`)
})
