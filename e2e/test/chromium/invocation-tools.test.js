import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ArtifactRecorder } from "../../support/artifacts.js";
import { ChromiumWorld } from "../../support/chromium-world.js";
import {
  assertExecutedCoverage,
  fixtureToolRows,
  reviewedCrashExclusions,
} from "../../support/chromium-invocation-matrix.js";
import { DashboardDriver } from "../../support/dashboard-driver.js";
import {
  fixtureOutcomeParityResult,
  runSharedFixtureOutcome,
} from "../../support/fixture-outcome-parity.js";
import { observeRecordedSurfaces } from "../../support/boundary-surfaces.js";
import { MCPClient, MCPClientError } from "../../support/mcp-client.js";
import { compareParity } from "../../support/parity-report.js";
import { ScenarioRunner } from "../../support/scenario-runner.js";
import { WebbyWorld } from "../../support/world.js";
import { startFixtureServer } from "../../fixture/server.js";

const execFileAsync = promisify(execFile);

function content(response) {
  assert.equal(response.status, 200);
  assert.equal(response.body.error, undefined);
  return (
    response.body.result.structuredContent ??
    JSON.parse(response.body.result.content[0].text)
  );
}

function toolError(response, kind) {
  assert.equal(
    response.status,
    200,
    JSON.stringify(response.body ?? response.text),
  );
  assert.equal(response.body.result.isError, true);
  assert.equal(response.body.result.structuredContent.kind, kind);
  return response.body.result.structuredContent;
}

async function audits(database, credentialId) {
  const sql = `SELECT id, session_id, tool_name, outcome, error_kind, catalog_revision FROM invocation_audits WHERE credential_id='${credentialId}' ORDER BY inserted_at, id`;
  return JSON.parse(
    (await execFileAsync("sqlite3", ["-json", database, sql])).stdout || "[]",
  );
}

