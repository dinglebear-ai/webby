import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import {join} from "node:path"
import test from "node:test"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {ChromiumWorld} from "../../support/chromium-world.js"
import {runCleanupPlan} from "../../support/cleanup-plan.js"
import {DashboardDriver} from "../../support/dashboard-driver.js"
import {checkpointedDiagnostics, executeSql, persistenceOperation, sqlite} from "../../support/persistence-driver.js"
import {WebbyWorld} from "../../support/world.js"

const old = "2020-01-01 00:00:00"
const inventory = JSON.parse(await readFile(new URL("../../contracts/chromium-persistence-probes.json", import.meta.url), "utf8"))

async function bounded(label, operation, timeoutMs = 20_000) {
  let timer
  try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} cleanup timed out`)), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}

test("real Chromium profile and Webby persistence retain only durable state, drain retention, and erase browser data", {timeout: 300_000}, async t => {
  let world = await WebbyWorld.start({scenarioId: "chromium-persistence-retention", seed: 20020, preserveArtifacts: true})
  const recorder = await new ArtifactRecorder({root: join(world.workspace.artifacts, "chromium-persistence-retention"), scenarioId: "e2e-persistence-retention", worldId: world.worldId, seed: world.seed, secrets: [world.secret, world.telemetryCapability]}).open()
  let chromium; let finalized = false
  t.after(async () => {
    const failures = []
    for (const [label, operation] of [["chromium", () => chromium?.close()], ["recorder", () => finalized ? undefined : recorder.finalize({status: "failed"})], ["world", () => world?.teardown({remove: true})]]) {
      try { await bounded(label, operation) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, "Chromium persistence cleanup failed")
  })

  chromium = await ChromiumWorld.launch({world, recorder, broadHostPermissions: true})
  let driver = chromium.driver
  let dashboard = await new DashboardDriver({page: await chromium.context.newPage(), recorder}).open(world.baseUrl)
  assert.equal(await driver.configure({mode: "all_tabs"}), "Saved.")
  const pending = await driver.pair("Chrome")
  const browserId = await dashboard.approvePairing(pending.pairing_id, "Chrome")
  assert.equal(await driver.waitForStorageValue("e2eAuthenticatedBrowserId"), browserId)
  const durableIdentity = await driver.storage(["publicKey", "browserId", "scanningMode"])
  assert.equal(durableIdentity.browserId, browserId)
  assert.ok(durableIdentity.publicKey)

  await chromium.close(); chromium = undefined
  chromium = await ChromiumWorld.launch({world, recorder, broadHostPermissions: true})
  driver = chromium.driver
  dashboard = await new DashboardDriver({page: await chromium.context.newPage(), recorder}).open(world.baseUrl)
  assert.deepEqual(await driver.storage(["publicKey", "browserId", "scanningMode"]), durableIdentity, "preserved Chromium profile lost its durable identity")

  const registrationId = "retention-registration"
  await executeSql(world.databasePath, `
    INSERT INTO page_registrations(id,slug,display_name,origin,url_pattern,preferred_browser_id,auto_attach,enabled,exposure_mode,inserted_at,updated_at) VALUES('${registrationId}','retention-registration','Retention','https://retention.test','/','${browserId}',1,1,'broker','${old}','${old}');
    INSERT INTO document_sessions(id,browser_id,registration_id,tab_id,document_id,current_origin,sanitized_path,page_title,catalog_revision,catalog_fingerprint,catalog_summary,connected_at,last_seen_at,status,inserted_at,updated_at) VALUES('retention-active','${browserId}','${registrationId}',1,'retention-document','https://retention.test','/','Retention',1,'${"a".repeat(64)}','{}','${old}','${old}','active','${old}','${old}');
    INSERT INTO browser_pairing_requests(id,display_name,extension_id,public_key,scanning_mode,status,expires_at,inserted_at,updated_at) VALUES('retention-pending','Pending','${"d".repeat(32)}',X'${"33".repeat(32)}','granted_sites','pending','2099-01-01 00:00:00','${old}','${old}');
    INSERT INTO invocation_audits(id,credential_id,registration_id,session_id,browser_id,tool_name,catalog_revision,outcome,error_kind,duration_ms,inserted_at) VALUES('retention-started',NULL,'${registrationId}','retention-active','${browserId}','tool_0',1,'started',NULL,0,'${old}');
    ${Array.from({length: 5}, (_, index) => `INSERT INTO discoveries(id,browser_id,origin,sanitized_path,page_title,tool_count,catalog_fingerprint,catalog_summary,first_seen_at,last_seen_at,detection_count,state,inserted_at,updated_at) VALUES('chromium-old-${index}','${browserId}','https://retention.test','/${index}','Retention',1,'${String(index + 1).repeat(64)}','{}','${old}','${old}',1,'ignored','${old}','${old}');`).join("\n")}
  `)
  assert.match(await persistenceOperation(world, {op: "retention.drain", cutoff: "2021-01-01T00:00:00Z", batch_size: 2}), /batch_count: 3/)
  assert.equal((await sqlite(world.databasePath, "SELECT count(*) AS count FROM discoveries WHERE id LIKE 'chromium-old-%'"))[0].count, 0)
  assert.deepEqual(await sqlite(world.databasePath, "SELECT id,status FROM document_sessions WHERE id='retention-active'"), [{id: "retention-active", status: "active"}])
  assert.deepEqual(await sqlite(world.databasePath, "SELECT id,status FROM browser_pairing_requests WHERE id='retention-pending'"), [{id: "retention-pending", status: "pending"}])
  assert.deepEqual(await sqlite(world.databasePath, "SELECT id,outcome FROM invocation_audits WHERE id='retention-started'"), [{id: "retention-started", outcome: "started"}])

  const previousDatabase = world.databasePath
  await chromium.artifacts.duringExpectedBrowserShutdown(() => dashboard.page.close())
  await chromium.artifacts.duringExpectedNetworkOutage(async () => { world = await world.restart({preserveState: true}) })
  assert.equal(world.databasePath, previousDatabase)
  assert.deepEqual(await sqlite(world.databasePath, "SELECT id,status FROM document_sessions WHERE id='retention-active'"), [{id: "retention-active", status: "closed"}], "startup did not reconcile the live session")
  assert.match(await persistenceOperation(world, {op: "audit.reconcile", cutoff: "2021-01-01T00:00:00Z"}), /\{:ok, 1\}/)
  const reconciledAudit = await sqlite(world.databasePath, "SELECT id,outcome,error_kind,browser_id FROM invocation_audits WHERE id='retention-started'")
  assert.equal(reconciledAudit[0].outcome, "abandoned")
  assert.equal(reconciledAudit[0].error_kind, "interrupted")
  assert.equal(reconciledAudit[0].browser_id, browserId)
  assert.equal((await sqlite(world.databasePath, `SELECT count(*) AS count FROM browsers WHERE id='${browserId}'`))[0].count, 1)

  dashboard = await new DashboardDriver({page: await chromium.context.newPage(), recorder}).open(world.baseUrl)
  assert.equal(await dashboard.row("browser", browserId).count(), 1, "preserved restart lost the public browser identity")
  await chromium.artifacts.duringExpectedBrowserShutdown(() => dashboard.page.close())
  await chromium.artifacts.duringExpectedBrowserRevocation(() => chromium.artifacts.duringExpectedNetworkOutage(async () => {
    assert.match(await persistenceOperation(world, {op: "browser.erase", browser_id: browserId, audits: "anonymize"}), /"audits":"anonymize"/)
  }))
  dashboard = await new DashboardDriver({page: await chromium.context.newPage(), recorder}).open(world.baseUrl)
  assert.equal(await dashboard.row("browser", browserId).count(), 0, "erased browser remained publicly visible")
  assert.equal((await sqlite(world.databasePath, `SELECT count(*) AS count FROM browsers WHERE id='${browserId}'`))[0].count, 0)
  assert.deepEqual(await sqlite(world.databasePath, "SELECT browser_id FROM invocation_audits WHERE id='retention-started'"), [{browser_id: null}])
  assert.deepEqual(await sqlite(world.databasePath, `SELECT preferred_browser_id FROM page_registrations WHERE id='${registrationId}'`), [{preferred_browser_id: null}])

  const {diagnostics} = await checkpointedDiagnostics(world, {recorder, name: "chromium-persistence-diagnostics.json", tables: {browsers: ["id", "revoked_at"], document_sessions: ["id", "status"], invocation_audits: ["id", "browser_id", "outcome"]}})
  assert.equal(diagnostics.wal_bytes, 0)
  assert.equal(Object.hasOwn(diagnostics.tables.invocation_audits[0], "tool_name"), false, "diagnostics exposed a non-allowlisted audit field")

  const executed = new Set(["chromium-profile-identity-durable", "preserved-webby-restart", "live-session-reconciled", "audit-retained-and-anonymized", "browser-erasure-isolated", "retention-multi-batch", "retention-active-preserved", "retention-pending-preserved", "retention-started-audit-preserved", "sanitized-checkpoint-diagnostics"])
  const deferredFresh = new Set(["fresh-chromium-profile-isolated", "fresh-webby-world-isolated"])
  assert.deepEqual([...new Set([...executed, ...deferredFresh])].sort(), [...inventory.inventory].sort())
  await recorder.producers.chromium.diagnostic("chromium-persistence-coverage.json", {schema_version: 1, scenario_id: inventory.scenario_id, executed: [...executed].sort(), fresh_isolation: [...deferredFresh].sort(), public_first: true, retries: 0}, ["schema_version", "scenario_id", "executed", "fresh_isolation", "public_first", "retries"])

  await chromium.close(); chromium = undefined
  await recorder.finalize({status: "passed", cleanup: {chromium: "closed", persistence: "checkpointed", secrets: "redacted"}}); finalized = true
  await world.teardown({remove: true}); world = undefined
})

test("fresh Webby world and Chromium profile do not inherit paired identity or retained rows", {timeout: 180_000}, async t => {
  const first = await WebbyWorld.start({scenarioId: "chromium-fresh-isolation-source", seed: 20021})
  const firstRecorder = await new ArtifactRecorder({root: join(first.workspace.artifacts, "fresh-source"), scenarioId: "e2e-persistence-retention", worldId: first.worldId, seed: first.seed, secrets: [first.secret]}).open()
  let firstChromium = await ChromiumWorld.launch({world: first, recorder: firstRecorder})
  await firstChromium.driver.configure()
  await firstChromium.driver.pair("Chrome")
  const firstKey = (await firstChromium.driver.storage(["publicKey"])).publicKey
  await executeSql(first.databasePath, `INSERT INTO browsers(id,display_name,extension_id,public_key,scanning_mode,scanning_paused,paired_at,inserted_at,updated_at) VALUES('must-not-cross','Source','${"a".repeat(32)}',X'${"11".repeat(32)}','granted_sites',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);`)
  await firstChromium.close(); firstChromium = undefined
  await firstRecorder.finalize({status: "passed"})
  await first.teardown({remove: true})

  const fresh = await WebbyWorld.start({scenarioId: "chromium-fresh-isolation-target", seed: 20022})
  const recorder = await new ArtifactRecorder({root: join(fresh.workspace.artifacts, "fresh-target"), scenarioId: "e2e-persistence-retention", worldId: fresh.worldId, seed: fresh.seed, secrets: [fresh.secret]}).open()
  let chromium
  let finalized = false
  t.after(async () => {
    await runCleanupPlan([
      ["chromium", () => chromium?.close()],
      ["recorder", () => finalized ? undefined : recorder.finalize({status: "failed"})],
      ["world", () => fresh.teardown({remove: true})],
    ], {message: "Fresh-world fallback cleanup failed"})
  })
  chromium = await ChromiumWorld.launch({world: fresh, recorder})
  await chromium.driver.configure()
  await chromium.driver.pair("Chrome")
  const freshStorage = await chromium.driver.storage(["publicKey", "browserId"])
  assert.notEqual(freshStorage.publicKey, firstKey)
  assert.equal(freshStorage.browserId, undefined)
  assert.equal((await sqlite(fresh.databasePath, "SELECT count(*) AS count FROM browsers"))[0].count, 0)
  await chromium.close(); chromium = undefined
  await recorder.finalize({status: "passed", cleanup: {fresh_profile: "isolated", fresh_database: "empty"}})
  finalized = true
  await fresh.teardown({remove: true})
})
