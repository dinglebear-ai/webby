export function installWebMcpFixture(documentObject = document, {bridge} = {}) {
  const state = {revision: 1, calls: new Map(), effects: 0, events: [], dynamic: false};
  const record = (type, detail = {}) => state.events.push({sequence: state.events.length + 1, type, ...detail});
  const baseTools = [
    tool("echo", {type: "object", properties: {value: {}}, required: ["value"]}),
    tool("typed", {type: "object", properties: {count: {type: "integer"}, enabled: {type: "boolean"}}, required: ["count", "enabled"]}),
    tool("immediate"), tool("delayed"), tool("side_effect"), tool("reject"), tool("oversized"), tool("deep"), tool("catalog.add"), tool("catalog.remove")
  ];
  const tools = () => state.dynamic ? [...baseTools, tool("dynamic")] : baseTools;
  const gates = new Map();

  bridge ??= browserBridge();
  const context = {
    async getTools() { return tools(); },
    async executeTool(toolReference, inputArguments = {}, {signal} = {}) {
      const name = typeof toolReference === "string" ? toolReference : toolReference?.name;
      const args = typeof inputArguments === "string" ? JSON.parse(inputArguments) : inputArguments;
      if (!tools().some((entry) => entry.name === name)) throw new Error("tool_not_found");
      const call = {name, args, status: "started"}; state.calls.set(args.call_handle ?? `${name}-${state.calls.size + 1}`, call); record("call.started", {name});
      if (name === "delayed") {
        try {
          const state = bridge ? await bridge.wait(args.scenario_id, args.call_handle, signal) : await waitForGate(args.call_handle, signal);
          if (state === "aborted") throw new DOMException("Aborted", "AbortError");
        }
        catch (error) { call.status = "aborted"; record("call.aborted", {name}); throw error; }
      }
      if (signal?.aborted) { call.status = "aborted"; record("call.aborted", {name}); throw new DOMException("Aborted", "AbortError"); }
      if (name === "reject") throw new Error("controlled_rejection");
      if (name === "side_effect" || name === "delayed") state.effects += 1;
      if (name === "catalog.add") { state.dynamic = true; state.revision += 1; record("catalog.changed", {revision: state.revision}); }
      if (name === "catalog.remove") { state.dynamic = false; state.revision += 1; record("catalog.changed", {revision: state.revision}); }
      call.status = "completed"; record("call.completed", {name});
      if (name === "echo") return args.value;
      if (name === "typed") return {count: args.count, enabled: args.enabled};
      if (name === "oversized") return "x".repeat(131_073);
      if (name === "deep") { let value = "leaf"; for (let i = 0; i < 34; i += 1) value = {value}; return value; }
      return {ok: true, name, effects: state.effects, revision: state.revision};
    }
  };

  function waitForGate(handle, signal) {
    if (typeof handle !== "string" || !handle) throw new Error("missing_call_handle");
    return new Promise((resolve, reject) => {
      const abort = () => { gates.delete(handle); reject(new DOMException("Aborted", "AbortError")); };
      signal?.addEventListener("abort", abort, {once: true});
      gates.set(handle, {release() { signal?.removeEventListener("abort", abort); gates.delete(handle); resolve(); }, abort});
    });
  }

  Object.defineProperty(documentObject, "modelContext", {value: context, writable: true, configurable: true});
  globalThis.__webbyFixture = {
    release(handle) { const gate = gates.get(handle); if (!gate) throw new Error("unknown_or_stale_handle"); gate.release(); },
    abort(handle) { const gate = gates.get(handle); if (!gate) throw new Error("unknown_or_stale_handle"); gate.abort(); },
    snapshot() { return structuredClone({revision: state.revision, catalog: tools(), effects: state.effects, events: state.events, calls: [...state.calls]}); },
    navigateMarker() { return documentObject.documentElement.dataset.documentMarker; }
  };
  return context;
}

function browserBridge() {
  if (typeof location === "undefined" || typeof fetch === "undefined") return null;
  return {
    async wait(scenarioId, callId, signal) {
      if (typeof scenarioId !== "string" || typeof callId !== "string") throw new Error("missing_call_correlation");
      const query = new URLSearchParams({scenario_id: scenarioId, call_id: callId});
      const response = await fetch(`/__fixture/wait?${query}`, {signal, cache: "no-store"});
      if (!response.ok) throw new Error(`fixture_bridge_${response.status}`);
      return (await response.json()).state;
    }
  };
}

function tool(name, inputSchema = {type: "object", additionalProperties: true}) {
  return {name, description: `Deterministic ${name} fixture`, inputSchema};
}

if (typeof document !== "undefined") installWebMcpFixture(document);
