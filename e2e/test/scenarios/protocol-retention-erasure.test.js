import assert from "node:assert/strict"
import test from "node:test"
import {ArtifactRecorder} from "../../support/artifacts.js"
import {checkpointedDiagnostics, executeSql, persistenceOperation, sqlite, strictCleanup} from "../../support/persistence-driver.js"
import {WebbyWorld} from "../../support/world.js"

const old = "2020-01-01 00:00:00"

test("multi-batch retention preserves active state and erasure is browser-isolated", {timeout: 120_000}, async t => {
  const world = await WebbyWorld.start({scenarioId: "retention-erasure", seed: 1503, preserveArtifacts: true})
  t.after(async () => strictCleanup(world))
  await executeSql(world.databasePath, `
    INSERT INTO browsers(id,display_name,extension_id,public_key,scanning_mode,scanning_paused,paired_at,inserted_at,updated_at) VALUES('browser-a','A','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',X'${"11".repeat(32)}','granted_sites',0,'${old}','${old}','${old}');
    INSERT INTO browsers(id,display_name,extension_id,public_key,scanning_mode,scanning_paused,paired_at,inserted_at,updated_at) VALUES('browser-b','B','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',X'${"22".repeat(32)}','granted_sites',0,'${old}','${old}','${old}');
    INSERT INTO page_registrations(id,slug,display_name,origin,url_pattern,preferred_browser_id,auto_attach,enabled,exposure_mode,inserted_at,updated_at) VALUES('page-a','page-a','A','https://a.test','/','browser-a',1,1,'broker','${old}','${old}');
    INSERT INTO page_registrations(id,slug,display_name,origin,url_pattern,preferred_browser_id,auto_attach,enabled,exposure_mode,inserted_at,updated_at) VALUES('page-b','page-b','B','https://b.test','/','browser-b',1,1,'broker','${old}','${old}');
    INSERT INTO document_sessions(id,browser_id,registration_id,tab_id,document_id,current_origin,sanitized_path,page_title,catalog_revision,catalog_fingerprint,catalog_summary,connected_at,last_seen_at,status,inserted_at,updated_at) VALUES('active-a','browser-a','page-a',1,'active-a','https://a.test','/','A',1,'${"a".repeat(64)}','{}','${old}','${old}','active','${old}','${old}');
    INSERT INTO document_sessions(id,browser_id,registration_id,tab_id,document_id,current_origin,sanitized_path,page_title,catalog_revision,catalog_fingerprint,catalog_summary,connected_at,last_seen_at,status,inserted_at,updated_at) VALUES('closed-a','browser-a','page-a',2,'closed-a','https://a.test','/','A',1,'${"b".repeat(64)}','{}','${old}','${old}','closed','${old}','${old}');
    INSERT INTO browser_pairing_requests(id,display_name,extension_id,public_key,scanning_mode,status,expires_at,inserted_at,updated_at) VALUES('pending-a','Pending','cccccccccccccccccccccccccccccccc',X'${"33".repeat(32)}','granted_sites','pending','2099-01-01 00:00:00','${old}','${old}');
    INSERT INTO invocation_audits(id,credential_id,registration_id,session_id,browser_id,tool_name,catalog_revision,outcome,error_kind,duration_ms,inserted_at) VALUES('started-a',NULL,'page-a','active-a','browser-a','tool_0',1,'started',NULL,0,'${old}');
    ${Array.from({length: 5}, (_, i) => `INSERT INTO discoveries(id,browser_id,origin,sanitized_path,page_title,tool_count,catalog_fingerprint,catalog_summary,first_seen_at,last_seen_at,detection_count,state,inserted_at,updated_at) VALUES('discovery-${i}','browser-a','https://a.test','/${i}','A',1,'${String(i + 1).repeat(64)}','{}','${old}','${old}',1,'ignored','${old}','${old}');`).join("\n")}
  `)
  const result = await persistenceOperation(world, {op: "retention.drain", cutoff: "2021-01-01T00:00:00Z", batch_size: 2})
  assert.match(result, /batch_count: 3/)
  const retentionEvents = (await world.telemetry(world.telemetryCapability)).filter(event => event.event.join(".").startsWith("webby.retention."))
  assert.deepEqual(retentionEvents.filter(event => event.event.at(-1) === "batch").map(event => event.measurements.rows_deleted), [3, 2, 1])
  assert.equal(retentionEvents.at(-1).measurements.batch_count, 3)
  assert.equal(retentionEvents.at(-1).measurements.rows_deleted, 6)
  assert.equal((await sqlite(world.databasePath, "SELECT count(*) AS count FROM discoveries"))[0].count, 0)
  assert.deepEqual(await sqlite(world.databasePath, "SELECT id,status FROM document_sessions ORDER BY id"), [{id: "active-a", status: "active"}])
  assert.deepEqual(await sqlite(world.databasePath, "SELECT id,status FROM browser_pairing_requests"), [{id: "pending-a", status: "pending"}])
  assert.deepEqual(await sqlite(world.databasePath, "SELECT id,outcome FROM invocation_audits"), [{id: "started-a", outcome: "started"}])

  assert.match(await persistenceOperation(world, {op: "browser.erase", browser_id: "browser-a", audits: "anonymize"}), /audits: :anonymize/)
  assert.deepEqual(await sqlite(world.databasePath, "SELECT id FROM browsers"), [{id: "browser-b"}])
  assert.deepEqual(await sqlite(world.databasePath, "SELECT id,browser_id FROM invocation_audits"), [{id: "started-a", browser_id: null}])
  assert.deepEqual(await sqlite(world.databasePath, "SELECT id,preferred_browser_id FROM page_registrations ORDER BY id"), [{id: "page-a", preferred_browser_id: null}, {id: "page-b", preferred_browser_id: "browser-b"}])
  await executeSql(world.databasePath, `INSERT INTO document_sessions(id,browser_id,registration_id,tab_id,document_id,current_origin,sanitized_path,page_title,catalog_revision,catalog_fingerprint,catalog_summary,connected_at,last_seen_at,status,inserted_at,updated_at) VALUES('session-b','browser-b','page-b',3,'document-b','https://b.test','/','B',1,'${"c".repeat(64)}','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'closed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP); INSERT INTO invocation_audits(id,credential_id,registration_id,session_id,browser_id,tool_name,catalog_revision,outcome,error_kind,duration_ms,inserted_at) VALUES('audit-b',NULL,'page-b','session-b','browser-b','tool_0',1,'succeeded',NULL,1,CURRENT_TIMESTAMP);`)
  assert.match(await persistenceOperation(world, {op: "browser.erase", browser_id: "browser-b", audits: "delete"}), /deleted_audits: 1/)
  assert.deepEqual(await sqlite(world.databasePath, "SELECT id FROM invocation_audits ORDER BY id"), [{id: "started-a"}])
  assert.deepEqual(await sqlite(world.databasePath, "SELECT id,preferred_browser_id FROM page_registrations ORDER BY id"), [{id: "page-a", preferred_browser_id: null}, {id: "page-b", preferred_browser_id: null}])
  const recorder = await new ArtifactRecorder({root: `${world.workspace.artifacts}/retention-recorder`, scenarioId: "retention-erasure", worldId: world.worldId, secrets: [world.secret, world.telemetryCapability]}).open()
  const {diagnostics} = await checkpointedDiagnostics(world, {recorder, tables: {browsers: ["id", "revoked_at"], invocation_audits: ["id", "browser_id", "outcome"]}})
  assert.equal(diagnostics.wal_bytes, 0)
  const artifact = await recorder.finalize({cleanup: {database: "checkpointed", secrets: "redacted"}})
  assert.ok(artifact.uploadCandidates.some(path => path.endsWith("persistence-diagnostics.json")))
})
