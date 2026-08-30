import {createHash} from "node:crypto"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import {dirname, resolve} from "node:path"

function seedWords(seed) {
  const digest = createHash("sha256").update(String(seed)).digest()
  return [0, 4, 8, 12].map(offset => digest.readUInt32LE(offset) || 0x9e3779b9)
}

export function seededRandom(seed) {
  let [a, b, c, d] = seedWords(seed)
  return () => {
    const t = (a + b + d) >>> 0
    d = (d + 1) >>> 0; a = (b ^ (b >>> 9)) >>> 0
    b = (c + (c << 3)) >>> 0; c = ((c << 21) | (c >>> 11)) >>> 0
    c = (c + t) >>> 0
    return t / 0x1_0000_0000
  }
}

export function shuffled(values, seed) {
  const output = [...values]; const random = seededRandom(seed)
  for (let index = output.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1))
    ;[output[index], output[target]] = [output[target], output[index]]
  }
  return output
}

export async function writeReplayManifest(path, manifest) {
  const value = {schema_version: 1, ...manifest}
  await mkdir(dirname(resolve(path)), {recursive: true, mode: 0o700})
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", {mode: 0o600})
  return value
}

export async function readReplayManifest(path) {
  const value = JSON.parse(await readFile(path, "utf8"))
  if (value.schema_version !== 1 || typeof value.seed !== "string" || value.seed.length === 0 || !Array.isArray(value.scenario_ids) || value.scenario_ids.length === 0 || value.scenario_ids.some(id => typeof id !== "string" || id.length === 0)) throw new Error("invalid stress replay manifest")
  return value
}
