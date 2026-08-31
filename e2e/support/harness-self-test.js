import assert from "node:assert/strict"
import {mkdtemp, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {buildSuiteTelemetry} from "./suite-telemetry.js"
import {loadSurfaceInventory, validateObservedSurfaces} from "./surface-evidence.js"
import {readScenarioContract} from "./runtime-contracts.js"

export async function runHarnessSelfTests() {
  const inventory = await loadSurfaceInventory()
  const scenario = await readScenarioContract(new URL("../contracts/scenarios/shared-vertical-slice.json", import.meta.url))
  const probes = []
  const rejects = async (name, operation, pattern) => {
    await assert.rejects(operation, pattern)
    probes.push({name, outcome: "rejected-as-required"})
  }
  await rejects("missing-observed-surface", async () => validateObservedSurfaces({scenario, driver: "protocol", observed: scenario.surface_ids.slice(1), inventory}), /denominator drifted/)
  await rejects("invented-observed-surface", async () => validateObservedSurfaces({scenario, driver: "protocol", observed: [...scenario.surface_ids, "surface:invented"], inventory}), /denominator drifted/)
  await rejects("invalid-telemetry-attempts", async () => buildSuiteTelemetry({suite: "protocol-full", status: "passed", startedAt: new Date(), finishedAt: new Date(), attempts: 1, retries: 1}), /attempt/)
  const directory = await mkdtemp(join(tmpdir(), "webby-harness-self-test-"))
  try {
    const path = join(directory, "malformed.json")
    await writeFile(path, "{not-json\n")
    await rejects("malformed-scenario-contract", async () => readScenarioContract(path), /JSON/)
  } finally { await rm(directory, {recursive: true, force: true}) }
  return {schema_version: 1, status: "passed", probes}
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runHarnessSelfTests().then(report => process.stdout.write(`${JSON.stringify(report)}\n`)).catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
}