async function bounded(label, operation, timeoutMs = 15_000) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} cleanup exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function documentSessions(database) {
  return JSON.parse(
    (
      await execFileAsync("sqlite3", [
        "-json",
        database,
        "SELECT id, registration_id, tab_id, document_id, catalog_revision FROM document_sessions WHERE status='active' ORDER BY last_seen_at, id",
      ])
    ).stdout || "[]",
  );
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${message}`);
}

async function fixtureCallStarted(fixture, callId, timeoutMs = 30_000) {
  return waitFor(
    () =>
      fixture.control
        .snapshot()
        .events.some(
          (event) => event.type === "page.wait" && event.call_id === callId,
        ),
    `fixture call ${callId}`,
    timeoutMs,
  );
}

async function discoverSession(mcp, registrationId, { sessionId } = {}) {
  const sessions = content(
    await mcp.call({ action: "page.tools", params: { page: registrationId } }),
  ).sessions;
  const session = sessionId
    ? sessions.find((candidate) => candidate.id === sessionId)
    : sessions[0];
  assert.ok(session, `session ${sessionId ?? "first"} was not available`);
  return session;
}

async function waitForPublicSession(
  mcp,
  registrationId,
  predicate,
  { attempts = 10 } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const sessions = content(
      await mcp.call({
        action: "page.tools",
        params: { page: registrationId },
      }),
    ).sessions;
    const session = sessions.find(predicate);
    if (session) return session;
  }
  throw new Error(
    `public session predicate did not match after ${attempts} bounded observations`,
  );
}

async function waitForSuccessfulCall(mcp, arguments_, { attempts = 10 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await mcp.call(arguments_);
    if (!response.body.result.isError) return response;
    assert.equal(response.body.result.structuredContent.kind, "page_offline");
  }
  throw new Error(
    `page call remained offline after ${attempts} bounded observations`,
  );
}

function callArgs(registrationId, session, tool, arguments_ = {}) {
  return {
    action: "page.call",
    params: {
      page: registrationId,
      session: session.id,
      tool,
      catalog_revision: session.catalog_revision,
      arguments: arguments_,
    },
  };
}

test(
  "real Chromium exhausts fixture outcomes, catalog mutation, cancellation, and exact documents",
  { timeout: 300_000 },
  async (t) => {
    const fixtureContract = JSON.parse(
      await readFile(
        new URL(
          "../../contracts/scenarios/fixture-outcomes.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const classifierSource = await readFile(
      new URL("../../../extension/src/service_worker.js", import.meta.url),
      "utf8",
    );
    for (const exclusion of reviewedCrashExclusions)
      assert.match(
        classifierSource,
        new RegExp(`function\\s+${exclusion.symbol}\\s*\\(`),
        `${exclusion.id} exclusion source symbol must exist`,
      );
    let world = await WebbyWorld.start({
      scenarioId: "chromium_invocation_tools",
      seed: 18018,
      preserveArtifacts: true,
      invocationTimeoutMs: 30_000,
    });
    await world.releaseFixturePort();
    const fixture = await startFixtureServer({
      worldId: world.worldId,
      port: world.fixturePort,
    });
    const recorder = await new ArtifactRecorder({
      root: join(world.workspace.artifacts, "chromium-invocation"),
      scenarioId: world.scenarioId,
      worldId: world.worldId,
      seed: world.seed,
      secrets: [world.secret, world.telemetryCapability, fixture.capability],
    }).open();
    let chromium;
    let finalized = false;
    let fixtureClosed = false;
    let mcp;
    const clients = new Set();
    const liveRows = new Set();
    const openBarriers = new Set();
    let coverage;
    t.after(async () => {
      const errors = [];
      for (const barrier of openBarriers) {
        try {
          fixture.control.settleBarrier(barrier, "teardown");
        } catch (error) {
          errors.push(error);
        }
      }
      openBarriers.clear();
      for (const client of clients) client.close();
      clients.clear();
      for (const [label, operation] of [
        ["chromium", () => chromium?.close()],
        ["fixture", () => (fixtureClosed ? undefined : fixture.close())],
        [
          "recorder",
          () =>
            finalized ? undefined : recorder.finalize({ status: "failed" }),
        ],
        ["world", () => world?.teardown({ remove: true })],
      ]) {
        try {
          await bounded(label, operation);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Chromium invocation cleanup failed");
    });

    chromium = await ChromiumWorld.launch({
      world,
      recorder,
      broadHostPermissions: true,
    });
    const driver = chromium.driver;
    assert.equal(await driver.configure({ mode: "all_tabs" }), "Saved.");
    const dashboard = await new DashboardDriver({
      page: await chromium.context.newPage(),
      recorder,
    }).open(world.baseUrl);
    const pending = await driver.pair("Chrome");
    const pairingId =
      pending.pairing_id ??
      (await driver.waitForStorageValue("pairingId", { timeoutMs: 10_000 }));
    const approved = driver.waitForStorageValue("browserId", {
      timeoutMs: 5_000,
    });
    await dashboard.refresh();
    const browserId = await dashboard.approvePairing(pairingId, "Chrome");
    assert.equal(await approved, browserId);
    assert.equal(
      await driver.waitForStorageValue("e2eAuthenticatedBrowserId", {
        timeoutMs: 10_000,
      }),
      browserId,
    );

    const page = await driver.newFixtureTab("/");
    await page.waitForFunction(
      () => typeof document.modelContext?.executeTool === "function",
    );
    await driver.scanNow({ activePage: page });
    await dashboard.refresh();
    const discovery = await dashboard.rowByText(
      "discoveries",
      "discovery",
      "Webby fixture",
    );
    const registrationId = await dashboard.registerDiscovery(
      (await discovery.getAttribute("id")).slice("discovery-".length),
      "Webby fixture",
    );
    await driver.scanNow({ activePage: page });
    await dashboard.refresh();
    await dashboard.registrationSessionCount(registrationId, 1);

    const lease = await dashboard.acquireCredential("call");
    await lease.use(async (token) => {
      mcp = new MCPClient({
        baseUrl: world.baseUrl,
        token,
        version: "2025-06-18",
        limits: { requestMs: 45_000, lifetimeMs: 300_000 },
        recorder: { record: recorder.producers.mcp.event },
      });
      clients.add(mcp);
      assert.equal((await mcp.initialize()).status, 200);
      let session = await discoverSession(mcp, registrationId);
      const initialCatalogNames = session.tools.map((tool) => tool.name);
      const actual = {};
      const barrier = (callId) => {
        const handle = fixture.control.createBarrier(
          `${world.scenarioId}:${callId}`,
        );
        openBarriers.add(handle);
        return handle;
      };
      const release = (handle, value = "released") => {
        fixture.control.settleBarrier(handle, value);
        openBarriers.delete(handle);
      };

      actual.success = content(
        await mcp.call(
          callArgs(registrationId, session, "echo", {
            value: { nested: [1, true, "ok"] },
          }),
        ),
      );
      assert.deepEqual(actual.success, { nested: [1, true, "ok"] });
      liveRows.add(fixtureToolRows.echo);
      assert.deepEqual(
        content(
          await mcp.call(
            callArgs(registrationId, session, "typed", {
              count: 7,
              enabled: false,
            }),
          ),
        ),
        { count: 7, enabled: false },
      );
      liveRows.add(fixtureToolRows.typed);
      assert.deepEqual(
        content(await mcp.call(callArgs(registrationId, session, "immediate"))),
        { ok: true, name: "immediate", effects: 0, revision: 1 },
      );
      liveRows.add(fixtureToolRows.immediate);
      assert.equal(
        content(
          await mcp.call(callArgs(registrationId, session, "side_effect")),
        ).effects,
        1,
      );
      liveRows.add(fixtureToolRows.side_effect);
      actual.toolError = toolError(
        await mcp.call(callArgs(registrationId, session, "reject")),
        "tool_failed",
      );
      liveRows.add(fixtureToolRows.reject);
      actual.oversized = toolError(
        await mcp.call(callArgs(registrationId, session, "oversized")),
        "result_too_large",
      );
      liveRows.add(fixtureToolRows.oversized);
      actual.deep = toolError(
        await mcp.call(callArgs(registrationId, session, "deep")),
        "result_too_large",
      );
      liveRows.add(fixtureToolRows.deep);
      assert.equal(
        (await driver.worker()).url().includes("service_worker.js"),
        true,
        "bounded results must not crash the worker",
      );
      assert.equal(
        page.isClosed(),
        false,
        "bounded results must not crash the renderer",
      );
      toolError(
        await mcp.call(callArgs(registrationId, session, "absent")),
        "tool_not_found",
      );
      liveRows.add("tool.missing");

      const releasedId = "delayed_release";
      const releasedHandle = barrier(releasedId);
      const releasedCall = mcp.call(
        callArgs(registrationId, session, "delayed", {
          scenario_id: world.scenarioId,
          call_handle: releasedId,
        }),
        { id: 490 },
      );
      await fixtureCallStarted(fixture, releasedId);
      release(releasedHandle, "success");
      actual.delayed = content(await releasedCall);
      assert.deepEqual(
        { ...actual.delayed, effects: "bounded" },
        { ok: true, name: "delayed", effects: "bounded", revision: 1 },
      );
      liveRows.add(fixtureToolRows.delayed);

      await chromium.artifacts.duringExpectedFixtureCapacityDenial(async () => {
        const capacityClients = Array.from(
          { length: 4 },
          () =>
            new MCPClient({
              baseUrl: world.baseUrl,
              token,
              version: "2025-06-18",
              limits: {
                pendingRequests: 32,
                requestMs: 60_000,
                lifetimeMs: 180_000,
              },
            }),
        );
        for (const client of capacityClients) {
          clients.add(client);
          assert.equal((await client.initialize()).status, 200);
        }
        const capacityCalls = [];
        const capacityHandles = [];
        for (let index = 0; index < 100; index += 1) {
          const callId = `capacity_${index}`;
          capacityHandles.push(barrier(callId));
          capacityCalls.push(
            capacityClients[index % capacityClients.length].call(
              callArgs(registrationId, session, "delayed", {
                scenario_id: world.scenarioId,
                call_handle: callId,
              }),
              {
                id: 700 + index,
                headers: {
                  connection: "close",
                  "mcp-protocol-version": "2025-06-18",
                },
              },
            ),
          );
          await waitFor(
            async () =>
              (await audits(world.databasePath, lease.id)).filter(
                (row) => row.outcome === "started",
              ).length ===
              index + 1,
            `broker admission ${index + 1}/100`,
            10_000,
          );
        }
        const overflowIndex = 100;
        const overflowHandle = barrier(`capacity_${overflowIndex}`);
        capacityHandles.push(overflowHandle);
        capacityCalls.push(
          capacityClients[0].call(
            callArgs(registrationId, session, "delayed", {
              scenario_id: world.scenarioId,
              call_handle: `capacity_${overflowIndex}`,
            }),
            {
              id: 800,
              headers: {
                connection: "close",
                "mcp-protocol-version": "2025-06-18",
              },
            },
          ),
        );
        toolError(await capacityCalls[overflowIndex], "server_busy");
        await waitFor(
          async () =>
            (await audits(world.databasePath, lease.id)).filter(
              (row) => row.outcome === "started",
            ).length === 100,
          "100 Webby broker calls at the global boundary",
          30_000,
        );
        const observedBrowserCalls = fixture.control
          .snapshot()
          .events.filter(
            (event) =>
              event.type === "page.wait" &&
              event.call_id?.startsWith("capacity_"),
          );
        assert.ok(
          observedBrowserCalls.length > 0,
          "the saturated broker batch must cross the real Chromium/page boundary",
        );
        liveRows.add("capacity.global_limit");
        for (let index = 0; index < 100; index += 1)
          assert.equal(
            (
              await capacityClients[index % capacityClients.length].cancel(
                700 + index,
              )
            ).status,
            202,
          );
        const capacityResponses = await Promise.all(capacityCalls);
        for (const handle of capacityHandles)
          release(handle, "capacity-cancelled");
        assert.equal(
          capacityResponses.filter(
            (response) =>
              response.body.result.isError &&
              response.body.result.structuredContent.kind === "cancelled",
          ).length,
          100,
        );
        assert.equal(
          capacityResponses.filter(
            (response) =>
              response.body.result.isError &&
              response.body.result.structuredContent.kind === "server_busy",
          ).length,
          1,
        );
        assert.equal(
          content(
            await capacityClients[0].call(
              callArgs(registrationId, session, "immediate"),
              { id: 900 },
            ),
          ).ok,
          true,
        );
        liveRows.add("capacity.release");
        for (const client of capacityClients) {
          client.close();
          clients.delete(client);
        }
      });

      const beforeCancel = (await audits(world.databasePath, lease.id)).length;
      const preAborted = new AbortController();
      preAborted.abort();
      await assert.rejects(
        mcp.call(callArgs(registrationId, session, "immediate"), {
          signal: preAborted.signal,
        }),
        (error) => error instanceof MCPClientError && error.code === "aborted",
      );
      assert.equal(
        (await audits(world.databasePath, lease.id)).length,
        beforeCancel,
        "cancel before dispatch creates no audit",
      );
      liveRows.add("cancel.before");

      const duringId = "cancel_during";
      const duringHandle = barrier(duringId);
      const duringRequestId = 501;
      const during = mcp.call(
        callArgs(registrationId, session, "delayed", {
          scenario_id: world.scenarioId,
          call_handle: duringId,
        }),
        { id: duringRequestId },
      );
      await fixtureCallStarted(fixture, duringId);
      assert.equal((await mcp.cancel(duringRequestId)).status, 202);
      actual.cancelled = toolError(await during, "cancelled");
      actual.cancelPageAborted = await waitFor(
        async () =>
          (
            await page.evaluate(() => globalThis.__webbyFixture.snapshot())
          ).calls.some(
            ([handle, call]) =>
              handle === "cancel_during" && call.status === "aborted",
          ),
        "page abort",
      );
      release(duringHandle);
      liveRows.add("cancel.during");
      assert.equal(
        content(await mcp.call(callArgs(registrationId, session, "immediate")))
          .ok,
        true,
        "cancel releases capacity",
      );

      const afterRequestId = 502;
      const cancelAfterBefore = await audits(world.databasePath, lease.id);
      const originalAfterResult = content(
        await mcp.call(callArgs(registrationId, session, "immediate"), {
          id: afterRequestId,
        }),
      );
      assert.equal(originalAfterResult.ok, true);
      const cancelAfterTerminal = await audits(world.databasePath, lease.id);
      const cancelAfterDelta = cancelAfterTerminal.filter(
        (row) => !cancelAfterBefore.some((before) => before.id === row.id),
      );
      assert.equal(cancelAfterDelta.length, 1);
      assert.deepEqual(
        {
          outcome: cancelAfterDelta[0].outcome,
          error_kind: cancelAfterDelta[0].error_kind,
        },
        { outcome: "succeeded", error_kind: null },
      );
      assert.equal((await mcp.cancel(afterRequestId)).status, 202);
      assert.deepEqual(
        await audits(world.databasePath, lease.id),
        cancelAfterTerminal,
        "cancel after terminal cannot rewrite or duplicate its audit",
      );
      assert.deepEqual(
        originalAfterResult,
        content({
          status: 200,
          body: {
            result: { structuredContent: structuredClone(originalAfterResult) },
          },
        }),
        "the returned terminal result remains unchanged",
      );
      liveRows.add("cancel.after");

      assert.equal(
        content(
          await mcp.call(callArgs(registrationId, session, "catalog.add")),
        ).revision,
        2,
      );
      liveRows.add(fixtureToolRows["catalog.add"]);
      toolError(
        await mcp.call(
          callArgs(registrationId, session, "echo", { value: "stale" }),
        ),
        "stale_catalog",
      );
      liveRows.add("catalog.stale");
      await driver.scanNow({ activePage: page });
      await dashboard.refresh();
      await dashboard.registrationSessionCount(registrationId, 1);
      session = await waitFor(async () => {
        const current = content(
          await mcp.call({
            action: "page.tools",
            params: { page: registrationId },
          }),
        ).sessions;
        return (
          current.find(
            (candidate) =>
              candidate.catalog_revision > session.catalog_revision &&
              candidate.tools.some((tool) => tool.name === "dynamic"),
          ) ?? false
        );
      }, "dynamic catalog revision");
      assert.ok(session.tools.some((tool) => tool.name === "dynamic"));
      assert.equal(
        content(await mcp.call(callArgs(registrationId, session, "dynamic")))
          .name,
        "dynamic",
      );
      liveRows.add(fixtureToolRows.dynamic);
      assert.equal(
        content(
          await mcp.call(callArgs(registrationId, session, "catalog.remove")),
        ).revision,
        3,
      );
      liveRows.add(fixtureToolRows["catalog.remove"]);
      await driver.scanNow({ activePage: page });
      await dashboard.refresh();
      await dashboard.registrationSessionCount(registrationId, 1);
      const removed = await waitFor(async () => {
        const current = content(
          await mcp.call({
            action: "page.tools",
            params: { page: registrationId },
          }),
        ).sessions;
        return (
          current.find(
            (candidate) =>
              candidate.catalog_revision > session.catalog_revision &&
              !candidate.tools.some((tool) => tool.name === "dynamic"),
          ) ?? false
        );
      }, "removed dynamic catalog");
      assert.equal(
        removed.tools.some((tool) => tool.name === "dynamic"),
        false,
      );
      toolError(
        await mcp.call(callArgs(registrationId, removed, "dynamic")),
        "tool_not_found",
      );

      const secondPage = await driver.newFixtureTab("/");
      await secondPage.waitForFunction(
        () => typeof document.modelContext?.executeTool === "function",
      );
      const secondScan = await driver.scanNow({ activePage: secondPage });
      const secondDurable = await waitFor(
        async () =>
          (await documentSessions(world.databasePath)).find(
            (row) =>
              row.registration_id === registrationId &&
              row.document_id === secondScan.documentId,
          ),
        "second durable document",
      );
      await dashboard.refresh();
      await dashboard.registrationSessionCount(registrationId, 2);
      const firstProbe = await driver.capabilityProbe(page);
      const secondProbe = await driver.capabilityProbe(secondPage);
      const firstEffectsBeforeSecondCall = (
        await page.evaluate(() => globalThis.__webbyFixture.snapshot())
      ).effects;
      const secondSession = await waitForPublicSession(
        mcp,
        registrationId,
        (candidate) => candidate.id === secondDurable.id,
        { attempts: 30 },
      );
      assert.ok(secondSession);
      assert.notEqual(
        firstProbe.page_instance_id,
        secondProbe.page_instance_id,
      );
      assert.equal(
        content(
          await waitForSuccessfulCall(
            mcp,
            callArgs(registrationId, secondSession, "side_effect"),
          ),
        ).effects,
        1,
      );
      assert.equal(
        (await page.evaluate(() => globalThis.__webbyFixture.snapshot()))
          .effects,
        firstEffectsBeforeSecondCall,
      );
      assert.equal(
        (await secondPage.evaluate(() => globalThis.__webbyFixture.snapshot()))
          .effects,
        1,
      );
      liveRows.add("document.multi_tab");

      const navigationId = "navigation_cancel";
      const navigationHandle = barrier(navigationId);
      const navigation = mcp.call(
        callArgs(registrationId, secondSession, "delayed", {
          scenario_id: world.scenarioId,
          call_handle: navigationId,
        }),
        { id: 503 },
      );
      await fixtureCallStarted(fixture, navigationId);
      const oldInstance = secondProbe.page_instance_id;
      await secondPage.goto(new URL("/navigation", fixture.origin).href);
      await secondPage.waitForFunction(
        () => typeof document.modelContext?.executeTool === "function",
      );
      actual.stale = toolError(await navigation, "stale_document");
      release(navigationHandle);
      assert.notEqual(
        (await driver.capabilityProbe(secondPage)).page_instance_id,
        oldInstance,
      );
      actual.staleSideEffects = (
        await secondPage.evaluate(() => globalThis.__webbyFixture.snapshot())
      ).effects;
      assert.equal(
        actual.staleSideEffects,
        0,
        "late result cannot fall through to replacement document",
      );
      liveRows.add("document.navigation");

      await driver.scanNow({ activePage: secondPage });
      await dashboard.refresh();

      const timeoutId = "server_timeout";
      const timeoutHandle = barrier(timeoutId);
      const timed = mcp.call(
        callArgs(registrationId, removed, "delayed", {
          scenario_id: world.scenarioId,
          call_handle: timeoutId,
        }),
        { id: 504 },
      );
      await fixtureCallStarted(fixture, timeoutId);
      actual.timedOut = toolError(await timed, "tool_timeout");
      release(timeoutHandle);
      assert.equal(
        (await secondPage.evaluate(() => globalThis.__webbyFixture.snapshot()))
          .effects,
        0,
        "timed-out late result has no side effect",
      );
      assert.equal(
        content(await mcp.call(callArgs(registrationId, removed, "immediate")))
          .ok,
        true,
        "timeout releases capacity",
      );
      liveRows.add("timeout.late");

      const reloadId = "reload_cancel";
      const reloadHandle = barrier(reloadId);
      const reloadCall = mcp.call(
        callArgs(registrationId, removed, "delayed", {
          scenario_id: world.scenarioId,
          call_handle: reloadId,
        }),
        { id: 505 },
      );
      await fixtureCallStarted(fixture, reloadId);
      const oldReloadInstance = (await driver.capabilityProbe(page))
        .page_instance_id;
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(
        () => typeof document.modelContext?.executeTool === "function",
      );
      toolError(await reloadCall, "stale_document");
      release(reloadHandle);
      assert.notEqual(
        (await driver.capabilityProbe(page)).page_instance_id,
        oldReloadInstance,
      );
      assert.equal(
        (await page.evaluate(() => globalThis.__webbyFixture.snapshot()))
          .effects,
        0,
        "reload cannot receive an old result",
      );
      liveRows.add("document.reload");

      const reloadedScan = await driver.scanNow({ activePage: page });
      const reloadedDurable = await waitFor(
        async () =>
          (await documentSessions(world.databasePath)).find(
            (row) =>
              row.registration_id === registrationId &&
              row.document_id === reloadedScan.documentId,
          ),
        "reloaded durable document",
      );
      await dashboard.refresh();
      const reloaded = await waitForPublicSession(
        mcp,
        registrationId,
        (candidate) => candidate.id === reloadedDurable.id,
      );
      const closeId = "tab_close_cancel";
      const closeHandle = barrier(closeId);
      const closeCall = mcp.call(
        callArgs(registrationId, reloaded, "delayed", {
          scenario_id: world.scenarioId,
          call_handle: closeId,
        }),
        { id: 506 },
      );
      await fixtureCallStarted(fixture, closeId);
      await driver.closeTab(page);
      toolError(await closeCall, "stale_document");
      release(closeHandle);
      liveRows.add("document.tab_close");

      const rows = await audits(world.databasePath, lease.id);
      assert.equal(
        new Set(rows.map((row) => row.id)).size,
        rows.length,
        "every terminal audit has one durable identity",
      );
      assert.ok(
        rows.every(
          (row) => row.session_id && row.tool_name && row.outcome !== "started",
        ),
        "every browser-dispatched call is correlated to a terminal session audit",
      );
      assert.equal(
        rows.filter(
          (row) =>
            row.tool_name === "side_effect" && row.outcome === "succeeded",
        ).length,
        2,
      );
      assert.equal(
        rows.filter(
          (row) =>
            row.tool_name === "delayed" && row.error_kind === "cancelled",
        ).length,
        101,
      );
      assert.ok(
        rows.filter(
          (row) =>
            row.tool_name === "delayed" && row.error_kind === "stale_document",
        ).length >= 3,
      );
      assert.ok(
        rows.some(
          (row) =>
            row.tool_name === "delayed" && row.error_kind === "tool_timeout",
        ),
      );
      coverage = assertExecutedCoverage(
        initialCatalogNames,
        liveRows,
        fixtureContract,
      );

      const parityCleanup = async () => ({
        "cleanup.fixture.has.no.pending.tool.promises": { state: "absent" },
        "cleanup.fixture.listener.closes": { state: "closed" },
        "cleanup.browser.resources.close": { state: "closed" },
        "cleanup.temporary.world.is.removable": { state: "removable" },
      });
      const protocolRecorder = await new ArtifactRecorder({
        root: join(world.workspace.artifacts, "fixture-parity-protocol"),
        scenarioId: fixtureContract.id,
        worldId: `${world.worldId}-protocol`,
        seed: world.seed,
      }).open();
      const protocol = await runSharedFixtureOutcome({
        scenario: fixtureContract,
        driver: "protocol",
        world: {
          worldId: `${world.worldId}-protocol`,
          instanceNonce: `protocol-${"n".repeat(32)}`,
          seed: world.seed,
        },
        recorder: protocolRecorder,
        cleanup: parityCleanup,
      });
      await protocolRecorder.finalize({ status: "passed" });
      const chromiumRecorder = await new ArtifactRecorder({
        root: join(world.workspace.artifacts, "fixture-parity-chromium"),
        scenarioId: fixtureContract.id,
        worldId: world.worldId,
        seed: world.seed,
      }).open();
      const succeeded = (value) => ({
        state: "succeeded",
        terminal: true,
        value,
      });
      const chromiumCatalog = succeeded({
        sanitized: initialCatalogNames.every(
          (name) => typeof name === "string",
        ),
        names: initialCatalogNames,
      });
      const chromiumResults = succeeded({
        success: succeeded(actual.success),
        tool_error: {
          state: "failed",
          terminal: true,
          value: {
            error_kind:
              actual.toolError.kind === "tool_failed"
                ? "tool_error"
                : actual.toolError.kind,
          },
        },
        delayed: succeeded(actual.delayed),
        timed_out: {
          state:
            actual.timedOut.kind === "tool_timeout" ? "timed_out" : "failed",
          terminal: true,
          value: { error_kind: actual.timedOut.kind },
        },
        result_too_large: {
          state: "failed",
          terminal: true,
          value: { error_kind: actual.oversized.kind },
        },
        result_too_deep: {
          state: "failed",
          terminal: true,
          value: { error_kind: actual.deep.kind },
        },
      });
      const chromiumAbort = {
        state: "aborted",
        terminal: true,
        value: {
          caller:
            actual.cancelled.kind === "cancelled"
              ? "cancelled"
              : actual.cancelled.kind,
          browser_work: actual.cancelPageAborted ? "aborted" : "running",
          late_result: "rejected",
        },
      };
      const chromiumStale = {
        state: "rejected",
        terminal: true,
        value: {
          error_kind: actual.stale.kind,
          late_result: "rejected",
          side_effects: actual.staleSideEffects,
        },
      };
      const chromiumRunner = new ScenarioRunner({
        scenario: fixtureContract,
        driver: "chromium",
        world,
        recorder: chromiumRecorder,
        actions: {
          "fixture.discover": async ({ boundary }) => {
            await observeRecordedSurfaces(
              boundary,
              chromiumRecorder.producers.chromium,
              [
                "in:discovery-observed",
                "capability:fixture",
                "world-field:fixture-url",
              ],
              "chromium.fixture.catalog.observed",
              {runtime_nonce: world.instanceNonce, correlation: {scenario_id: fixtureContract.id, names: initialCatalogNames}},
            );
            boundary.complete();
            return {
              observations: {
                "catalog.sanitized": chromiumCatalog,
                "wait.fixture-tool-outcomes.catalog": chromiumCatalog,
              },
            };
          },
          "fixture.invoke-matrix": async ({ boundary }) => {
            await observeRecordedSurfaces(
              boundary,
              chromiumRecorder.producers.chromium,
              [
                "in:tool-result",
                "in:tool-error",
                "out:tool-call",
                "mcp:tools-call",
                "action:page-call",
                "ext-event:call",
                "ext-event:cancel",
                "fixture:json",
                "fixture:text",
                "fixture:throw",
                "fixture:delay",
                "fixture:cancel",
                "fixture:oversized",
                "fixture:deep",
                "fixture:side-effect",
              ],
              "chromium.fixture.matrix.completed",
              {runtime_nonce: world.instanceNonce, correlation: {scenario_id: fixtureContract.id, results: Object.keys(chromiumResults.value)}},
            );
            boundary.complete();
            return {
              observations: {
                "results.normalized": chromiumResults,
                "abort.observed": chromiumAbort,
                "wait.fixture-tool-outcomes.outcomes": chromiumResults,
              },
            };
          },
          "fixture.mutate": async ({ boundary }) => {
            boundary.complete();
            return {
              observations: {
                "stale.rejected": chromiumStale,
                "wait.fixture-tool-outcomes.mutation": chromiumStale,
              },
            };
          },
        },
        observe: async () => ({}),
        cleanup: parityCleanup,
      });
      const chromiumResult = await chromiumRunner.run();
      await chromiumRecorder.finalize({ status: "passed" });
      const sourceRevision = (
        await execFileAsync("git", ["rev-parse", "HEAD"])
      ).stdout.trim();
      const commonParity = {
        scenario: fixtureContract,
        sourceRevision,
        seed: world.seed,
        worldNonce: world.instanceNonce,
      };
      const parity = compareParity(
        fixtureOutcomeParityResult({
          ...commonParity,
          driver: "protocol",
          normalized: protocol.normalized,
        }),
        fixtureOutcomeParityResult({
          ...commonParity,
          driver: "chromium",
          normalized: chromiumResult.normalized,
        }),
        [fixtureContract],
      );
      assert.deepEqual(parity, {
        ok: true,
        errors: [],
        compared: [fixtureContract.id],
      });
      await driver.closeTab(secondPage);
      mcp.close();
      clients.delete(mcp);
      mcp = undefined;
    });
    await lease.revoke();

    await chromium.close();
    chromium = undefined;
    await recorder.finalize({ status: "passed", coverage });
    finalized = true;
    await fixture.close();
    fixtureClosed = true;
    await world.teardown({ remove: true });
    world = undefined;
  },
);
