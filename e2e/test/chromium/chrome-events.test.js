import assert from "node:assert/strict"
import test from "node:test"
import {chromiumCommandRows} from "../../support/chromium-command-matrix.js"

test("every registered Chrome event has generated-copy instrumentation", () => {
  const rows = new Map(chromiumCommandRows)
  assert.deepEqual([...rows.entries()].filter(([id]) => id.startsWith("chrome-event:")).map(([, evidence]) => evidence), [
    "chrome.runtime.onInstalled", "chrome.runtime.onStartup", "chrome.tabs.onUpdated", "chrome.tabs.onActivated",
    "chrome.tabs.onRemoved", "chrome.alarms.onAlarm", "chrome.permissions.onAdded", "chrome.permissions.onRemoved",
    "chrome.storage.onChanged", "chrome.runtime.onMessage",
  ])
})
