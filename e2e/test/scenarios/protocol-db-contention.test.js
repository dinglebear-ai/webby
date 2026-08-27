import assert from "node:assert/strict"
import test from "node:test"
import {MCPClient} from "../../support/mcp-client.js"
import {Ed25519Identity} from "../../support/ed25519-identity.js"
import {executeSql, persistenceOperation, sqlite, strictCleanup, telemetryOffset} from "../../support/persistence-driver.js"
import {SimulatedBrowser} from "../../support/simulated-browser.js"
import {WebbyWorld} from "../../support/world.js"

test("page.list query count is constant at 1/10/100/1000 registrations", {timeout: 120_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "persistence-query-count", seed: 1504})
  const credential = await world.provisionCredential({scopes: ["read"]})
  const client = new MCPClient({baseUrl: world.baseUrl, token: credential.token, version: "2025-06-18"})
  t.after(async () => { client.close(); await strictCleanup(world) })
  await client.initialize()
  const deltas = []
  for (const size of [1, 10, 100, 1000]) {
    await executeSql(world.databasePath, `DELETE FROM page_registrations; WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${size}) INSERT INTO page_registrations(id,slug,display_name,origin,url_pattern,auto_attach,enabled,exposure_mode,inserted_at,updated_at) SELECT printf('page-%04d',x),printf('page-%04d',x),printf('Page %04d',x),'https://fixture.test',printf('/%d',x),1,1,'broker',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM n;`)
    const offset = await telemetryOffset(world)
    const response = await client.call({action: "page.list"})
    const listed = response.body.result?.structuredContent ?? JSON.parse(response.body.result?.content?.[0]?.text ?? "null")
    assert.ok(Array.isArray(listed), JSON.stringify(response.body))
    assert.equal(listed.length, size)
    const delta = (await world.telemetry(world.telemetryCapability)).slice(offset).filter(event => event.event.join(".") === "webby.repo.query").length
    assert.ok(delta > 0, `missing query telemetry for ${size} registrations`)
    deltas.push(delta)
  }
  assert.equal(new Set(deltas).size, 1, `query deltas were ${deltas.join(",")}`)
})

test("terminal audit retries through transient contention and writes exactly once", {timeout: 120_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "persistence-audit-contention", seed: 1505})
  t.after(async () => strictCleanup(world))
  await executeSql(world.databasePath, `INSERT INTO browsers(id,display_name,extension_id,public_key,scanning_mode,scanning_paused,paired_at,inserted_at,updated_at) VALUES('browser-a','A','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',X'${"11".repeat(32)}','granted_sites',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP); INSERT INTO page_registrations(id,slug,display_name,origin,url_pattern,preferred_browser_id,auto_attach,enabled,exposure_mode,inserted_at,updated_at) VALUES('page-a','page-a','A','https://a.test','/','browser-a',1,1,'broker',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP); INSERT INTO document_sessions(id,browser_id,registration_id,tab_id,document_id,current_origin,sanitized_path,page_title,catalog_revision,catalog_fingerprint,catalog_summary,connected_at,last_seen_at,status,inserted_at,updated_at) VALUES('session-a','browser-a','page-a',1,'doc','https://a.test','/','A',1,'${"a".repeat(64)}','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'closed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP); INSERT INTO invocation_audits(id,credential_id,registration_id,session_id,browser_id,tool_name,catalog_revision,outcome,error_kind,duration_ms,inserted_at) VALUES('audit-a',NULL,'page-a','session-a','browser-a','tool',1,'started',NULL,0,CURRENT_TIMESTAMP);`)
  assert.match(await persistenceOperation(world, {op: "audit.complete.retry", audit_id: "audit-a"}), /\{\{:ok, :completed\}, 3\}/)
  assert.deepEqual(await sqlite(world.databasePath, "SELECT outcome,error_kind,duration_ms FROM invocation_audits WHERE id='audit-a'"), [{outcome: "failed", error_kind: "fixture_failure", duration_ms: 7}])
  const exhausted = await persistenceOperation(world, {op: "audit.complete.exhausted", audit_id: "audit-a"})
  assert.match(exhausted, /:error, \{%Exqlite.Error\{message: "database is busy"/)
  assert.match(exhausted, /, 2\}$/)
})

test("1000-document resync completes alongside credential, audit, and retention writes", {timeout: 180_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "persistence-write-contention", seed: 1506})
  const identity = new Ed25519Identity()
  const browser = new SimulatedBrowser({baseUrl: world.baseUrl, identity, browserId: "browser-live", timeoutMs: 90_000})
  t.after(async () => strictCleanup(world, {browsers: [browser]}))
  await executeSql(world.databasePath, `INSERT INTO browsers(id,display_name,extension_id,public_key,scanning_mode,scanning_paused,paired_at,inserted_at,updated_at) VALUES('browser-live','Live','${identity.extensionId}',X'${identity.publicKeyRaw.toString("hex")}','granted_sites',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP); INSERT INTO page_registrations(id,slug,display_name,origin,url_pattern,preferred_browser_id,auto_attach,enabled,exposure_mode,inserted_at,updated_at) VALUES('page-live','page-live','Live','https://fixture.test','/page/*','browser-live',1,1,'broker',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP); INSERT INTO document_sessions(id,browser_id,registration_id,tab_id,document_id,current_origin,sanitized_path,page_title,catalog_revision,catalog_fingerprint,catalog_summary,connected_at,last_seen_at,status,inserted_at,updated_at) VALUES('session-old','browser-live','page-live',9999,'old','https://fixture.test','/page/old','Old',1,'${"a".repeat(64)}','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'closed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP); INSERT INTO invocation_audits(id,credential_id,registration_id,session_id,browser_id,tool_name,catalog_revision,outcome,error_kind,duration_ms,inserted_at) VALUES('audit-live',NULL,'page-live','session-old','browser-live','tool',1,'started',NULL,0,CURRENT_TIMESTAMP);`)
  await browser.authenticate("browser-live")
  const [resync, credential, audit, retention] = await Promise.all([
    browser.scanTabs(1000, {batchSize: 128}),
    world.provisionCredential({scopes: ["read", "call"]}),
    persistenceOperation(world, {op: "audit.complete.retry", audit_id: "audit-live"}),
    persistenceOperation(world, {op: "retention.drain", cutoff: "2021-01-01T00:00:00Z", batch_size: 17}),
  ])
  assert.equal(resync.count, 1000)
  assert.equal(resync.messages, 8)
  assert.match(audit, /completed/)
  assert.match(retention, /batch_count:/)
  assert.equal((await sqlite(world.databasePath, "SELECT count(*) AS count FROM document_sessions WHERE status='active'"))[0].count, 1000)
  assert.equal((await sqlite(world.databasePath, `SELECT count(*) AS count FROM mcp_credentials WHERE id='${credential.id}'`))[0].count, 1)
  assert.deepEqual(await sqlite(world.databasePath, "SELECT outcome FROM invocation_audits WHERE id='audit-live'"), [{outcome: "failed"}])
  const wal = await sqlite(world.databasePath, "PRAGMA wal_checkpoint(PASSIVE)")
  assert.ok(wal[0].busy === 0 || wal[0].busy === undefined, JSON.stringify(wal))
})
