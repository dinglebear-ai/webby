const ignoredConsole = [
  /^Webby tab scan failed.*Cannot access a chrome:\/\//,
]

export function classifyBrowserError({kind, text, expectedNetworkOutage = false, expectedBrowserRevocation = false, expectedBrowserShutdown = false, expectedFixtureCapacityDenial = false, expectedExtensionId}) {
  const message = typeof text === "string" ? text : text.message ?? ""
  const url = typeof text === "object" ? text.url ?? "" : ""
  if (/\/assets\/(?:js|css)\/app\.(?:js|css)(?:\?|$)/.test(url) && /404|Failed to load resource/.test(message)) return {severity: "failure", code: "core_asset_missing"}
  if (/\/favicon\.ico(?:\?|$)/.test(url) && /^Failed to load resource: the server responded with a status of 404/.test(message)) return {severity: "expected", code: "favicon_missing"}
  if (kind === "network_error" && /\/__fixture\/wait\?/.test(url) && /net::ERR_ABORTED/.test(message)) return {severity: "expected", code: "fixture_wait_cancelled"}
  if (expectedBrowserShutdown && kind === "network_error" && message === "net::ERR_ABORTED") return {severity: "expected", code: "expected_browser_shutdown_abort"}
  const exactShutdownWorker = expectedExtensionId && url === `chrome-extension://${expectedExtensionId}/src/service_worker.js`
  if (expectedBrowserShutdown && kind === "worker_console" && exactShutdownWorker && message === "Webby E2E binding failed Error: The browser is shutting down.") return {severity: "expected", code: "expected_browser_shutdown_console"}
  if (expectedFixtureCapacityDenial && kind === "console" && text.level === "error" && message === "Failed to load resource: the server responded with a status of 400 (Bad Request)") {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.pathname === "/__fixture/wait" && parsed.searchParams.get("scenario_id") === "chromium_invocation_tools" && /^capacity_(?:[0-9]|[1-9][0-9])$/.test(parsed.searchParams.get("call_id") ?? "")) return {severity: "expected", code: "expected_fixture_capacity_denial"}
    } catch {}
  }
  if (expectedNetworkOutage && /ERR_(?:CONNECTION_REFUSED|ABORTED)/.test(message)) return {severity: "expected", code: "expected_restart_outage"}
  if (expectedNetworkOutage && /^Webby tab scan failed.*Frame with ID .* is showing error page/.test(message)) return {severity: "expected", code: "expected_restart_error_page"}
  const exactWorkerIdentity = /(?:^|\/)service_worker\.js(?:\?|$)/.test(url) || (expectedExtensionId && /^[a-p]{32}$/.test(expectedExtensionId))
  const intentionalRevokedWorker = expectedBrowserRevocation && kind === "worker_console" && exactWorkerIdentity
  if (intentionalRevokedWorker && /^Webby removed tab close failed Error: channel_(?:not_ready|disconnected)(?:\n|$)/.test(message)) return {severity: "expected", code: "expected_revoked_tab_close"}
  if (intentionalRevokedWorker && /^Webby observation close failed; resync required(?:\s|$)/.test(message)) return {severity: "expected", code: "expected_revoked_observation_close"}
  if (intentionalRevokedWorker && /^Webby channel event failed \{(?:callId: [0-9a-f-]{36}, )?error: Error: channel_disconnected(?:\n|\}|$)/.test(message)) return {severity: "expected", code: "expected_revoked_channel_disconnect"}
  if (intentionalRevokedWorker && /^Webby channel event failed \{callId: [0-9a-f-]{36}, error: Error: channel_not_ready(?:\n|\}|$)/.test(message)) return {severity: "expected", code: "expected_revoked_channel_not_ready"}
  if (ignoredConsole.some(pattern => pattern.test(message))) return {severity: "expected", code: "known_chromium_restriction"}
  if (kind === "console" && !["error", "assert"].includes(text.level)) return {severity: "diagnostic", code: "console"}
  if (kind === "service_worker") return {severity: "diagnostic", code: "service_worker"}
  if (kind === "worker_console" && !["error", "assert"].includes(text.level)) return {severity: "diagnostic", code: "worker_console"}
  if (/Service worker restarted|Target page, context or browser has been closed/.test(message)) {
    return {severity: "transient", code: "service_worker_restarted"}
  }
  return {severity: "failure", code: `unexpected_${kind}`}
}

