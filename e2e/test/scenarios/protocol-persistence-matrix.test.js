import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import test from "node:test"
import {emitLiveTestReceipt} from "../../support/live-test-receipt.js"
import {executeSql, sqlite, strictCleanup} from "../../support/persistence-driver.js"
import {selectCombinations} from "../../support/validate-contracts.js"
import {WebbyWorld} from "../../support/world.js"

const scenarioPath = new URL("../../contracts/scenarios/persistence-retention.json", import.meta.url)
const probesPath = new URL("../../contracts/persistence-probes.json", import.meta.url)

test("authoritative restart selector executes every database/shutdown/backlog combination", {timeout: 300_000}, async () => {
  const contract = JSON.parse(await readFile(scenarioPath, "utf8"))
  const rows = selectCombinations(contract.combinations, "protocol")
  assert.equal(rows.length, 8)
  assert.ok(rows.some(row => row.database === "populated" && row.shutdown === "killed" && row.backlog === "multi-batch"))
  const executed = []
  for (const [index, row] of rows.entries()) {
    let world = await WebbyWorld.start({scenarioId: `restart-matrix-${index}`, seed: 15_100 + index})
    try {
      const generation = (await sqlite(world.databasePath, "SELECT value FROM webby_meta WHERE key='schema_generation'"))[0].value
      assert.equal(generation, "7")
      if (row.database === "populated") await seedBrowser(world, `browser-${index}`)
      await seedBacklog(world, row.backlog === "multi-batch" ? 3 : 1, index)
      const previousDatabase = world.databasePath
      const previousNonce = world.instanceNonce
      if (row.shutdown === "killed") process.kill(-world.identity.pgid, "SIGKILL")
      world = await world.restart({preserveState: row.database === "populated"})
      assert.notEqual(world.instanceNonce, previousNonce)
      if (row.database === "populated") {
        assert.equal(world.databasePath, previousDatabase)
        assert.equal((await sqlite(world.databasePath, `SELECT count(*) AS count FROM browsers WHERE id='browser-${index}'`))[0].count, 1)
      } else {
        assert.notEqual(world.databasePath, previousDatabase)
        assert.equal((await sqlite(world.databasePath, "SELECT count(*) AS count FROM browsers"))[0].count, 0)
      }
      executed.push(JSON.stringify(row))
    } finally {
      await strictCleanup(world)
    }
  }
  assert.equal(new Set(executed).size, rows.length)
  await emitLiveTestReceipt({scenarioId: "e2e-persistence-retention", adapter: "protocol", receiptId: "persistence-matrix-live", assertions: {restart_combinations: executed.length, schema_generation: 7}})
})

test("persistence execution set covers every inventoried behavior and every direct seam is reviewed", async () => {
  const contract = JSON.parse(await readFile(probesPath, "utf8"))
  const executed = new Set([
    "fresh-migration", "preserved-restart", "fresh-restart", "startup-session-reconcile", "identity-durability",
    "abandoned-audit", "terminal-audit-retry", "terminal-audit-exhaustion", "schema-current", "schema-unsupported",
    "retention-multi-batch", "retention-active-preserved", "retention-pending-preserved", "retention-started-preserved",
    "erasure-anonymize", "erasure-delete", "erasure-browser-isolation", "resync-write-contention",
    "page-list-constant-query", "checkpointed-attested-diagnostics", "strict-cleanup", "restart-combinations"
  ])
  assert.deepEqual([...contract.inventory].sort(), [...executed].sort())
  const operations = new Set(contract.reviewed_exclusions.map(row => row.operation))
  assert.deepEqual([...operations].sort(), ["audit.complete.exhausted", "audit.complete.retry", "audit.reconcile", "browser.erase", "retention.drain", "schema.validate"].sort())
  for (const exclusion of contract.reviewed_exclusions) {
    assert.equal(exclusion.owner, "webby-ihb.15")
    assert.match(exclusion.reviewed_on, /^20\d\d-\d\d-\d\d$/)
    assert.ok(exclusion.rationale.length >= 40)
  }
})

test("persistence operation transport is the inventoried isolated E2E route", async () => {
  const inventory = JSON.parse(await readFile(new URL("../../contracts/surfaces.json", import.meta.url), "utf8"))
  const route = inventory.surfaces.find(surface => surface.id === "http:post-e2e-persistence")
  assert.deepEqual(route, {id: "http:post-e2e-persistence", category: "http_route", symbol: "POST /e2e/persistence", source: "lib/webby_web/router.ex:27", scenarios: ["e2e-persistence-retention"]})
  const contract = JSON.parse(await readFile(scenarioPath, "utf8"))
  assert.ok(contract.surface_ids.includes(route.id))
})

async function seedBrowser(world, id) {
  const extension = `matrix${id}`.padEnd(32, "x").slice(0, 32)
  await executeSql(world.databasePath, `INSERT INTO browsers(id,display_name,extension_id,public_key,scanning_mode,scanning_paused,paired_at,inserted_at,updated_at) VALUES('${id}','Matrix','${extension}',X'${"11".repeat(32)}','granted_sites',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);`)
}

async function seedBacklog(world, count, offset) {
  await seedBrowser(world, `backlog-${offset}`)
  const sql = Array.from({length: count}, (_, index) => `INSERT INTO discoveries(id,browser_id,origin,sanitized_path,page_title,tool_count,catalog_fingerprint,catalog_summary,first_seen_at,last_seen_at,detection_count,state,inserted_at,updated_at) VALUES('matrix-${offset}-${index}','backlog-${offset}','https://matrix.test','/${index}','Matrix',1,'${String((index % 9) + 1).repeat(64)}','{}','2020-01-01 00:00:00','2020-01-01 00:00:00',1,'ignored','2020-01-01 00:00:00','2020-01-01 00:00:00');`).join("\n")
  await executeSql(world.databasePath, sql)
}
