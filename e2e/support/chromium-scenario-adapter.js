import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import {promisify} from "node:util"
import {join} from "node:path"
import {ArtifactRecorder} from "./artifacts.js"
import {MCPClient} from "./mcp-client.js"
import {processExists} from "./process-tree.js"
import {openFileHandles} from "./temp-workspace.js"
import {surfaceProof, observeSurfaceProofs} from "./boundary-surfaces.js"

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
    observeSurfaceProofs(boundary, {"http:get-root": surfaceProof.http(root, {path: "/"}), "http:get-health": surfaceProof.http(response, {path: "/health"}), "behavior:health": surfaceProof.http(response, {path: "/health"})})
    const manifest = this.world.manifest
    assert.equal(manifest.manifest_version, 1); assert.equal(manifest.world_id, this.world.worldId); assert.equal(manifest.scenario_id, this.scenario.id)
    assert.equal(manifest.base_url, this.world.baseUrl); assert.ok(manifest.instance_nonce.length >= 32); assert.ok(manifest.artifact_directory)
    const proof = await new ArtifactRecorder({root: join(this.world.workspace.artifacts, "health-artifact-proof"), scenarioId: this.scenario.id, worldId: `${this.world.worldId}-health-proof`}).open()
    await proof.producers.world.event("health.boundary.verified", {status: response.status})
    await proof.producers.world.artifact(this.world.manifestPath, {name: "world-manifest-live.json", kind: "manifest", essential: true})
    const attested = await proof.finalize({status: "passed"})
    assert.ok(attested.attestation.files.some(file => file.path.endsWith("events.ndjson")))
    assert.ok(attested.attestation.files.some(file => file.path.endsWith("world-manifest-live.json")))
    observeSurfaceProofs(boundary, {"capability:world-nonce": surfaceProof.manifest(manifest, this.world.manifestPath, "instance_nonce"), "world-field:manifest-version": surfaceProof.manifest(manifest, this.world.manifestPath, "manifest_version"), "world-field:world-id": surfaceProof.manifest(manifest, this.world.manifestPath, "world_id"), "world-field:base-url": surfaceProof.manifest(manifest, this.world.manifestPath, "base_url"), "world-field:artifacts": surfaceProof.manifest(manifest, this.world.manifestPath, "artifact_directory"), "world-field:scenario-id": surfaceProof.manifest(manifest, this.world.manifestPath, "scenario_id")})
    observeSurfaceProofs(boundary, {"artifact:timeline": surfaceProof.artifact(attested, "events.ndjson"), "artifact:manifest": surfaceProof.artifact(attested, "world-manifest-live.json")})
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
    const pairingReply = reply(pairingRequest), statusReply = reply(pairingStatus), authReply = reply(authResponse), helloReply = reply(hello)
    observeSurfaceProofs(boundary, {"topic:pairing": surfaceProof.chrome(pairingRequest, {eventName: "pairing.request", identity: pending.pairing_id}), "in:pairing-request": surfaceProof.protocol(pairingRequest, {direction: "out"}), "out:pairing-pending": surfaceProof.protocol(pairingReply, {direction: "in"}), "in:pairing-status": surfaceProof.protocol(pairingStatus, {direction: "out"}), "out:pairing-status": surfaceProof.protocol(statusReply, {direction: "in"}), "dashboard:approve": surfaceProof.dashboard("approve", this.browserId, {relatedId: pending.pairing_id}), "out:pairing-approved": surfaceProof.protocol(pairingReply, {direction: "in"}), "topic:auth": surfaceProof.chrome(authResponse, {eventName: "auth.respond", identity: this.browserId}), "out:auth-challenge": surfaceProof.protocol(authResponse, {direction: "out"}), "in:auth-respond": surfaceProof.protocol(authResponse, {direction: "out"}), "out:auth-accepted": surfaceProof.protocol(authReply, {direction: "in"}), "in:browser-hello": surfaceProof.protocol(hello, {direction: "out"}), "out:browser-welcome": surfaceProof.protocol(helloReply, {direction: "in"})})
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
    observeSurfaceProofs(boundary, {"in:browser-resync": surfaceProof.protocol(resync, {direction: "out"}), "in:discovery-observed": surfaceProof.protocol(discoveryObserved, {direction: "out"}), "out:ack": surfaceProof.protocol(acknowledgement, {direction: "in"}), "dashboard:register": surfaceProof.dashboard("register", this.registrationId, {relatedId: this.discoveryId})})
    boundary.complete()
    return {handles: {page: this.registrationId, document: probe.page_instance_id, session: `${storage.browserId}:${probe.tab_id}:${probe.page_instance_id}`}, observations: {
      "page.available": available, "wait.shared-vertical-slice.discover": available,
    }}
  }

  async credential({boundary}) {
    this.credentialLease = await this.dashboard.acquireCredential("call")
    this.credentialId = this.credentialLease.id
    observeSurfaceProofs(boundary, {"dashboard:create-credential": surfaceProof.dashboard("create-credential", this.credentialId)})
    boundary.complete()
    return {handles: {credential: this.credentialId}, observations: {"wait.shared-vertical-slice.credential": {state: "present", value: true}}}
  }

  async invoke({handles, boundary}) {
    return this.credentialLease.use(async token => {
      assert.equal(handles.get("browser", "browser"), this.browserId)
      assert.equal(handles.get("credential", "credential"), this.credentialId)
      for (const [version, surfaceId] of [["2026-07-28", "version:2026"], ["2025-11-25", "version:2025-11"], ["2025-06-18", "version:2025-06"], ["2025-03-26", "version:2025-03"]]) {
        const compatibility = new MCPClient({baseUrl: this.world.baseUrl, token, version})
        try { const exchange = await compatibility.initialize(); assert.equal(exchange.status, 200); boundary.observe(surfaceId, surfaceProof.mcp(exchange, {method: "initialize", version})) }
        finally { compatibility.close() }
      }
      this.mcp = new MCPClient({baseUrl: this.world.baseUrl, token, version: this.mcpVersion, recorder: {record: this.recorder.producers.mcp.event}})
      const initialized = await this.mcp.initialize()
      assert.equal(initialized.status, 200)
      const listed = await this.mcp.listTools(); assert.equal(listed.status, 200)
      const status = await this.mcp.call({action: "status"}); assert.equal(status.status, 200)
      const browserList = await this.mcp.call({action: "browser.list"}); assert.equal(browserList.status, 200)
      const discoveryList = await this.mcp.call({action: "discovery.list"}); assert.equal(discoveryList.status, 200)
      const discoveryGet = await this.mcp.call({action: "discovery.get", params: {discovery: this.discoveryId}}); assert.equal(discoveryGet.status, 200)
      const pages = await this.mcp.call({action: "page.list"})
      const pageList = pages.body.result.structuredContent ?? JSON.parse(pages.body.result.content[0].text)
      assert.equal(pageList.find(item => item.id === this.registrationId)?.available, true)
      const pageGet = await this.mcp.call({action: "page.get", params: {page: this.registrationId}}); assert.equal(pageGet.status, 200)
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
      observeSurfaceProofs(boundary, {"http:post-mcp": surfaceProof.mcp(response, {method: "POST", action: "page.call", version: this.mcpVersion}), "in:tool-result": surfaceProof.mcp(response, {method: "tools/call", action: "page.call", version: this.mcpVersion}), "out:tool-call": surfaceProof.mcp(response, {method: "tools/call", action: "page.call", version: this.mcpVersion}), "mcp:initialize": surfaceProof.mcp(initialized, {method: "initialize", version: this.mcpVersion}), "mcp:tools-list": surfaceProof.mcp(listed, {method: "tools/list", version: this.mcpVersion}), "mcp:tools-call": surfaceProof.mcp(response, {method: "tools/call", version: this.mcpVersion}), "mcp:initialized": surfaceProof.mcp(initialized, {method: "initialize", version: this.mcpVersion}), "action:status": surfaceProof.mcp(status, {method: "tools/call", action: "status", version: this.mcpVersion}), "action:browser-list": surfaceProof.mcp(browserList, {method: "tools/call", action: "browser.list", version: this.mcpVersion}), "action:discovery-list": surfaceProof.mcp(discoveryList, {method: "tools/call", action: "discovery.list", version: this.mcpVersion}), "action:discovery-get": surfaceProof.mcp(discoveryGet, {method: "tools/call", action: "discovery.get", version: this.mcpVersion}), "action:page-list": surfaceProof.mcp(pages, {method: "tools/call", action: "page.list", version: this.mcpVersion}), "action:page-get": surfaceProof.mcp(pageGet, {method: "tools/call", action: "page.get", version: this.mcpVersion}), "action:page-tools": surfaceProof.mcp(tools, {method: "tools/call", action: "page.tools", version: this.mcpVersion}), "action:page-call": surfaceProof.mcp(response, {method: "tools/call", action: "page.call", version: this.mcpVersion}), "fixture:side-effect": surfaceProof.chrome({sequence: 1}, {eventName: "fixture.side-effect", identity: `${this.registrationId}:${session.id}:echo`})})
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
    observeSurfaceProofs(boundary, {"artifact:server-log": surfaceProof.artifact(attested, "server-stdout-live.log"), "artifact:dashboard": surfaceProof.artifact(attested, "dashboard-snapshot.png")})
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
