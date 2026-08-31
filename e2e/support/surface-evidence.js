import {readFile, writeFile} from "node:fs/promises"

const sortedUnique = values => [...new Set(values)].sort()

export async function loadSurfaceInventory(url = new URL("../contracts/surfaces.json", import.meta.url)) {
  return JSON.parse(await readFile(url, "utf8"))
}

export function validateObservedSurfaces({scenario, driver, observed, inventory}) {
  if (!scenario?.id || !scenario.drivers?.includes(driver)) throw new Error("surface evidence requires an eligible scenario adapter")
  if (!Array.isArray(observed) || observed.length === 0 || observed.some(id => typeof id !== "string" || id.length === 0)) throw new Error(`${driver}/${scenario.id}: observed surface evidence is empty or invalid`)
  const declared = sortedUnique(scenario.surface_ids ?? [])
  const actual = sortedUnique(observed)
  const inventoryIds = new Set((inventory?.surfaces ?? []).map(surface => surface.id))
  const unknown = actual.filter(id => !inventoryIds.has(id))
  const undeclared = actual.filter(id => !declared.includes(id))
  const missing = declared.filter(id => !actual.includes(id))
  if (unknown.length || undeclared.length || missing.length) throw new Error(`${driver}/${scenario.id}: observed surface denominator drifted; missing=${missing.join(",")} undeclared=${undeclared.join(",")} unknown=${unknown.join(",")}`)
  for (const id of actual) {
    const surface = inventory.surfaces.find(row => row.id === id)
    if (!surface.scenarios?.includes(scenario.id)) throw new Error(`${driver}/${scenario.id}: inventory does not map observed surface ${id}`)
  }
  return Object.freeze({schema_version: 1, scenario_id: scenario.id, adapter: driver, declared_surface_ids: declared, observed_surface_ids: actual, coverage_percent: 100})
}

export async function writeSurfaceEvidence(path, options) {
  const evidence = validateObservedSurfaces(options)
  await writeFile(path, JSON.stringify(evidence, null, 2) + "\n", {mode: 0o600})
  return evidence
}
