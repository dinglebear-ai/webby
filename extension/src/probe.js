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
