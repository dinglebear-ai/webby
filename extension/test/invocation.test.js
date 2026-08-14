import test from "node:test";
import assert from "node:assert/strict";
import {cancelWebMcp, invokeWebMcp} from "../src/probe.js";

test("executes only the named tool from the expected catalog", async () => {
  const tool = {name: "find", description: "Find", inputSchema: {type: "object"}};
  globalThis.document = {modelContext: {
    getTools: async () => [tool],
    executeTool: async (selected, input) => {
      assert.equal(selected, tool);
      assert.deepEqual(JSON.parse(input), {query: "hello"});
      return '{"count":1}';
    }
  }};

  const catalog = '[{"description":"Find","input_schema":{"type":"object"},"name":"find"}]';
  assert.deepEqual(await invokeWebMcp("find", {query: "hello"}, "call-1", catalog), {count: 1});
  delete globalThis.document;
});

test("aborts the exact pending page call", async () => {
  const tool = {name: "wait", description: "Wait", inputSchema: {}};
  globalThis.document = {modelContext: {
    getTools: async () => [tool],
    executeTool: (_tool, _input, {signal}) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    })
  }};

  const catalog = '[{"description":"Wait","input_schema":{},"name":"wait"}]';
  const pending = invokeWebMcp("wait", {}, "call-2", catalog);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelWebMcp("call-2"), true);
  await assert.rejects(pending, /aborted/);
  assert.equal(cancelWebMcp("call-2"), false);
  delete globalThis.document;
});
