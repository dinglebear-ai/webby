import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises"
import {createServer} from "node:net"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {assertNoLeaks, detectLeaks} from "../../support/leak-detector.js"

test("intentional process, listener, profile, database, pending call and session leaks fail closed", async t => {
  const root = await mkdtemp(join(tmpdir(), "webby-stress-leak-")); const profile = join(root, "profile"); const database = join(root, "webby.db")
  await mkdir(profile); await writeFile(database, "sqlite")
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio: "ignore"})
  t.after(async () => { child.kill("SIGKILL"); await new Promise(resolve => server.close(resolve)); await rm(root, {recursive: true, force: true}) })
  const report = await detectLeaks({pids: [child.pid], ports: [server.address().port], profiles: [profile], databases: [database], pendingCalls: ["call-100"], staleSessions: ["session-old"]})
  assert.deepEqual(Object.keys(report), ["processes", "listeners", "handles", "workspaces", "profiles", "databases", "pending_calls", "stale_sessions"])
  assert.throws(() => assertNoLeaks(report), /processes=1.*listeners=1.*profiles=1.*databases=1.*pending_calls=1.*stale_sessions=1/)
})

test("empty resource snapshot passes", async () => assert.deepEqual(assertNoLeaks(await detectLeaks()), {processes: [], listeners: [], handles: [], workspaces: [], profiles: [], databases: [], pending_calls: [], stale_sessions: []}))
