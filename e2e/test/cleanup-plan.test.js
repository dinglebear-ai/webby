import assert from "node:assert/strict"
import test from "node:test"
import {cleanupRunStatus, collectCleanup, runCleanupPlan, throwCleanupFailures} from "../support/cleanup-plan.js"

test("cleanup attempts every labeled step in declaration order", async () => {
  const execution = []
  const first = new Error("first failed")
  const third = new Error("third failed")
  const result = await collectCleanup([
    ["first", async () => { execution.push("first"); throw first }],
    {label: "second", run: async () => { execution.push("second"); return 2 }, onSuccess: value => execution.push(`committed:${value}`)},
    ["third", async () => { execution.push("third"); throw third }],
  ])

  assert.deepEqual(execution, ["first", "second", "committed:2", "third"])
  assert.deepEqual(result.outcomes.map(({label, status}) => ({label, status})), [
    {label: "first", status: "rejected"}, {label: "second", status: "fulfilled"}, {label: "third", status: "rejected"},
  ])
  assert.deepEqual(result.failures, [first, third])
  assert.equal(first.cleanup_label, "first")
  assert.equal(third.cleanup_label, "third")
})

test("cleanup aggregation preserves the primary error and ordered labeled causes", async () => {
  const primary = new Error("operation failed")
  const close = new Error("close failed")
  const remove = new Error("remove failed")
  await assert.rejects(
    runCleanupPlan([
      ["close", async () => { throw close }],
      ["remove", async () => { throw remove }],
    ], {message: "operation and cleanup failed", primaryError: primary}),
    error => error instanceof AggregateError && error.cause === primary &&
      error.errors[0] === primary && error.errors[1] === close && error.errors[2] === remove &&
      close.cleanup_label === "close" && remove.cleanup_label === "remove",
  )
})

test("a lone primary or cleanup failure keeps its original identity", async () => {
  const primary = new Error("primary")
  assert.throws(() => throwCleanupFailures([], "unused", {primaryError: primary}), error => error === primary)
  const cleanup = new Error("cleanup")
  await assert.rejects(runCleanupPlan([["resource", async () => { throw cleanup }]]), error => error === cleanup && error.cleanup_label === "resource")
})

test("frozen cleanup errors retain their cause through a labeled wrapper", async () => {
  const frozen = Object.freeze(Object.assign(new Error("immutable failure"), {code: "immutable"}))
  await assert.rejects(runCleanupPlan([["frozen-resource", async () => { throw frozen }]]), error =>
    error !== frozen && error.cause === frozen && error.code === "immutable" && error.cleanup_label === "frozen-resource")
})

test("invalid plans fail before running later malformed steps", async () => {
  await assert.rejects(collectCleanup([["valid", async () => {}], ["missing-operation"]]), /requires an operation/)
  await assert.rejects(collectCleanup([["", async () => {}]]), /requires a label/)
})

test("primary execution failure makes an otherwise clean cleanup run fail", () => {
  assert.equal(cleanupRunStatus(), "passed")
  assert.equal(cleanupRunStatus({failures: [new Error("cleanup")]}), "failed")
  assert.equal(cleanupRunStatus({primaryError: new Error("scenario"), failures: []}), "failed")
})
