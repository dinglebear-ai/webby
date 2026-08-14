/**
 * Normalizes a WebMCP catalog into the shape Webby transports and records.
 *
 * Shared by discovery and invocation on purpose. `invokeWebMcp` compares its
 * normalized catalog against the one the server recorded from `probeWebMcp`;
 * if the two normalizations ever diverged, every invocation would fail with
 * `stale_catalog`.
 *
 * @param {readonly WebMCP.RegisteredTool[]} tools
 * @returns {Array<{name: string, description: string, input_schema: unknown}>}
 */
function normalizeCatalog(tools) {
  return Array.from(tools ?? []).slice(0, 64).flatMap((tool) => {
    if (!tool || typeof tool.name !== "string") return [];
    let inputSchema = readInputSchema(tool);
    if (typeof inputSchema === "string") {
      try { inputSchema = JSON.parse(inputSchema); } catch { return []; }
    }
    return [{
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      input_schema: inputSchema ?? {}
    }];
  });
}

/**
 * Reads a document's WebMCP catalog from the page's main world.
 *
 * Type-checked against the published `webmcp-types` definitions (see
 * `tsconfig.json`). That check is the point: if upstream renames a field this
 * probe reads, the build fails instead of the probe quietly reporting an empty
 * catalog on every page.
 *
 * @returns {Promise<{supported: boolean, tools: Array<{name: string, description: string, input_schema: unknown}>}>}
 */
export async function probeWebMcp() {
  const context = document.modelContext;
  if (!context || typeof context.getTools !== "function") return {supported: false, tools: []};
  try {
    return {supported: true, tools: normalizeCatalog(await context.getTools())};
  } catch {
    return {supported: false, tools: []};
  }
}

/**
 * Invokes one tool on the current document, if the catalog still matches.
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

  const executeTool = unspecifiedExecuteTool(context);
  if (!executeTool) throw new Error("webmcp_unavailable");

  const tools = Array.from(await context.getTools() ?? []);
  if (JSON.stringify(stable(normalizeCatalog(tools))) !== expectedCatalog) {
    throw new Error("stale_catalog");
  }

  const tool = tools.find((candidate) => candidate?.name === toolName);
  if (!tool) throw new Error("tool_not_found");

  const controllers = globalThis.__webbyToolCalls ??= new Map();
  const controller = new AbortController();
  controllers.set(callId, controller);
  try {
    const result = await executeTool(tool, JSON.stringify(input ?? {}), {signal: controller.signal});
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

/**
 * Key order is not observable through the WebMCP surface, so the catalog is
 * canonicalized before it is compared as a string.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(/** @type {Record<string, unknown>} */ (value)[key])])
    );
  }
  return value;
}

/**
 * `executeTool()` is NOT part of the WebMCP specification.
 *
 * The upstream README still reads "TODO: Spec and describe the
 * `modelContext.getTools()` and `modelContext.executeTool()` APIs", and
 * webmachinelearning/webmcp#51 -- the issue defining how an agent invokes a
 * site's declared tools -- has been open since 2025-11-03. `getTools()` was
 * specced in #223; its sibling was not.
 *
 * Webby therefore feature-detects it and reports `webmcp_unavailable` rather
 * than simulating invocation, as section 21 of the design spec requires. This
 * function is the single boundary where that unspecified surface enters typed
 * code, kept deliberately narrow so everything the spec *does* define stays
 * checked. When upstream specs it, `webmcp-types` will publish a signature and
 * the contract check will report the version bump; replace this then.
 *
 * @param {WebMCP.ModelContext} context
 * @returns {((tool: WebMCP.RegisteredTool, input: string, options?: {signal?: AbortSignal}) => Promise<unknown>) | undefined}
 */
function unspecifiedExecuteTool(context) {
  const loose = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (context));
  const execute = loose.executeTool;
  if (typeof execute !== "function") return undefined;
  return /** @type {(tool: WebMCP.RegisteredTool, input: string, options?: {signal?: AbortSignal}) => Promise<unknown>} */ (
    execute.bind(context)
  );
}

/**
 * The specification declares `RegisteredTool.inputSchema` as a stringified JSON
 * Schema, and that spelling is what the type check pins.
 *
 * The snake_case read is deliberate tolerance for a browser shipping something
 * other than the specified name during origin trial. It goes through an
 * explicitly loosened view so that it stays a runtime fallback and cannot
 * substitute for the specified field: if upstream renames `inputSchema`, the
 * first read stops type-checking and CI says so.
 *
 * @param {WebMCP.RegisteredTool} tool
 * @returns {unknown}
 */
function readInputSchema(tool) {
  if (tool.inputSchema !== undefined) return tool.inputSchema;
  const loose = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (tool));
  return loose.input_schema;
}
