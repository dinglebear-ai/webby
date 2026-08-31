#!/usr/bin/env node
import {cleanupWorlds, replay, runSuite, toolchains, writeShardManifest} from "./ci-runner.js"

const [command, ...args] = process.argv.slice(2)
let status = 0
if (command === "run") status = await runSuite(args[0])
else if (command === "cleanup") status = await cleanupWorlds()
else if (command === "toolchains") await toolchains()
else if (command === "replay") await replay(args[0])
else if (command === "manifest") {
  const options = Object.fromEntries(args.map(value => value.split("=", 2)))
  await writeShardManifest({lane: options.lane, driver: options.driver, shard: Number(options.shard ?? 1), total: Number(options.total ?? 1), output: options.output ?? "artifacts/scenario-manifest.json"})
} else throw new Error("usage: e2e-cli.js run SUITE | cleanup | toolchains | replay DIRECTORY | manifest lane=... driver=...")
process.exitCode = status

