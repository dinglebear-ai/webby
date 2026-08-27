import {WebbyWorld} from "./world.js"

const world = await WebbyWorld.start({scenarioId: "controller-death", preserveArtifacts: true})
process.stdout.write(`${JSON.stringify({manifestPath: world.manifestPath, root: world.root, pid: world.pid, baseUrl: world.baseUrl})}\n`)
process.exit(0)
