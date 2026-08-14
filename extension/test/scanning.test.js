import test from "node:test";
import assert from "node:assert/strict";
import {buildObservation, canScanTab, eligibleUrl, normalizeTools, sanitizePage} from "../src/scanning.js";

test("excludes internal and incognito tabs and scans only granted origins", async () => {
  assert.equal(eligibleUrl("chrome://settings"), false);
  assert.equal(await canScanTab({id: 1, incognito: true, url: "https://example.com"}, {contains: async () => true}), false);
  assert.equal(await canScanTab({id: 2, url: "https://example.com/a"}, {contains: async ({origins}) => origins[0] === "https://example.com/*"}), true);
});

test("sanitizes query, fragment, credentials, and controls before transport", () => {
  assert.deepEqual(sanitizePage("https://user:secret@example.com/path?q=secret#token", "A\u0000 title"), {url: "https://example.com/path", title: "A title"});
});

test("normalizes the draft getTools catalog without executable callbacks", () => {
  assert.deepEqual(normalizeTools([{name: "search", description: "Search", inputSchema: "{\"type\":\"object\"}", execute() {}}]), [{name: "search", description: "Search", input_schema: {type: "object"}}]);
});

test("binds observations to Chrome's document identity", () => {
  assert.deepEqual(
    buildObservation(
      {id: 12, url: "https://example.com/tools?secret=yes", title: "Tools"},
      {documentId: "document-12", result: {supported: true, tools: [{name: "lookup"}]}}
    ),
    {
      url: "https://example.com/tools",
      title: "Tools",
      tools: [{name: "lookup", description: "", input_schema: {}}],
      tab_id: 12,
      document_id: "document-12"
    }
  );

  assert.equal(
    buildObservation(
      {id: 12, url: "https://example.com/tools", title: "Tools"},
      {result: {supported: true, tools: [{name: "lookup"}]}}
    ),
    null
  );

  assert.equal(
    buildObservation(
      {id: 12, url: "https://example.com/tools", title: "Tools"},
      {documentId: "document-12", result: {supported: false, tools: []}}
    ),
    null
  );
});
