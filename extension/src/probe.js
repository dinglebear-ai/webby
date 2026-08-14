/**
 * Functions injected into a page's main world by `chrome.scripting.executeScript`.
 *
 * IMPORTANT: every exported function here is passed as `func:` to
 * `executeScript`, which **serializes the function and loses its execution
 * context**. A helper defined at module scope is simply not defined in the
 * page, so calling one throws `ReferenceError` — and inside `probeWebMcp`'s
 * `try/catch` that surfaces as `supported: false` on every page, i.e. silent
 * total failure of discovery.
 *
 * So these functions must be self-contained: no imports, no module-scope
 * helpers, no closures. The duplication between `probeWebMcp` and
 * `invokeWebMcp` is forced by that boundary, not an oversight. It is pinned by
 * `test/probe.test.js`, which injects each function the way Chrome does and
 * asserts the two catalogs agree.
 */

/**
 * Reads a document's WebMCP catalog from the page's main world.
 *
 * Type-checked against the published `webmcp-types` definitions (see
 * `tsconfig.json`): if upstream renames a field this reads, the build fails
 * instead of the probe quietly reporting an empty catalog on every page.
 *
 * @returns {Promise<{supported: boolean, tools: Array<{name: string, description: string, input_schema: unknown}>}>}
 */
export async function probeWebMcp() {
  const context = document.modelContext;
  if (!context || typeof context.getTools !== "function") return {supported: false, tools: []};
  try {
    const tools = await context.getTools();
    const summary = Array.from(tools ?? []).slice(0, 64).flatMap((tool) => {
      if (!tool || typeof tool.name !== "string") return [];
      // The spec declares `inputSchema` as a stringified JSON Schema; the
      // snake_case read tolerates an origin-trial browser spelling it
      // otherwise. Rename `inputSchema` upstream and the type check fails.
      let inputSchema = tool.inputSchema ?? /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (tool)).input_schema ?? {};
      if (typeof inputSchema === "string") {
        try { inputSchema = JSON.parse(inputSchema); } catch { return []; }
      }
      return [{
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        input_schema: inputSchema
      }];
    });
    return {supported: true, tools: summary};
  } catch {
    return {supported: false, tools: []};
  }
}

/**
 * Invokes one tool on the current document, if its catalog still matches the
 * one the caller observed.
 *
 * The comparison happens here, in the page, immediately before execution, so a
 * page that mutates its catalog between discovery and invocation is caught
 * atomically. That is why the normalization is repeated rather than delegated
 * to the service worker.
 *
 * It must produce exactly what `scanning.js` `normalizeTools` produces from
 * `probeWebMcp` output, since that composition is what the caller stringifies
 * into `expectedCatalog`: same 64-tool cap, same 1..128 name bounds, same
 * 1000-character description truncation, and the same sort by name.
 *
 * @param {string} toolName
 * @param {unknown} input
 * @param {string} callId
 * @param {string} expectedCatalog
 * @returns {Promise<unknown>}
 */
export async function invokeWebMcp(toolName, input, callId, expectedCatalog) {
  const context = document.modelContext;
  if (!context || typeof context.getTools !== "function") throw new Error("webmcp_unavailable");

  // `executeTool()` is NOT in the WebMCP specification. The upstream README
  // still reads "TODO: Spec and describe the modelContext.getTools() and
  // modelContext.executeTool() APIs", and webmachinelearning/webmcp#51 -- the
  // issue defining how an agent invokes a site's declared tools -- has been
  // open since 2025-11-03. getTools() was specced in #223; its sibling was
  // not. Per section 21 of the design spec, feature-detect and report
  // unsupported rather than simulating invocation. When upstream specs it,
  // webmcp-types will publish a signature and the contract check will report
  // the version bump.
  const executeTool = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (context)).executeTool;
  if (typeof executeTool !== "function") throw new Error("webmcp_unavailable");

  const tools = Array.from(await context.getTools() ?? []);

  const normalized = tools.slice(0, 64).flatMap((tool) => {
    if (!tool || typeof tool.name !== "string") return [];
    if (tool.name.length < 1 || tool.name.length > 128) return [];
    let schema = tool.inputSchema ?? /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (tool)).input_schema ?? {};
    if (typeof schema === "string") {
      try { schema = JSON.parse(schema); } catch { return []; }
    }
    return [{
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description.slice(0, 1000) : "",
      input_schema: schema
    }];
  }).sort((left, right) => left.name.localeCompare(right.name));

  // Key order is not observable through the WebMCP surface, so canonicalize
  // before comparing as a string.
  /** @type {(value: unknown) => unknown} */
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      const record = /** @type {Record<string, unknown>} */ (value);
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
    }
    return value;
  };

  if (JSON.stringify(stable(normalized)) !== expectedCatalog) throw new Error("stale_catalog");

  const tool = tools.find((candidate) => candidate?.name === toolName);
  if (!tool) throw new Error("tool_not_found");

  const controllers = globalThis.__webbyToolCalls ??= new Map();
  const controller = new AbortController();
  controllers.set(callId, controller);
  try {
    const result = await executeTool.call(context, tool, JSON.stringify(input ?? {}), {signal: controller.signal});
    if (typeof result !== "string") return result;
    try { return JSON.parse(result); } catch { return result; }
  } finally {
    controllers.delete(callId);
  }
}

/**
 * @param {string} callId
 * @returns {boolean}
 */
export function cancelWebMcp(callId) {
  const controller = globalThis.__webbyToolCalls?.get(callId);
  if (!controller) return false;
  controller.abort();
  return true;
}
