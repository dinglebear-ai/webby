import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {promisify} from "node:util"
import {join} from "node:path"
import {ArtifactRecorder} from "./artifacts.js"
import {MCPClient} from "./mcp-client.js"
import {processExists} from "./process-tree.js"
import {openFileHandles} from "./temp-workspace.js"
import {observeVerifiedSurfaces} from "./boundary-surfaces.js"

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
      "health.request": context => this.health(context),
      "browser.pair": context => this.pair(context),
      "discovery.publish": context => this.discover(context),
      "credential.create": context => this.credential(context),
      "mcp.invoke": context => this.invoke(context),
      "audit.observe": context => this.audit(context),
    }
  }

  async prepare() {
    assert.equal(await this.chromium.driver.configure({mode: "all_tabs"}), "Saved.")
  }

  async health({boundary}) {
    const root = await fetch(this.world.baseUrl)
    assert.equal(root.ok, true)
    const response = await fetch(`${this.world.baseUrl}/health`)
    assert.equal(response.ok, true)
    const ready = {state: response.ok ? "ready" : "failed", value: response.ok}
    observeVerifiedSurfaces(boundary, ["http:get-root", "http:get-health", "behavior:health"], "successful live root and health responses")
    const manifest = this.world.manifest
    assert.equal(manifest.manifest_version, 1); assert.equal(manifest.world_id, this.world.worldId); assert.equal(manifest.scenario_id, this.scenario.id)
    assert.equal(manifest.base_url, this.world.baseUrl); assert.ok(manifest.instance_nonce.length >= 32); assert.ok(manifest.artifact_directory)
    const proof = await new ArtifactRecorder({root: join(this.world.workspace.artifacts, "health-artifact-proof"), scenarioId: this.scenario.id, worldId: `${this.world.worldId}-health-proof`}).open()
    await proof.producers.world.event("health.boundary.verified", {status: response.status})
    await proof.producers.world.artifact(this.world.manifestPath, {name: "world-manifest-live.json", kind: "manifest", essential: true})
    const attested = await proof.finalize({status: "passed"})
    assert.ok(attested.attestation.files.some(file => file.path.endsWith("events.ndjson")))
    assert.ok(attested.attestation.files.some(file => file.path.endsWith("world-manifest-live.json")))
    observeVerifiedSurfaces(boundary, ["capability:world-nonce", "world-field:manifest-version", "world-field:world-id", "world-field:base-url", "world-field:artifacts", "world-field:scenario-id"], "validated live world manifest fields")
    observeVerifiedSurfaces(boundary, ["artifact:timeline", "artifact:manifest"], `artifact attestation ${attested.attestation.attestation_sha256}`)
    boundary.complete()
    return {handles: {world: this.world.worldId}, observations: {"health.ready": ready, "wait.shared-vertical-slice.health": ready}}
  }

  async pair({boundary}) {
    const pending = await this.chromium.driver.pair("Chrome")
    const pairingEvents = await this.chromium.driver.protocolEvents()
    await this.chromium.driver.suspendAndReacquireWorker()
    await this.chromium.driver.waitForProtocolReply("pairing.status", 0, {timeoutMs: 10_000})
    assert.equal(await this.chromium.driver.waitForStorageValue("pairingId"), pending.pairing_id)
    const pairingSocketAttempts = await this.chromium.driver.socketAttempts()
    const approved = this.chromium.driver.waitForStorageValue("browserId", {timeoutMs: 2_000})
    await this.dashboard.refresh()
    this.browserId = await this.dashboard.approvePairing(pending.pairing_id, "Chrome")
    const storedBrowserId = await approved
    assert.equal(storedBrowserId, this.browserId)
    await this.chromium.driver.waitForSocketAttempts(pairingSocketAttempts + 1)
    assert.equal(await this.chromium.driver.waitForStorageValue("e2eAuthenticatedBrowserId", {timeoutMs: 5_000}), this.browserId)
    const authenticated = {state: "recovered", value: true}
    const events = [...pairingEvents, ...await this.chromium.driver.protocolEvents()]
    const request = type => events.findLast(event => event.direction === "out" && event.type === type)
    const reply = outbound => outbound && events.find(event => event.direction === "in" && event.ref === outbound.ref && event.status === "ok")
    const pairingRequest = request("pairing.request"), pairingStatus = request("pairing.status"), authResponse = request("auth.respond"), hello = request("browser.hello")
    for (const [name, value] of Object.entries({pairingRequest, pairingStatus, authResponse, hello})) assert.ok(value?.sequence, `${name} producer token is missing`)
    for (const outbound of [pairingRequest, pairingStatus, authResponse, hello]) assert.ok(reply(outbound)?.sequence, `${outbound.type} reply token is missing`)
    observeVerifiedSurfaces(boundary, ["topic:pairing"], `pairing socket attempt ${pairingSocketAttempts}`)
    observeVerifiedSurfaces(boundary, ["in:pairing-request", "out:pairing-pending"], `protocol request/reply ${pairingRequest.sequence}/${reply(pairingRequest).sequence}`)
    observeVerifiedSurfaces(boundary, ["in:pairing-status", "out:pairing-status"], `protocol request/reply ${pairingStatus.sequence}/${reply(pairingStatus).sequence}`)
    observeVerifiedSurfaces(boundary, ["dashboard:approve", "out:pairing-approved"], `dashboard persisted browser ${this.browserId}`)
    observeVerifiedSurfaces(boundary, ["topic:auth", "out:auth-challenge", "in:auth-respond", "out:auth-accepted"], `authenticated socket request/reply ${authResponse.sequence}/${reply(authResponse).sequence}`)
    observeVerifiedSurfaces(boundary, ["in:browser-hello", "out:browser-welcome"], `hello request/reply ${hello.sequence}/${reply(hello).sequence}`)
    boundary.complete()
    return {handles: {pairing: pending.pairing_id, browser: this.browserId}, observations: {
      "browser.authenticated": authenticated,
      "wait.shared-vertical-slice.pair": {state: "succeeded", terminal: true, value: this.browserId},
    }}
  }

  async discover({boundary}) {
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
    const protocolEvents = await this.chromium.driver.protocolEvents()
    const resync = protocolEvents.findLast(event => event.direction === "out" && event.type === "browser.resync")
    const discoveryObserved = protocolEvents.findLast(event => event.direction === "out" && event.type === "discovery.observed")
    const acknowledgement = discoveryObserved && protocolEvents.find(event => event.direction === "in" && event.ref === discoveryObserved.ref && event.status === "ok")
    assert.ok(resync?.sequence); assert.ok(discoveryObserved?.sequence); assert.ok(acknowledgement?.sequence)
    observeVerifiedSurfaces(boundary, ["in:browser-resync"], `extension protocol event ${resync.sequence} sent browser.resync`)
    observeVerifiedSurfaces(boundary, ["in:discovery-observed"], `extension protocol event ${discoveryObserved.sequence} sent discovery.observed`)
    observeVerifiedSurfaces(boundary, ["out:ack"], `extension protocol event ${acknowledgement.sequence} acknowledged discovery ref ${discoveryObserved.ref}`)
    observeVerifiedSurfaces(boundary, ["dashboard:register"], `dashboard registered discovery ${this.discoveryId} as ${this.registrationId}`)
    boundary.complete()
    return {handles: {page: this.registrationId, document: probe.page_instance_id, session: `${storage.browserId}:${probe.tab_id}:${probe.page_instance_id}`}, observations: {
      "page.available": available, "wait.shared-vertical-slice.discover": available,
    }}
  }

  async credential({boundary}) {
    this.credentialLease = await this.dashboard.acquireCredential("call")
    this.credentialId = this.credentialLease.id
    observeVerifiedSurfaces(boundary, ["dashboard:create-credential"], "dashboard created a scoped credential lease")
    boundary.complete()
    return {handles: {credential: this.credentialId}, observations: {"wait.shared-vertical-slice.credential": {state: "present", value: true}}}
  }

  async invoke({handles, boundary}) {
    return this.credentialLease.use(async token => {
      assert.equal(handles.get("browser", "browser"), this.browserId)
      assert.equal(handles.get("credential", "credential"), this.credentialId)
      for (const [version, surfaceId] of [["2026-07-28", "version:2026"], ["2025-11-25", "version:2025-11"], ["2025-06-18", "version:2025-06"], ["2025-03-26", "version:2025-03"]]) {
        const compatibility = new MCPClient({baseUrl: this.world.baseUrl, token, version})
        try { assert.equal((await compatibility.initialize()).status, 200); observeVerifiedSurfaces(boundary, [surfaceId], `negotiated MCP ${version}`) }
        finally { compatibility.close() }
      }
      this.mcp = new MCPClient({baseUrl: this.world.baseUrl, token, version: this.mcpVersion, recorder: {record: this.recorder.producers.mcp.event}})
      const initialized = await this.mcp.initialize()
      assert.equal(initialized.status, 200)
      assert.equal((await this.mcp.listTools()).status, 200)
      assert.equal((await this.mcp.call({action: "status"})).status, 200)
      assert.equal((await this.mcp.call({action: "browser.list"})).status, 200)
      assert.equal((await this.mcp.call({action: "discovery.list"})).status, 200)
      assert.equal((await this.mcp.call({action: "discovery.get", params: {discovery: this.discoveryId}})).status, 200)
      const pages = await this.mcp.call({action: "page.list"})
      const pageList = pages.body.result.structuredContent ?? JSON.parse(pages.body.result.content[0].text)
      assert.equal(pageList.find(item => item.id === this.registrationId)?.available, true)
      assert.equal((await this.mcp.call({action: "page.get", params: {page: this.registrationId}})).status, 200)
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
      observeVerifiedSurfaces(boundary, ["http:post-mcp", "in:tool-result", "out:tool-call", "mcp:initialize", "mcp:tools-list", "mcp:tools-call", "mcp:initialized", "action:status", "action:browser-list", "action:discovery-list", "action:discovery-get", "action:page-list", "action:page-get", "action:page-tools", "action:page-call", "fixture:side-effect"], "live MCP initialization, list/get actions, invocation, browser result, and fixture side effect succeeded")
      this.callResponse = response
      this.mcp.close(); this.mcp.token = undefined
      boundary.complete()
      return {handles: {call: `chromium:${session.id}:echo`}, observations: {
        "call.succeeded": {state: "succeeded", terminal: true, value: effect},
        "wait.shared-vertical-slice.invoke": {state: "present", value: true},
      }}
    })
  }

  async audit({boundary}) {
    const audits = await sqlite(this.world.databasePath, `SELECT id, credential_id, browser_id, registration_id, outcome, tool_name FROM invocation_audits WHERE credential_id='${this.credentialId}'`)
    assert.equal(audits.length, 1); assert.equal(audits[0].browser_id, this.browserId)
    assert.equal(audits[0].registration_id, this.registrationId); assert.equal(audits[0].outcome, "succeeded"); assert.equal(audits[0].tool_name, "echo")
    this.auditId = audits[0].id
    const dashboardArtifact = await this.chromium.screenshot(this.dashboard.page, "dashboard-snapshot.png")
    assert.ok(dashboardArtifact?.sha256 && !dashboardArtifact.omitted)
    const proof = await new ArtifactRecorder({root: join(this.world.workspace.artifacts, "audit-artifact-proof"), scenarioId: this.scenario.id, worldId: `${this.world.worldId}-audit-proof`}).open()
    await proof.producers.world.artifact(this.world.stdoutPath, {name: "server-stdout-live.log", kind: "log", essential: true})
    await proof.producers.chromium.artifact(dashboardArtifact.staged, {name: "dashboard-snapshot.png", kind: "screenshot", essential: true})
    const attested = await proof.finalize({status: "passed"})
    assert.ok(attested.attestation.files.some(file => file.path.endsWith("server-stdout-live.log")))
    assert.ok(attested.attestation.files.some(file => file.path.endsWith("dashboard-snapshot.png")))
    observeVerifiedSurfaces(boundary, ["artifact:server-log", "artifact:dashboard"], `artifact attestation ${attested.attestation.attestation_sha256}`)
    boundary.complete()
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
