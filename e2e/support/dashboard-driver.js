import {dashboardSelectors, recordSelector} from "./dashboard-selectors.js"

function idFrom(locator, prefix) {
  return locator.getAttribute("id").then(id => {
    if (!id?.startsWith(prefix)) throw new Error(`dashboard row is missing ${prefix} ID`)
    return id.slice(prefix.length)
  })
}

export class DashboardDriver {
  constructor({page, recorder, timeoutMs = 10_000} = {}) {
    if (!page || !recorder?.producers?.dashboard) throw new Error("dashboard page and central recorder are required")
    this.page = page
    this.recorder = recorder
    this.producer = recorder.producers.dashboard
    this.timeoutMs = timeoutMs
    page.setDefaultTimeout(timeoutMs)
  }

  async open(baseUrl) {
    await this.page.goto(new URL("/", baseUrl).href, {waitUntil: "domcontentloaded"})
    await this.page.locator("[data-phx-main].phx-connected").waitFor({state: "visible"})
    await this.page.locator(dashboardSelectors.root).waitFor({state: "visible"})
    await this.producer.event("dashboard.opened", {status: await this.page.locator(dashboardSelectors.root).getAttribute("data-status")})
    return this
  }

  async refresh() {
    await this.page.reload({waitUntil: "domcontentloaded"})
    await this.page.locator("[data-phx-main].phx-connected").waitFor({state: "visible"})
    await this.page.locator(dashboardSelectors.root).waitFor({state: "visible"})
  }

  section(name) { return this.page.locator(dashboardSelectors[name]) }
  row(kind, id) { return this.page.locator(recordSelector(kind, id)) }

  async rowByText(section, kind, text) {
    const row = this.section(section).locator(`article[id^='${kind}-']`).filter({hasText: text})
    await row.waitFor({state: "visible"})
    return row
  }

  async click(row, name) {
    const action = row.getByRole("button", {name, exact: true})
    await action.waitFor({state: "visible"})
    await action.click()
  }

  async approvePairing(pairingId, displayName) {
    const pairing = this.row("pairing", pairingId)
    await this.click(pairing, "Approve")
    await pairing.waitFor({state: "detached"})
    const browser = await this.rowByText("browsers", "browser", displayName)
    return idFrom(browser, "browser-")
  }

  async rejectPairing(pairingId) {
    const row = this.row("pairing", pairingId)
    await this.click(row, "Reject")
    await row.waitFor({state: "detached"})
  }

  async revokeBrowser(browserId) {
    const row = this.row("browser", browserId)
    await this.click(row, "Revoke")
    await row.getByRole("button", {name: "Revoke", exact: true}).waitFor({state: "detached"})
    await row.getByText("Revoked", {exact: false}).waitFor({state: "visible"})
  }

  async ignoreDiscovery(discoveryId) {
    const row = this.row("discovery", discoveryId)
    await this.click(row, "Ignore")
    await row.waitFor({state: "detached"})
  }

  async registerDiscovery(discoveryId, title) {
    const row = this.row("discovery", discoveryId)
    await this.click(row, "Register page")
    await row.waitFor({state: "detached"})
    const registration = await this.rowByText("registrations", "registration", title)
    return idFrom(registration, "registration-")
  }

  async credentialRow(scope, {active = false} = {}) {
    const name = scope === "call" ? "Local MCP call client" : "Local MCP read client"
    let rows = this.section("access").locator("article[id^='mcp-credential-']").filter({hasText: name})
    if (active) rows = rows.filter({has: this.page.getByRole("button", {name: "Revoke", exact: true})})
    const row = rows.last()
    await row.waitFor({state: "visible"})
    return row
  }

  async withCredential(scope, operation, {timeoutMs = this.timeoutMs, signal} = {}) {
    if (!["read", "call"].includes(scope) || typeof operation !== "function") throw new Error("credential scope and callback are required")
    const context = this.page.context()
    const traceWasSuspended = true
    let row
    let ephemeral = {token: undefined}
    await context.tracing.stop()
    try {
      return await this.producer.secretZone(`credential-${scope}`, async () => {
        const label = scope === "call" ? "Create call credential" : "Create read credential"
        await this.section("access").getByRole("button", {name: label, exact: true}).click()
        const token = this.page.locator(dashboardSelectors.token)
        await token.waitFor({state: "visible"})
        ephemeral.token = (await token.locator("code").textContent())?.trim()
        if (!ephemeral.token?.startsWith("webby_")) throw new Error("credential token was not displayed")
        this.recorder.addSecret(ephemeral.token)
        row = await this.credentialRow(scope, {active: true})
        const controller = new AbortController()
        const credentialId = await idFrom(row, "mcp-credential-")
        const operationPromise = Promise.resolve().then(() => operation(ephemeral, credentialId, controller.signal))
        let timer
        let abort
        const interruption = new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error("credential operation timed out"), {code: "credential_operation_timeout"})) }, timeoutMs)
          abort = () => { controller.abort(); reject(Object.assign(new Error("credential operation cancelled"), {code: "credential_operation_cancelled"})) }
          signal?.addEventListener("abort", abort, {once: true})
          if (signal?.aborted) queueMicrotask(abort)
        })
        try { return await Promise.race([operationPromise, interruption]) }
        finally { clearTimeout(timer); signal?.removeEventListener("abort", abort) }
      })
    } finally {
      try {
        row ??= await this.credentialRow(scope, {active: true}).catch(() => undefined)
        if (row && await row.getByRole("button", {name: "Revoke", exact: true}).count()) await this.click(row, "Revoke")
        await this.page.locator(dashboardSelectors.token).waitFor({state: "detached"})
        await this.clearBrowserSecretSurfaces()
      } finally {
        ephemeral.token = undefined
        if (traceWasSuspended) await context.tracing.start({screenshots: false, snapshots: false, sources: false})
      }
    }
  }

  async clearBrowserSecretSurfaces() {
    await this.page.evaluate(async () => {
      localStorage.clear(); sessionStorage.clear()
      try { await navigator.clipboard.writeText("") } catch {}
    })
  }

  async assertSecretAbsent(secret) {
    const state = await this.page.evaluate(async () => {
      let clipboard = ""
      try { clipboard = await navigator.clipboard.readText() } catch {}
      return {dom: document.documentElement.textContent, local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), clipboard}
    })
    for (const value of Object.values(state)) if (value.includes(secret)) throw new Error("credential remained on a browser-visible surface")
  }

  async assertActionUnavailable(kind, id, action) {
    const row = this.row(kind, id)
    if (await row.getByRole("button", {name: action, exact: true}).count()) throw new Error("stale dashboard action remained available")
  }

  async registrationSessionCount(registrationId, count) {
    await this.row("registration", registrationId).getByText(`${count} active sessions`, {exact: false}).waitFor({state: "visible"})
  }
}
