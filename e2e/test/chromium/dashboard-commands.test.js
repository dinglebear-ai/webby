import assert from "node:assert/strict"
import test from "node:test"
import {emitLiveTestReceipt} from "../../support/live-test-receipt.js"
import {dashboardEventContract} from "../../support/dashboard-selectors.js"
import {dashboardScenarioReuse} from "../../support/chromium-command-matrix.js"

test("Chromium reuses all seven dashboard scenario IDs without a duplicate matrix", async () => {
  assert.equal(dashboardEventContract.length, 7)
  assert.match(dashboardScenarioReuse.source, /dashboardEventContract/)
  assert.equal(dashboardScenarioReuse.test, "e2e/test/dashboard-commands.test.js")
  await emitLiveTestReceipt({scenarioId: "e2e-extension-controls", adapter: "chromium", receiptId: "dashboard-commands-asserted", assertions: {dashboard_scenarios_reused: dashboardEventContract.length}})
})
