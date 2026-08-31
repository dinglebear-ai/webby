import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import test from "node:test"
import {assertChromiumCommandCoverage, chromiumAdapterExclusions, chromiumCommandRows, pairingStates} from "../../support/chromium-command-matrix.js"

test("popup and pairing inventory is literally 100% mapped", async () => {
  const contract = JSON.parse(await readFile(new URL("../../contracts/surfaces.json", import.meta.url)))
  assert.deepEqual(assertChromiumCommandCoverage(contract.surfaces), {eligible: 29, mapped: 29, percent: 100})
  assert.deepEqual(pairingStates, ["pending", "approved", "rejected", "duplicate"])
  assert.deepEqual(Object.keys(chromiumAdapterExclusions), ["chrome-event:startup", "chrome-event:permission-added", "chrome-event:permission-removed", "pairing:expired"])
  for (const exclusion of Object.values(chromiumAdapterExclusions)) {
    assert.ok(exclusion.source_symbol && exclusion.owner && exclusion.rationale && exclusion.reviewed_on && exclusion.adapter)
  }
  assert.equal(new Map(chromiumCommandRows).get("popup:paused"), "popup.pause-and-resume")
})
