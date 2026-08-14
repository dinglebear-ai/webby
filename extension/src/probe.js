export async function probeWebMcp() {
  const context = document.modelContext;
  if (!context || typeof context.getTools !== "function") return {supported: false, tools: []};
  try {
    const tools = await context.getTools();
    const summary = Array.from(tools ?? []).slice(0, 64).flatMap((tool) => {
      if (!tool || typeof tool.name !== "string") return [];
      let inputSchema = tool.inputSchema ?? tool.input_schema ?? {};
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

export async function invokeWebMcp(toolName, input, callId, expectedCatalog) {
  const context = document.modelContext;
  if (!context || typeof context.getTools !== "function" || typeof context.executeTool !== "function") {
    throw new Error("webmcp_unavailable");
  }

  const tools = Array.from(await context.getTools() ?? []);
  const normalized = tools.slice(0, 64).flatMap((tool) => {
    if (!tool || typeof tool.name !== "string") return [];
    let schema = tool.inputSchema ?? tool.input_schema ?? {};
    if (typeof schema === "string") {
      try { schema = JSON.parse(schema); } catch { return []; }
    }
    return [{name: tool.name, description: typeof tool.description === "string" ? tool.description : "", input_schema: schema}];
  });

  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
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
    const result = await context.executeTool(tool, JSON.stringify(input ?? {}), {signal: controller.signal});
    if (typeof result !== "string") return result;
    try { return JSON.parse(result); } catch { return result; }
  } finally {
    controllers.delete(callId);
  }
}

export function cancelWebMcp(callId) {
  const controller = globalThis.__webbyToolCalls?.get(callId);
  if (!controller) return false;
  controller.abort();
  return true;
}
