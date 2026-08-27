import test from "node:test";
import assert from "node:assert/strict";
import {parseLoopbackBaseUrl} from "../src/base_url.js";

test("accepts and normalizes strict loopback Webby endpoints", () => {
  assert.equal(parseLoopbackBaseUrl("http://localhost:6477/"), "http://localhost:6477");
  assert.equal(parseLoopbackBaseUrl("http://127.0.0.1:6477"), "http://127.0.0.1:6477");
  assert.equal(parseLoopbackBaseUrl("https://[::1]:6477"), "https://[::1]:6477");
});

test("rejects remote, deceptive, credentialed, and decorated endpoints", () => {
  for (const value of [
    "https://example.com", "http://localhost.example.com:6477",
    "http://localhost@evil.example:6477", "http://user:pass@localhost:6477",
    "http://127.0.0.2:6477", "http://127.1:6477", "http://2130706433:6477", "http://0.0.0.0:6477",
    "http://localhost:6477/path", "http://localhost:6477?next=evil", "http://localhost:6477/#x",
    "javascript:alert(1)"
  ]) assert.throws(() => parseLoopbackBaseUrl(value), /invalid_base_url/, value);
});
