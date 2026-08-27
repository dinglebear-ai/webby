import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {promisify} from "node:util"
import {MCPClient} from "./mcp-client.js"
import {processExists} from "./process-tree.js"
import {openFileHandles} from "./temp-workspace.js"

const execFileAsync = promisify(execFile)

async function sqlite(database, sql) {
  return JSON.parse((await execFileAsync("sqlite3", ["-json", database, sql])).stdout || "[]")
}

export const chromiumDeferredInventory = Object.freeze({
  "webby-ihb.17": "pairing, discovery, and popup command surfaces",
  "webby-ihb.18": "invocation cancellation and catalog surfaces",
  "webby-ihb.19": "permission revocation and restart lifecycle",
  "webby-ihb.20": "Chromium capacity, concurrency, and persistence surfaces",
})

export class ChromiumScenarioAdapter {
  constructor({scenario, world, chromium, dashboard, fixture, fixturePage, recorder, mcpVersion = "2025-06-18"}) {
    if (scenario?.id !== "e2e-shared-vertical-slice" || !scenario.drivers?.includes("chromium")) throw new Error("shared Chromium scenario is required")
    if (!world || !chromium?.driver || !dashboard || !fixture?.close || !recorder) throw new Error("live Chromium adapter dependencies are required")
    this.scenario = scenario; this.world = world; this.chromium = chromium; this.dashboard = dashboard
    this.fixture = fixture; this.fixturePage = fixturePage; this.recorder = recorder; this.mcpVersion = mcpVersion
  }

  actions() {
    return {
      "health.request": () => this.health(),
      "browser.pair": () => this.pair(),
      "discovery.publish": () => this.discover(),
      "credential.create": () => this.credential(),
      "mcp.invoke": context => this.invoke(context),
      "audit.observe": () => this.audit(),
    }
  }

  async prepare() {
    assert.equal(await this.chromium.driver.configure({mode: "all_tabs"}), "Saved.")
  }

  async health() {
    const response = await fetch(`${this.world.baseUrl}/health`)
    const ready = {state: response.ok ? "ready" : "failed", value: response.ok}
    return {handles: {world: this.world.worldId}, observations: {"health.ready": ready, "wait.shared-vertical-slice.health": ready}}
  }

  async pair() {
    const pending = await this.chromium.driver.pair("Chrome")
    const pairingSocketAttempts = await this.chromium.driver.socketAttempts()
    const approved = this.chromium.driver.waitForStorageValue("browserId", {timeoutMs: 2_000})
    await this.dashboard.refresh()
    this.browserId = await this.dashboard.approvePairing(pending.pairing_id, "Chrome")
    const storedBrowserId = await approved
    assert.equal(storedBrowserId, this.browserId)
    await this.chromium.driver.waitForSocketAttempts(pairingSocketAttempts + 1)
    assert.equal(await this.chromium.driver.waitForStorageValue("e2eAuthenticatedBrowserId", {timeoutMs: 5_000}), this.browserId)
    const authenticated = {state: "recovered", value: true}
    return {handles: {pairing: pending.pairing_id, browser: this.browserId}, observations: {
      "browser.authenticated": authenticated,
      "wait.shared-vertical-slice.pair": {state: "succeeded", terminal: true, value: this.browserId},
    }}
  }

  async discover() {
    this.fixturePage ??= await this.chromium.driver.newFixtureTab("/")
    await this.fixturePage.bringToFront()
    await this.fixturePage.waitForFunction(() => typeof document.modelContext?.getTools === "function")
    await this.fixturePage.waitForFunction(async () => (await document.modelContext.getTools()).length > 0)
    const initialProbe = await this.chromium.driver.capabilityProbe(this.fixturePage)
    assert.equal(initialProbe.model_context, true)
    assert.ok(await this.fixturePage.evaluate(async () => (await document.modelContext.getTools()).length > 0))
    await this.chromium.driver.scanNow({activePage: this.fixturePage})
    await this.dashboard.refresh()
    const discovery = await this.dashboard.rowByText("discoveries", "discovery", "Webby fixture")
    this.discoveryId = (await discovery.getAttribute("id")).slice("discovery-".length)
    this.registrationId = await this.dashboard.registerDiscovery(this.discoveryId, "Webby fixture")
    await this.chromium.driver.scanNow({activePage: this.fixturePage})
    await this.dashboard.refresh()
    await this.dashboard.registrationSessionCount(this.registrationId, 1)
    const listing = await this.dashboard.row("registration", this.registrationId).textContent()
    assert.match(listing, new RegExp(new URL(this.world.fixtureUrl).origin.replaceAll(".", "\\.")))
    const storage = await this.chromium.driver.storage("browserId")
    const probe = await this.chromium.driver.capabilityProbe(this.fixturePage)
    const available = {state: "present", value: this.registrationId}
    return {handles: {page: this.registrationId, document: probe.page_instance_id, session: `${storage.browserId}:${probe.tab_id}:${probe.page_instance_id}`}, observations: {
      "page.available": available, "wait.shared-vertical-slice.discover": available,
    }}
  }

