import assert from "node:assert/strict"
import test from "node:test"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {checkpointedDiagnostics, executeSql, persistenceOperation, sqlite, strictCleanup} from "../../support/persistence-driver.js"
import {WebbyWorld} from "../../support/world.js"

const old = "2020-01-01 00:00:00"

test("preserved restart keeps identity, closes live sessions, and reconciles abandoned audits", {timeout: 120_000}, async t => {
  let world = await WebbyWorld.start({scenarioId: "persistence-restart", seed: 1501, preserveArtifacts: true})
  t.after(async () => strictCleanup(world))
  await executeSql(world.databasePath, `
    INSERT INTO browsers(id,display_name,extension_id,public_key,scanning_mode,scanning_paused,paired_at,inserted_at,updated_at) VALUES('browser-a','Durable browser','abcdefghabcdefghabcdefghabcdefgh',X'${"11".repeat(32)}','granted_sites',0,'${old}','${old}','${old}');
    INSERT INTO page_registrations(id,slug,display_name,origin,url_pattern,preferred_browser_id,auto_attach,enabled,exposure_mode,inserted_at,updated_at) VALUES('page-a','durable','Durable','https://fixture.test','/page', 'browser-a',1,1,'broker','${old}','${old}');
    INSERT INTO document_sessions(id,browser_id,registration_id,tab_id,document_id,current_origin,sanitized_path,page_title,catalog_revision,catalog_fingerprint,catalog_summary,connected_at,last_seen_at,status,inserted_at,updated_at) VALUES('session-a','browser-a','page-a',1,'document-a','https://fixture.test','/page','Durable',1,'${"a".repeat(64)}','{}','${old}','${old}','active','${old}','${old}');
    INSERT INTO invocation_audits(id,credential_id,registration_id,session_id,browser_id,tool_name,catalog_revision,outcome,error_kind,duration_ms,inserted_at) VALUES('audit-a',NULL,'page-a','session-a','browser-a','tool_0',1,'started',NULL,0,'${old}');`)

  const firstInstance = world.instanceNonce
  world = await world.restart({preserveState: true})
  assert.notEqual(world.instanceNonce, firstInstance)
  assert.deepEqual(await sqlite(world.databasePath, "SELECT id FROM browsers"), [{id: "browser-a"}])
  assert.deepEqual(await sqlite(world.databasePath, "SELECT status FROM document_sessions WHERE id='session-a'"), [{status: "closed"}])
  assert.match(await persistenceOperation(world, {op: "audit.reconcile", cutoff: "2021-01-01T00:00:00Z"}), /\{:ok, 1\}/)
  assert.deepEqual(await sqlite(world.databasePath, "SELECT outcome,error_kind FROM invocation_audits WHERE id='audit-a'"), [{outcome: "abandoned", error_kind: "interrupted"}])
  const recorder = await new ArtifactRecorder({root: `${world.workspace.artifacts}/restart-recorder`, scenarioId: "persistence-restart", worldId: world.worldId, secrets: [world.secret, world.telemetryCapability]}).open()
  const {diagnostics} = await checkpointedDiagnostics(world, {recorder, tables: {webby_meta: ["key", "value"], document_sessions: ["id", "status"], invocation_audits: ["id", "outcome", "error_kind"]}})
  assert.equal(diagnostics.wal_bytes, 0)
  assert.deepEqual(diagnostics.tables.webby_meta.find(row => row.key === "schema_generation"), {key: "schema_generation", value: "7"})
  const artifact = await recorder.finalize({cleanup: {world: "verified-before-strict-teardown"}})
  assert.ok(artifact.uploadCandidates.some(path => path.endsWith("persistence-diagnostics.json")))
})

test("fresh world migrates an empty database and unsupported schema generation fails closed", {timeout: 120_000}, async t => {
  const fresh = await WebbyWorld.start({scenarioId: "persistence-schema", seed: 1502, preserveArtifacts: true})
  t.after(async () => strictCleanup(fresh))
  assert.equal((await sqlite(fresh.databasePath, "SELECT count(*) AS count FROM schema_migrations"))[0].count, 7)
  assert.match(await persistenceOperation(fresh, {op: "schema.validate"}), /\{:ok, %\{\}\}/)
  await executeSql(fresh.databasePath, "UPDATE webby_meta SET value='99' WHERE key='schema_generation'")
  assert.match(await persistenceOperation(fresh, {op: "schema.validate"}), /unsupported_schema_generation/)
})
