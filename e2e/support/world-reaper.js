import {reapManifest} from "./world.js"

const manifestPath = process.argv[2]
if (!manifestPath) throw new Error("usage: node world-reaper.js MANIFEST")
const result = await reapManifest(manifestPath)
process.stdout.write(`${JSON.stringify(result)}\n`)
