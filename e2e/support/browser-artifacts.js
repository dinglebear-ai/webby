const ignoredConsole = [
  /^Webby tab scan failed.*Cannot access a chrome:\/\//,
  /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
]

export function classifyBrowserError({kind, text}) {
  const message = typeof text === "string" ? text : text.message ?? ""
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
  constructor(producer) {
    if (!producer?.event || !producer?.capture || !producer?.diagnostic) throw new Error("central Chromium artifact producer is required")
    this.producer = producer
    this.failures = []
    this.pending = new Set()
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
    page.on("console", message => this.record("console", {level: message.type(), message: message.text(), url: page.url()}))
    page.on("pageerror", error => this.record("page_error", {message: error.message, url: page.url()}))
    page.on("requestfailed", request => this.record("network_error", {message: request.failure()?.errorText ?? "request_failed", url: request.url()}))
  }

  record(kind, details) {
    const pending = this.observe(kind, details).catch(error => this.failures.push({kind: "artifact_recorder", message: error.message}))
    this.pending.add(pending)
    void pending.finally(() => this.pending.delete(pending))
  }

  async drain() { while (this.pending.size) await Promise.allSettled([...this.pending]) }

  async observe(kind, details) {
    const classification = classifyBrowserError({kind, text: ["console", "worker_console"].includes(kind) ? {level: details.level, message: details.message} : details.message ?? ""})
    await this.producer.event(`browser.${kind}`, {...details, classification: classification.code})
    if (classification.severity === "failure") this.failures.push({kind, ...details})
  }

  assertClean() {
    if (this.failures.length) throw new Error(`unexpected browser failures: ${this.failures.map(item => `${item.kind}:${item.message}`).join("; ")}`)
  }

  capture(kind, operation) { return this.producer.capture(kind, operation) }
  diagnostic(name, data, fields) { return this.producer.diagnostic(name, data, fields) }
}
