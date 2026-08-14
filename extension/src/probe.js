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
    const tools = await context.getTools();
    const summary = Array.from(tools ?? []).slice(0, 64).flatMap((tool) => {
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
    return {supported: true, tools: summary};
  } catch {
    return {supported: false, tools: []};
  }
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
