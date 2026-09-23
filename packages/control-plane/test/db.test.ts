// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "vitest";

function runDbCheck(code: string): void {
  execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
}

describe("ControlStore", () => {
  it("upserts/removes agents and caches sessions and events append-only", () => {
    runDbCheck(`
      import assert from 'node:assert/strict';
      import { ControlStore } from ${JSON.stringify(resolve("dist/db.js"))};
      const store = new ControlStore(':memory:');
      const agent = { peer_id:'agent-1', name:'Agent', host:'127.0.0.1', port:7330, credential:'secret', paired_at:'now' };
      store.upsertAgent(agent); assert.deepEqual({ ...store.getAgent(agent.peer_id) }, agent); assert.deepEqual(store.listAgents().map(a => ({ ...a })), [agent]);
      store.upsertAgent({ ...agent, name:'Renamed' }); assert.equal(store.getAgent(agent.peer_id).name, 'Renamed');
      const first = { id:'s1', project:'/p', started_at:'a', updated_at:'b' };
      store.upsertSessions(agent.peer_id, [first, { ...first, id:'s2', name:'' }], 'sync1');
      store.upsertSessions(agent.peer_id, [{ ...first, name:'Named', updated_at:'c' }], 'sync2');
      assert.equal(store.listSessions(agent.peer_id).length, 2);
      assert.deepEqual({ ...store.listSessions(agent.peer_id).find(s => s.session_id === 's1') }, { agent_id:'agent-1', session_id:'s1', project:'/p', name:'Named', started_at:'a', updated_at:'c', synced_at:'sync2' });
      assert.equal(store.listSessions(agent.peer_id).find(s => s.session_id === 's2').name, '');
      store.upsertSessions(agent.peer_id, [{ ...first, id:'s3' }], 'sync3');
      assert.equal(store.listSessions(agent.peer_id).find(s => s.session_id === 's3').name, null);
      const job = { agent_id:'agent-1', job_id:'j1', session_id:'s1', pid:123, project:'/p', created_at:'created', state:'running' };
      store.upsertJob(job);
      assert.deepEqual(store.listJobs().map(j => ({ ...j })), [job]);
      store.upsertJob({ ...job, state:'stopping' });
      assert.deepEqual(store.listJobs(agent.peer_id).map(j => ({ ...j })), [{ ...job, state:'stopping' }]);
      store.upsertJob({ ...job, agent_id:'agent-2', job_id:'j2' });
      store.replaceJobs(agent.peer_id, [{ ...job, job_id:'j3', state:'running' }]);
      assert.deepEqual(store.listJobs(agent.peer_id).map(j => ({ ...j })), [{ ...job, job_id:'j3' }], 'replaceJobs clause: replace this agent rows without touching other agents');
      assert.deepEqual(store.listJobs('agent-2').map(j => j.job_id), ['j2']);
      assert.throws(() => store.replaceJobs(agent.peer_id, [{ ...job, job_id:'bad' }, { ...job, job_id:'bad' }]));
      assert.deepEqual(store.listJobs(agent.peer_id).map(j => j.job_id), ['j3'], 'replaceJobs transaction clause: failed insert preserves prior rows');
      store.setJobState(agent.peer_id, 'j3', 'exited');
      assert.equal(store.listJobs(agent.peer_id)[0].state, 'exited');
      const retentionStore = new ControlStore(':memory:');
      for (let i = 0; i < 60; i++) retentionStore.upsertJob({ ...job, job_id:'j'+String(i).padStart(2, '0'), created_at:new Date(i * 1000).toISOString() });
      assert.equal(retentionStore.listJobs().length, 50, 'jobs retention clause: keep at most 50 rows overall');
      assert.deepEqual(retentionStore.listJobs().map(j => j.job_id).sort(), Array.from({length:50}, (_, i) => 'j'+String(i + 10).padStart(2, '0')), 'jobs retention clause: retain the newest 50 by created_at');
      retentionStore.close();
      store.upsertEvents(agent.peer_id, 's1', [{ entryId:'e1', type:'message', timestamp:'t', data:{ n:1 } }]);
      assert.deepEqual(store.listEvents(agent.peer_id, 's1').map(e => [e.entry_id,e.data]), [['e1','{"n":1}']]);
      // Re-caching the same entry id must not rewrite it: session entries are
      // append-only (AGENTS.md), so a changed payload for an existing id is
      // ignored rather than allowed to mutate history.
      store.upsertEvents(agent.peer_id, 's1', [{ entryId:'e1', type:'message', timestamp:'t2', data:{ n:2 } }]);
      assert.deepEqual(store.listEvents(agent.peer_id, 's1').map(e => [e.entry_id,e.data]), [['e1','{"n":1}']], 'append-only: an existing entry must not be rewritten');
      store.removeAgent(agent.peer_id); assert.deepEqual(store.listAgents(), []); store.close();
    `);
  });

  it("persists identity and token in a private file database", () => {
    runDbCheck(`
      import assert from 'node:assert/strict';
      import { mkdtempSync, rmSync, statSync } from 'node:fs';
      import { tmpdir } from 'node:os'; import { join } from 'node:path';
      import { ControlStore } from ${JSON.stringify(resolve("dist/db.js"))};
      const directory = mkdtempSync(join(tmpdir(), 'pi-mesh-db-')); const path = join(directory, 'control.sqlite');
      try {
        const a = new ControlStore(path); const id=a.controlId(), token=a.dashboardToken(); a.close();
        assert.equal(statSync(path).mode & 0o777, 0o600);
        const b = new ControlStore(path); assert.equal(b.controlId(), id); assert.equal(b.dashboardToken(), token); assert.equal(b.controlName('fallback'), 'fallback'); b.close();
      } finally { rmSync(directory, { recursive:true, force:true }); }
    `);
  });

  it("prunes an oversized jobs table when a pre-existing database is opened", () => {
    runDbCheck(`
      import assert from 'node:assert/strict';
      import { mkdtempSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os'; import { join } from 'node:path';
      import { DatabaseSync } from 'node:sqlite';
      import { ControlStore } from ${JSON.stringify(resolve("dist/db.js"))};
      const directory = mkdtempSync(join(tmpdir(), 'pi-mesh-db-overflow-'));
      const path = join(directory, 'control.sqlite');
      try {
        // Seed a database as an earlier version could leave it: more rows than
        // the retention limit, written without pruning.
        const raw = new DatabaseSync(path);
        raw.exec("CREATE TABLE jobs(agent_id TEXT NOT NULL, job_id TEXT NOT NULL, session_id TEXT, pid INTEGER, project TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(agent_id, job_id)) STRICT");
        const insert = raw.prepare("INSERT INTO jobs(agent_id,job_id,session_id,pid,project,created_at,state) VALUES('a',?,'s',1,'p',?,'running')");
        for (let i = 0; i < 60; i++) insert.run('j'+String(i).padStart(2,'0'), new Date(i * 1000).toISOString());
        assert.equal(raw.prepare('SELECT count(*) AS n FROM jobs').get().n, 60);
        raw.close();
        // Opening it must prune, not wait for the next spawn.
        const store = new ControlStore(path);
        assert.equal(store.listJobs().length, 50, 'constructor prune clause: an oversized database is pruned on open');
        assert.deepEqual(store.listJobs().map(j => j.job_id).sort(), Array.from({length:50}, (_, i) => 'j'+String(i + 10).padStart(2,'0')));
        store.close();
      } finally { rmSync(directory, { recursive:true, force:true }); }
    `);
  });
});
