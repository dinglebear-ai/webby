import {extensionIdForKey} from "./test-manifest.js"

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])

export function validateBoundWorld(binding, world) {
  if (!binding || !world) throw new Error("extension binding and world manifest are required")
  if (binding.expected_extension_id !== extensionIdForKey()) throw new Error("unexpected test extension identity")
  if (world.environment_marker !== "isolated-e2e" || binding.environment_marker !== "isolated-e2e") throw new Error("refusing non-E2E environment")
  if (binding.instance_nonce !== world.instance_nonce) throw new Error("wrong or stale E2E world nonce")
  if (binding.base_url !== world.base_url || binding.fixture_url !== world.fixture_url) throw new Error("extension copy belongs to another E2E world")
  const base = new URL(binding.base_url)
  const fixture = new URL(binding.fixture_url)
  if (base.protocol !== "http:" || fixture.protocol !== "http:" || !LOOPBACK.has(base.hostname) || !LOOPBACK.has(fixture.hostname)) throw new Error("refusing developer or remote endpoint")
  if (!base.port || !fixture.port || base.port === "6477") throw new Error("refusing default/developer Webby endpoint")
  if (base.origin === fixture.origin) throw new Error("Webby and fixture authorities must be isolated")
  return true
}

function workerId(worker) {
  const match = worker.url().match(/^chrome-extension:\/\/([a-p]{32})\//)
  if (!match) throw new Error(`invalid extension service-worker URL: ${worker.url()}`)
  return match[1]
}

export class ExtensionDriver {
  constructor({context, binding, world, artifacts, workerTimeoutMs = 15_000}) {
    validateBoundWorld(binding, world)
    this.context = context
    this.binding = binding
    this.world = world
    this.artifacts = artifacts
    this.workerTimeoutMs = workerTimeoutMs
    this.tabIds = new WeakMap()
  }

  async worker() {
    let worker = this.context.serviceWorkers().find(candidate => candidate.url().startsWith(`chrome-extension://${this.binding.expected_extension_id}/`))
    if (!worker) worker = await this.context.waitForEvent("serviceworker", {timeout: this.workerTimeoutMs, predicate: candidate => candidate.url().startsWith(`chrome-extension://${this.binding.expected_extension_id}/`)})
    const runtimeId = workerId(worker)
    if (runtimeId !== this.binding.expected_extension_id) throw new Error(`runtime extension ID mismatch: ${runtimeId}`)
    const response = await fetch(`${this.binding.base_url}/health`)
    if (!response.ok) throw new Error(`bound Webby health failed: ${response.status}`)
    const health = await response.json()
    const capability = health?.runtime?.capabilities?.health
    if (capability?.instance_nonce !== this.binding.instance_nonce || capability?.environment_marker !== this.binding.environment_marker) throw new Error("Webby instance binding mismatch")
    return worker
  }

  async reacquireWorker(previous) {
    const candidate = await this.worker()
    if (previous && candidate === previous) {
      await this.artifacts.producer.event("browser.worker.reused", {extension_id: this.binding.expected_extension_id})
    } else {
      await this.artifacts.producer.event("browser.worker.reacquired", {extension_id: this.binding.expected_extension_id})
    }
    return candidate
  }

  async suspendAndReacquireWorker() {
    const previous = await this.worker()
    const page = this.context.pages()[0] ?? await this.context.newPage()
    const session = await this.context.newCDPSession(page)
    const version = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("service-worker CDP version was not reported")), this.workerTimeoutMs)
      session.on("ServiceWorker.workerVersionUpdated", ({versions}) => {
        const matching = versions.find(candidate => candidate.scriptURL?.startsWith(`chrome-extension://${this.binding.expected_extension_id}/`))
        if (matching) { clearTimeout(timeout); resolve(matching) }
      })
    })
    await session.send("ServiceWorker.enable")
    await session.send("ServiceWorker.stopWorker", {versionId: (await version).versionId})
    let restartTransient = false
    try { await previous.evaluate(() => chrome.runtime.id) }
    catch (error) {
      if (!/Service worker restarted|closed|destroyed/i.test(error.message)) throw error
      restartTransient = true
    }
    await session.detach()
    const popup = await this.popup()
    await popup.close()
    return {worker: await this.reacquireWorker(previous), restartTransient}
  }

  async popup() {
    const page = await this.context.newPage()
    await page.goto(`chrome-extension://${this.binding.expected_extension_id}/src/popup.html`)
    return page
  }

  async configure({baseUrl = this.binding.base_url, mode = "granted_sites", paused = false} = {}) {
    const popup = await this.popup()
    try {
      // popup.js installs the save listener after its top-level permission await.
      // Waiting for the stored/default value prevents a click racing module setup.
      await popup.waitForFunction(() => document.querySelector("#base-url")?.value?.length > 0)
      await popup.locator("#base-url").fill(baseUrl)
      await popup.locator("#mode").selectOption(mode)
      await popup.locator("#paused").setChecked(paused)
      await popup.locator("#save").click()
      await popup.waitForFunction(() => document.querySelector("#status")?.textContent?.length > 0)
      return await popup.locator("#status").textContent()
    } finally { await popup.close() }
  }

  async pair(displayName = "Chrome") {
    const popup = await this.popup()
    try {
      await popup.locator("#pair").click()
      await popup.locator("#status").filter({hasText: "Pairing request sent"}).waitFor()
      const worker = await this.worker()
      return worker.evaluate(async name => {
        const values = await chrome.storage.local.get(["pairingId", "browserId"])
        return {display_name: name, pairing_id: values.pairingId ?? null, browser_id: values.browserId ?? null}
      }, displayName)
    } finally { await popup.close() }
  }

  async storage(keys) { return (await this.worker()).evaluate(keysValue => chrome.storage.local.get(keysValue), keys) }
  async waitForStorageValue(key, {timeoutMs = this.workerTimeoutMs} = {}) {
    if (typeof key !== "string" || !key) throw new Error("storage key is required")
    return (await this.worker()).evaluate(({storageKey, timeout}) => new Promise((resolve, reject) => {
      let timer
      const finish = value => { clearTimeout(timer); chrome.storage.onChanged.removeListener(changed); resolve(value) }
      const changed = (changes, area) => {
        if (area === "local" && changes[storageKey]?.newValue) finish(changes[storageKey].newValue)
      }
      chrome.storage.onChanged.addListener(changed)
      timer = setTimeout(() => {
        chrome.storage.onChanged.removeListener(changed)
        reject(new Error(`storage value did not arrive: ${storageKey}`))
      }, timeout)
      chrome.storage.local.get(storageKey).then(values => { if (values[storageKey]) finish(values[storageKey]) }, reject)
    }), {storageKey: key, timeout: timeoutMs})
  }
  async socketAttempts() { return (await this.worker()).evaluate(() => globalThis.__webbyE2ESocketAttempts ?? 0) }
  async waitForSocketAttempts(minimum = 1) {
    const deadline = Date.now() + this.workerTimeoutMs
    while (Date.now() < deadline) {
      const attempts = await this.socketAttempts()
      if (attempts >= minimum) return attempts
      await new Promise(resolve => setImmediate(resolve))
    }
    throw new Error(`socket attempt count did not reach ${minimum}`)
  }
  async permissions() { return (await this.worker()).evaluate(() => chrome.permissions.getAll()) }

  async chromeEventCounts() {
    return (await this.worker()).evaluate(() => ({...(globalThis.__webbyE2EChromeEvents ?? {})}))
  }

  async waitForChromeEvent(name, minimum = 1, {timeoutMs = this.workerTimeoutMs} = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const count = (await this.chromeEventCounts())[name] ?? 0
      if (count >= minimum) return count
      await new Promise(resolve => setImmediate(resolve))
    }
    throw new Error(`Chrome event ${name} did not reach ${minimum}`)
  }

  async scheduleScanAlarm() {
    const before = (await this.chromeEventCounts())["alarms.onAlarm"] ?? 0
    await (await this.worker()).evaluate(() => chrome.alarms.create("webby-periodic-scan", {when: Date.now() + 1}))
    return this.waitForChromeEvent("alarms.onAlarm", before + 1)
  }

  async closeTab(page) {
    const before = (await this.chromeEventCounts())["tabs.onRemoved"] ?? 0
    await page.close()
    await this.waitForChromeEvent("tabs.onRemoved", before + 1)
  }

  async removeFixturePermission() {
    const origin = `${new URL(this.binding.fixture_url).origin}/*`
    return (await this.worker()).evaluate(value => chrome.permissions.remove({origins: [value]}), origin)
  }

  async removeBroadPermissions() {
    return (await this.worker()).evaluate(() => chrome.permissions.remove({origins: ["http://*/*", "https://*/*"]}))
  }

  async newFixtureTab(path = "/") {
    const target = new URL(path, this.binding.fixture_url).href
    if (new URL(target).origin !== this.binding.fixture_url) throw new Error("fixture tab escaped bound origin")
    const existing = new Set(this.context.pages())
    const created = await (await this.worker()).evaluate(url => chrome.tabs.create({url, active: true}), target)
    let page = this.context.pages().find(candidate => !existing.has(candidate) && candidate.url() === target)
    page ??= await this.context.waitForEvent("page", {predicate: candidate => !existing.has(candidate) && candidate.url() === target})
    await page.waitForURL(target)
    await page.waitForLoadState("load")
    this.tabIds.set(page, created.id)
    return page
  }

  async scanNow({activePage} = {}) {
    if (activePage) {
      const expectedTabId = this.tabIds.get(activePage)
      if (!expectedTabId) throw new Error("active fixture page is not owned by the extension driver")
      const tabId = await (await this.worker()).evaluate(async ({url, expected}) => {
        if (expected) return expected
        const exact = (await chrome.tabs.query({})).filter(tab => tab.url === url)
        const tab = exact.length === 1 ? exact[0] : undefined
        if (!tab?.id) throw new Error("bound fixture tab was not uniquely visible")
        return tab.id
      }, {url: activePage.url(), expected: expectedTabId})
      await (await this.worker()).evaluate(id => chrome.storage.local.set({e2eScanTabId: id}), tabId)
    }
    const popup = await this.popup()
    try {
      await popup.evaluate(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime)
        chrome.runtime.sendMessage = (...args) => {
          const pending = send(...args)
          globalThis.__webbyE2EScanResponse = pending
          return pending
        }
      })
      await popup.locator("#scan").click()
      await popup.locator("#status").filter({hasText: "Scan requested"}).waitFor()
      const response = await popup.evaluate(() => globalThis.__webbyE2EScanResponse)
      if (response?.ok === false) throw new Error(`fixture scan failed: ${response.kind}`)
      if (!activePage) return response
      const scan = (await this.storage("e2eLastScan")).e2eLastScan
      if (!scan?.supported || scan.toolCount < 1) throw new Error(`fixture scan produced no WebMCP catalog: ${JSON.stringify(scan)}`)
      return scan
    } finally { await popup.close() }
  }

  async capabilityProbe(page) {
    if (new URL(page.url()).origin !== this.binding.fixture_url) throw new Error("capability probe requires bound fixture page")
    const knownTabId = this.tabIds.get(page)
    const lookup = await (await this.worker()).evaluate(async ({targetUrl, knownId}) => {
      if (knownId) return {tab: {id: knownId}, tabs: []}
      const exact = (await chrome.tabs.query({})).filter(candidate => candidate.url === targetUrl)
      return {tab: exact.find(candidate => candidate.id === knownId) ?? (exact.length === 1 ? exact[0] : null), tabs: (await chrome.tabs.query({})).map(({id, url, title}) => ({id, url, title}))}
    }, {targetUrl: page.url(), knownId: knownTabId})
    const tab = lookup.tab
    if (!tab?.id) throw new Error(`fixture tab was not visible to extension: page=${page.url()} tabs=${JSON.stringify(lookup.tabs)}`)
    const popup = await this.popup()
    const scripting = await popup.evaluate(() => ({
      execute_script: typeof chrome.scripting?.executeScript === "function",
      document_ids: true,
    })).finally(() => popup.close())
    // Playwright page evaluation is the page's MAIN world. Actual
    // chrome.scripting execution and returned Chromium documentId are exercised
    // by the paired discovery/invocation scenarios; bootstrap only proves both
    // required capabilities without starting an unbounded injection.
    const pageCapability = await page.evaluate(() => ({
      model_context: typeof document.modelContext?.getTools === "function" && typeof document.modelContext?.executeTool === "function",
      page_instance_id: document.documentElement.dataset.documentInstance ?? null,
    }))
    const result = {...scripting, ...pageCapability, tab_id: tab.id, world: "MAIN"}
    await this.artifacts.producer.event("browser.capability_probe", result)
    return result
  }
}
