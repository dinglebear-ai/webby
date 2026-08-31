import {createHash} from "node:crypto"
import {copyFile, lstat, mkdir, readFile, readdir, stat, writeFile} from "node:fs/promises"
import {join, relative, resolve} from "node:path"

// Public RSA key material only. It pins the generated test extension ID; it
// grants no authority and must never be treated as a credential.
export const TEST_MANIFEST_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsn8O/qyhEXOoFAHttPblNRVioKLgfGI4mG/RXCht7WrRUusN6G/YbyPJuCBwJq5mxQvcDhfByvFbwFTZzLOEr7MoT6L0QF/VhleBpbLfj/GFW+xHa+VpwU5TWEWjfj+Oh4xexlgMuTBo6Q4EcGkYwlEZ6QIyCyJnKVWXzrPmmv1iX/F/pw/5owfWmBr2pDo1PMRHGNRp5iM00FKEh7o7tvQd+wtsv5SSjmZ72CY5HBv49kRU7d0RuR5kt9BDLzyQusxvJyFN5BkvMuyY8O80GL/KTTdZoyd//uAPfmUy6QPq7SN++cEA+v1ad5ic6Moh6bAjimuT3V8yMkQmqbiSrwIDAQAB"

// The unpacked extension is a runtime artifact, not a source checkout. Keep
// this allowlist aligned with manifest entrypoints and their static imports so
// tests, package metadata, node_modules, and symlinks can never enter a browser
// profile or the world ownership audit.
export const RUNTIME_EXTENSION_FILES = Object.freeze([
  "manifest.json",
  "src/base_url.js",
  "src/channel.js",
  "src/diagnostics.js",
  "src/e2e_binding.js",
  "src/orchestration.js",
  "src/permissions.js",
  "src/popup.css",
  "src/popup.html",
  "src/popup.js",
  "src/probe.js",
  "src/scanning.js",
  "src/service_worker.js",
])

export function extensionIdForKey(key = TEST_MANIFEST_KEY) {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)
  return [...hex].map(character => String.fromCharCode(97 + Number.parseInt(character, 16))).join("")
}

async function treeEntries(root, directory = root) {
  const entries = []
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name)
    const info = await stat(path)
    if (info.isDirectory()) entries.push(...await treeEntries(root, path))
    else if (info.isFile()) entries.push({path, relative: relative(root, path)})
    else throw new Error(`unsupported extension tree entry: ${path}`)
  }
  return entries
}

export async function hashExtensionTree(root) {
  const digest = createHash("sha256")
  for (const entry of await treeEntries(resolve(root))) {
    digest.update(entry.relative).update("\0").update(await readFile(entry.path)).update("\0")
  }
  return digest.digest("hex")
}

function exactFixturePattern(fixtureUrl) {
  const url = new URL(fixtureUrl)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
    throw new Error("fixture origin must be an allocated IPv4 loopback HTTP origin")
  }
  // Chromium's installed host-permission representation is host-scoped. The
  // generated binding below pins the exact allocated authority (including
  // port), and the driver refuses every other authority before navigation.
  return `${url.protocol}//${url.hostname}/*`
}

async function copyRuntimeExtension(sourceRoot, destination) {
  await mkdir(destination, {recursive: false, mode: 0o700})
  for (const relativePath of RUNTIME_EXTENSION_FILES) {
    const sourcePath = join(sourceRoot, relativePath)
    const info = await lstat(sourcePath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`runtime extension source must be an owned regular file: ${relativePath}`)
    const targetPath = join(destination, relativePath)
    await mkdir(resolve(targetPath, ".."), {recursive: true, mode: 0o700})
    await copyFile(sourcePath, targetPath)
  }
}

export async function generateTestExtension({source, destination, fixtureUrl, world, broadHostPermissions = false}) {
  if (!world?.instance_nonce || world.environment_marker !== "isolated-e2e") throw new Error("invalid isolated world binding")
  const sourceRoot = resolve(source)
  const before = await hashExtensionTree(sourceRoot)
  await copyRuntimeExtension(sourceRoot, destination)
  const manifestPath = join(destination, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.key = TEST_MANIFEST_KEY
  manifest.host_permissions = broadHostPermissions ? ["http://*/*", "https://*/*"] : [exactFixturePattern(fixtureUrl)]
  manifest.version_name = "isolated-e2e"
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o600})
  const binding = {
    schema_version: 1,
    expected_extension_id: extensionIdForKey(),
    instance_nonce: world.instance_nonce,
    environment_marker: world.environment_marker,
    base_url: world.base_url,
    fixture_url: new URL(fixtureUrl).origin,
  }
  await writeFile(join(destination, "e2e-binding.json"), `${JSON.stringify(binding, null, 2)}\n`, {mode: 0o600})
  await writeFile(join(destination, "src", "e2e_binding.js"), `// Generated isolated-E2E world binding.\nexport const E2E_BINDING = Object.freeze(${JSON.stringify(binding)});\n`, {mode: 0o600})
  const after = await hashExtensionTree(sourceRoot)
  if (after !== before) throw new Error("production extension tree changed while generating test copy")
  return {path: resolve(destination), binding, productionHash: before, manifest}
}