export class BrowserArtifacts {
  constructor(producer, {expectedExtensionId} = {}) {
    if (!producer?.event || !producer?.capture || !producer?.diagnostic) throw new Error("central Chromium artifact producer is required")
    this.producer = producer
    this.expectedExtensionId = expectedExtensionId
    this.failures = []
    this.pending = new Set()
    this.expectedNetworkOutageDepth = 0
    this.expectedBrowserRevocationDepth = 0
    this.expectedBrowserShutdownDepth = 0
    this.expectedFixtureCapacityDenialDepth = 0
  }

  attach(context) {
    context.on("page", page => this.attachPage(page))
    context.on("serviceworker", worker => this.record("service_worker", {url: worker.url()}))
    context.on("console", message => {
      if (!message.page()) this.record("worker_console", {level: message.type(), message: message.text(), url: message.location().url ?? "service-worker"})
    })
    context.on("weberror", webError => this.record("worker_error", {message: webError.error().message, url: webError.page()?.url() ?? "service-worker"}))
    for (const page of context.pages()) this.attachPage(page)
  }

  attachPage(page) {
    page.on("console", message => this.record("console", {level: message.type(), message: message.text(), url: message.location().url || page.url()}))
    page.on("pageerror", error => this.record("page_error", {message: error.message, url: page.url()}))
    page.on("requestfailed", request => this.record("network_error", {message: request.failure()?.errorText ?? "request_failed", url: request.url()}))
    page.on("response", response => {
      if (response.status() >= 400 && /\/assets\/(?:js|css)\/app\.(?:js|css)(?:\?|$)/.test(response.url())) {
        this.record("network_error", {message: `HTTP ${response.status()}`, url: response.url()})
      }
    })
  }

  record(kind, details) {
    const pending = this.observe(kind, details).catch(error => this.failures.push({kind: "artifact_recorder", message: error.message}))
    this.pending.add(pending)
    void pending.finally(() => this.pending.delete(pending))
  }

  async drain() { while (this.pending.size) await Promise.allSettled([...this.pending]) }

  async observe(kind, details) {
    const classification = classifyBrowserError({kind, text: ["console", "worker_console"].includes(kind) ? {level: details.level, message: details.message, url: details.url} : {message: details.message ?? "", url: details.url}, expectedNetworkOutage: this.expectedNetworkOutageDepth > 0, expectedBrowserRevocation: this.expectedBrowserRevocationDepth > 0, expectedBrowserShutdown: this.expectedBrowserShutdownDepth > 0, expectedFixtureCapacityDenial: this.expectedFixtureCapacityDenialDepth > 0, expectedExtensionId: this.expectedExtensionId})
    await this.producer.event(`browser.${kind}`, {...details, classification: classification.code})
    if (classification.severity === "failure") this.failures.push({kind, ...details})
  }

  assertClean() {
    if (this.failures.length) throw new Error(`unexpected browser failures: ${this.failures.map(item => `${item.kind}:${item.message}${item.url ? ` (${item.url})` : ""}`).join("; ")}`)
  }

  capture(kind, operation) { return this.producer.capture(kind, operation) }
  diagnostic(name, data, fields) { return this.producer.diagnostic(name, data, fields) }

  async duringExpectedNetworkOutage(operation) {
    this.expectedNetworkOutageDepth += 1
    try { return await operation() }
    finally {
      await this.drain()
      this.expectedNetworkOutageDepth -= 1
    }
  }

  async duringExpectedBrowserRevocation(operation) {
    this.expectedBrowserRevocationDepth += 1
    try { return await operation() }
    finally {
      await this.drain()
      this.expectedBrowserRevocationDepth -= 1
    }
  }

  async duringExpectedBrowserShutdown(operation) {
    this.expectedBrowserShutdownDepth += 1
    try { return await operation() }
    finally {
      await this.drain()
      this.expectedBrowserShutdownDepth -= 1
    }
  }

  async duringExpectedFixtureCapacityDenial(operation) {
    this.expectedFixtureCapacityDenialDepth += 1
    try { return await operation() }
    finally {
      await this.drain()
      this.expectedFixtureCapacityDenialDepth -= 1
    }
  }
}
