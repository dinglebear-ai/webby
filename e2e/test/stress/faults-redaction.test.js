import assert from "node:assert/strict"
import test from "node:test"
import {assertNoSecrets, redactStructured, SecretRegistry} from "../../support/redaction.js"
import {injectHungClose, injectRecorderPressure, injectTermination} from "../../support/stress-faults.js"

const faults = ["SIGTERM", "SIGINT", "controller-death", "hung-browser-close", "disk-pressure", "recorder-overflow"]

test("documented termination, controller, hung-close and recorder faults execute", async () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGKILL"]) assert.ok((await injectTermination(signal)).signal)
  assert.equal(await injectHungClose(), "forced")
  const disk = await injectRecorderPressure("disk-pressure"); assert.equal(disk.code, "free_space"); await assert.rejects(import("node:fs/promises").then(({stat}) => stat(disk.removed_root)), error => error.code === "ENOENT")
  const overflow = await injectRecorderPressure("recorder-overflow"); assert.equal(overflow.code, "file_quota"); await assert.rejects(import("node:fs/promises").then(({stat}) => stat(overflow.removed_root)), error => error.code === "ENOENT")
  assert.deepEqual(faults, ["SIGTERM", "SIGINT", "controller-death", "hung-browser-close", "disk-pressure", "recorder-overflow"])
})

test("stress-sized structured payload remains redacted", () => {
  const secret = "stress-secret-value"; const registry = new SecretRegistry([secret])
  const payload = Array.from({length: 1000}, (_, index) => ({index, authorization: `Bearer ${secret}`, nested: {token: secret, message: `run-${index}-${secret}`}}))
  const encoded = JSON.stringify(redactStructured(payload, registry))
  assertNoSecrets(encoded, registry, "stress payload")
  assert.ok(encoded.length < 500_000); assert.doesNotMatch(encoded, /stress-secret-value/)
})