  async credential() {
    this.credentialLease = await this.dashboard.acquireCredential("call")
    this.credentialId = this.credentialLease.id
    return {handles: {credential: this.credentialId}, observations: {"wait.shared-vertical-slice.credential": {state: "present", value: true}}}
  }

  async invoke({handles}) {
    return this.credentialLease.use(async token => {
      assert.equal(handles.get("browser", "browser"), this.browserId)
      assert.equal(handles.get("credential", "credential"), this.credentialId)
      this.mcp = new MCPClient({baseUrl: this.world.baseUrl, token, version: this.mcpVersion, recorder: {record: this.recorder.producers.mcp.event}})
      const initialized = await this.mcp.initialize()
      assert.equal(initialized.status, 200)
      assert.equal((await this.mcp.listTools()).status, 200)
      const pages = await this.mcp.call({action: "page.list"})
      const pageList = pages.body.result.structuredContent ?? JSON.parse(pages.body.result.content[0].text)
      assert.equal(pageList.find(item => item.id === this.registrationId)?.available, true)
      const tools = await this.mcp.call({action: "page.tools", params: {page: this.registrationId}})
      const session = tools.body.result.structuredContent.sessions[0]
      assert.ok(session.tools.some(tool => tool.name === "echo"))
      const effect = {probe: "chromium-scenario-effect"}
      const response = await this.mcp.call({action: "page.call", params: {page: this.registrationId, session: session.id, tool: "echo", catalog_revision: session.catalog_revision, arguments: {value: effect}}})
      assert.equal(response.body.result.isError, false)
      const terminalResult = response.body.result.structuredContent ?? JSON.parse(response.body.result.content[0].text)
      assert.deepEqual(terminalResult, effect)
      const snapshot = await this.fixturePage.evaluate(() => globalThis.__webbyFixture.snapshot())
      assert.equal(snapshot.calls.filter(([, call]) => call.name === "echo" && call.status === "completed").length, 1)
      this.callResponse = response
      this.mcp.close(); this.mcp.token = undefined
      return {handles: {call: `chromium:${session.id}:echo`}, observations: {
        "call.succeeded": {state: "succeeded", terminal: true, value: effect},
        "wait.shared-vertical-slice.invoke": {state: "present", value: true},
      }}
    })
  }

  async audit() {
    const audits = await sqlite(this.world.databasePath, `SELECT id, credential_id, browser_id, registration_id, outcome, tool_name FROM invocation_audits WHERE credential_id='${this.credentialId}'`)
    assert.equal(audits.length, 1); assert.equal(audits[0].browser_id, this.browserId)
    assert.equal(audits[0].registration_id, this.registrationId); assert.equal(audits[0].outcome, "succeeded"); assert.equal(audits[0].tool_name, "echo")
    this.auditId = audits[0].id
    return {handles: {audit: this.auditId}, observations: {
      "audit.once": {state: "present", value: 1}, "wait.shared-vertical-slice.audit": {state: "present", value: true},
    }}
  }

  async cleanup() {
    this.mcp?.close(); await this.credentialLease?.revoke()
    await this.chromium.screenshot(this.dashboard.page, "dashboard-snapshot.png")
    await this.chromium.close(); this.chromium = undefined
    await this.fixture.close(); this.fixture = undefined
    await this.recorder.producers.world.artifact(this.world.manifestPath, {name: "world-manifest.json", kind: "manifest", essential: true})
    await this.world.teardown({remove: false})
    assert.equal(await processExists(this.world.pid), false)
    await assert.rejects(fetch(`${this.world.baseUrl}/health`, {signal: AbortSignal.timeout(1_000)}))
    assert.deepEqual(await openFileHandles(this.world.workspace.profile), [])
    await this.recorder.producers.world.artifact(this.world.stdoutPath, {name: "server-stdout.log", kind: "log", essential: true})
    await this.recorder.producers.world.artifact(this.world.stderrPath, {name: "server-stderr.log", kind: "log", essential: true})
    return {"cleanup.all.child.processes.exit": {state: "closed"}, "cleanup.all.listeners.close": {state: "closed"}, "cleanup.temporary.database.and.profile.are.removable": {state: "removable"}, "cleanup.no.active.sessions.remain.after.shutdown": {state: "absent"}}
  }
}

export function percentile(samples, quantile) {
  if (!Array.isArray(samples) || samples.length === 0 || samples.some(value => !Number.isFinite(value) || value < 0)) throw new Error("nonempty nonnegative samples are required")
  if (quantile < 0 || quantile > 1) throw new Error("quantile must be between zero and one")
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil((sorted.length - 1) * quantile)]
}

export function chromiumEvidence({startupSamples, world, durationMs, artifactBytes, overflow}) {
  if (!overflow || typeof overflow.occurred !== "boolean" || !overflow.policy) throw new Error("recorder overflow evidence is required")
  return Object.freeze({workers: 1, retries: 0, startup_ms: {sample_count: startupSamples.length, samples: startupSamples, p50: percentile(startupSamples, 0.5), p95: percentile(startupSamples, 0.95)}, peak_rss_kb: world.metrics.peak_rss_kb, disk_bytes: world.metrics.disk_bytes, artifact_bytes: artifactBytes, duration_ms: Math.round(durationMs), recorder_overflow: overflow})
}
