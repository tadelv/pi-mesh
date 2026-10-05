# Research: can Pi Durable retire pi-mesh's execution machinery?

> Research for [ADR 0020](../adr/0020-use-pi-durable-for-agent-spawning.md),
> not an adoption decision. The subsequent scope decision is recorded in ADR
> 0020. Existing protocol and security requirements remain normative. This
> investigation changed no production code or dependencies.

## Conclusion

**Yes as a replacement execution runtime; no as a drop-in process supervisor or
control-plane replacement.** `@earendil-works/pi-durable` runs the agent itself.
It does not launch or manage existing `pi --mode rpc` processes. It supplies
persisted conversations, submissions, generation/tool tasks, recovery, steering,
compaction, usage and committed live views. Its public API is explicitly
experimental. [D]

The most promising maintenance reduction is ultimately **delegating local
execution to upstream's durable coding-agent server**, leaving pi-mesh as the
LAN discovery/auth/A2A adapter and optional dashboard. That upstream application
already implements session workers, writer locks, model services and transcript
subscriptions. However, the coding-agent server/client application and its
experimental subpaths are source-only, excluded from npm and standalone builds.
The `pi-server` and `pi-client` libraries are separate transport/routing building
blocks, not a ready-made coding-agent daemon. Adopting those libraries alone
still leaves application session management and worker ownership to us. [E, S, C]

**Recommendation:** do not switch the deployed mesh wholesale yet. Settle ADR
0020 around that ownership boundary, and prove one new durable-backed session
before migrating. Do not build a second coding-agent application by copying
upstream's experimental implementation. If retaining normal Pi sessions,
extensions and commands is mandatory today, keep the existing execution path
until upstream offers the application as a supported integration. A direct
Durable integration is reasonable only if we explicitly accept a distinct agent
runtime and its compatibility work.

## Evidence and version boundary

- Inspected upstream release **v1.0.2**, commit
  `cd32f7725fdbddbaecdff5b1e68491563394e0ca`. Source links below are pinned there.
- Initially inspected `main` at
  `b2b5c42f6138b73ec4b2f49ec0ca468800f88586`, then checked out the release before
  final source checks. That main snapshot includes unreleased environment and
  progress API changes; they are **not** treated as 1.0.2 capabilities.
- Installed published `pi-durable`, `pi-ai` and `chord` **1.0.2** into
  `/tmp/pi-mesh-durable-probe`, with lifecycle scripts disabled. Verified against
  the published implementation, not just README examples.
- The locally installed coding-agent is also **1.0.2**. Durable declares
  Node **>=22.19.0**, above this repository's then-current >=22.13.0 floor
  (subsequently aligned in ADR 0020). Its direct
  dependencies are Chord, pi-ai, diff and TypeBox; its Node SQLite backend uses
  builtin `node:sqlite`. Similar storage dependencies do not imply a shared
  database schema or responsibilities. [P, Q]

## What we currently own

The execution flow is:

```text
peer/dashboard request
  -> authenticated A2A listener + execution gate
  -> skills.ts: validate project/cwd/model/prompt
  -> JobManager.startReady()
  -> createPiSpawner()
  -> PiRpcClient: pi --mode rpc, JSONL pipes, readiness, commands/events
  -> JobManager: ownership, admission, response acknowledgement, live rings
  -> session files + session.stream
  -> control-plane cache + bounded fan-out + dashboard
```

`mesh.handoff` already calls the same `process.spawn` handler, and resume starts
another managed job for a validated saved file. Model reads can also launch a
short-lived RPC helper. The model loop, built-in tools, ordinary compaction and
ordinary conversation persistence are **already delegated to Pi**; we do not
currently own a home-grown durable workflow engine. [M1, M2, M3]

Consequently, adding Durable underneath the existing RPC process would duplicate
ownership rather than remove it. Real savings require replacing the execution
backend, not wrapping it.

## Replacement map

| Current responsibility | Upstream replacement | What remains ours / limit |
| --- | --- | --- |
| `agent/src/rpc.ts`: launch, decode/correlate RPC, readiness, extension UI refusals | Direct `Harness`/`Conversation` calls, or upstream server's controller services | Raw Durable removes this only by changing the runtime. Upstream daemon integration would remove our Pi RPC client; any worker boundary we build ourselves still needs supervision. |
| `agent/src/spawner.ts`: construct Pi argv and connect a session | Create/open durable storage and conversation with `agent.cwd` and model | Workspace validation, trusted resource selection and secret filtering remain. Durable is not an executable resolver or spawn policy. |
| `agent/src/jobs.ts`: RPC handles and lifecycle observation | Durable owns generation/tool tasks, inbox, outcomes, abort and task graph | Mesh job IDs, admission limits, start-rate bounds, response-delivery cleanup, retained stop results and authority to stop owned jobs remain. A durable task is not a mesh job. |
| Custom live RPC rings; dashboard's live-event reducer | `Conversation.watch()` / `viewState()` / `watchEvents()` | A2A/SSE transport, bounded network queues, authenticated attachment, browser accessibility and disconnect behavior remain. Current wire/UI shapes cannot consume the new snapshots unchanged. |
| `agent/src/model-catalog.ts`: spawn a helper to obtain models | Host-owned pi-ai `Models` collection, or upstream `Models` service | Preserve the machine's configured providers/credentials and exact fresh-catalog validation; do not replace it with every built-in model. |
| `agent/src/sessions.ts`: enumerate/parse normal Pi JSONL | Durable's conversation/entry APIs for durable sessions | Existing Pi TUI sessions still require the current reader or an agreed replacement. Durable's JSONL is a different format. |
| Resume and writer-safety handling | Durable resumes its own pending work; upstream application locks its session directory | Durable's core storage has no cross-process ownership lock. Ordinary Pi files and ADR 0019's external-writer warning are not solved by this. |
| Control-plane SQLite cache, pairing and jobs mirror | No corresponding Durable replacement | Keep them: they cache remote peers for offline viewing and hold mesh/dashboard credentials, not local agent execution state. |
| `mesh.handoff` | Can invoke a durable-backed local start | Durable's reset/handoff and subagent APIs are local context/ownership mechanisms, not cross-machine A2A delegation. |

The replacement APIs above are documented in [D]; the local responsibilities are
in [M1–M7]. In particular, `jobs.ts` cannot simply be deleted because Durable has
a scheduler: several of its responsibilities belong to the remote execution
grant rather than the agent loop.

## Compatibility and safety blockers

### 1. Durable sessions are not normal Pi sessions

Durable entries use `kind`, model payloads and numeric entry/conversation IDs.
The JSONL backend stores commit markers in `main.jsonl` plus document/task
sidecars. It is not the normal Pi JSONL header/entry-tree format. A provider
session UUID is for provider affinity, **not** a globally usable conversation
identifier; durable IDs are scoped to their storage. [D, I, J]

Our API selects session UUIDs and returns unnormalised normal-Pi entries with
string `entryId` cursors. That is an observable contract, not an implementation
detail. Keeping it requires a durable identity/entry projection; changing it
requires an ADR and protocol/UI updates. Do not substitute the numeric root ID
or provider UUID blindly. Do not feed existing `.pi/agent/sessions/*.jsonl` files
to Durable's JSONL backend. [M3, M5]

Running both backends is a possible migration, but **not an immediate maintenance
saving**: both readers, execution paths and tests remain until the old path can
be retired. Do not invent a generic pluggable-backend framework for this spike.

### 2. It does not automatically run the operator's configured Pi

Durable has its own registry/extension API and `CodingTools`. It is not the
coding-agent CLI's extension loader, prompt-template system or command surface.
The experimental durable coding-agent explicitly lists extensions, prompt
templates, images and `/login` as missing. It reuses Pi credentials/settings and
system-prompt components through application glue. The experimental server uses
its own facet/plugin composition. Neither proves compatibility with our current
Pi packages or `get_commands` behavior. [D, E, L]

If we host Durable ourselves, model credentials/provider discovery, system
prompt, AGENTS/skills, HTTP proxy/dispatcher settings and selected integrations
become application composition we must maintain. Copying upstream's glue defeats
the reason for adopting it. [L]

### 3. Abort, close and process stop are different

`Conversation.abort()` stops current work and withdraws queued inputs, but leaves
the conversation usable. `Harness.close()` stops invocation execution **without
writing terminal task outcomes**, so reopening can continue pending work. Close
also waits for non-cooperative tool/hook code; it cannot forcibly terminate that
code inside the same process. [D, H]

Therefore:

- Mapping `session.abort` to conversation abort is plausible, subject to our reply
  and background-work semantics.
- Mapping `process.stop` to `Harness.close()` alone is wrong: a stopped job could
  resume on reopen. A terminal stop needs a settled cancellation and an explicit
  ownership/retirement decision, preserving idempotence.
- Hosting multiple untrusted/tool-running conversations in the mesh process loses
  our independent kill/escalation boundary. Prefer an upstream-owned worker, or
  acknowledge that a custom worker still leaves process supervision to us.
- `NodeExecutionEnv` manages its own command process groups. It is not a cgroup
  or sandbox and does not establish hard-kill descendant containment. [N, M4]

### 4. Recovery must respect the execution grant

Opening storage reconciles interrupted tasks; `resume()`, submitting and waiting
can enable scheduling. Persisted unfinished work must not silently execute after
the machine restarts with its execution grant closed. Read-only session browsing
must not call a scheduling-enabling operation on that path. Decide how revocation,
owned background tasks and unacknowledged starts behave before integration.
Durable does not know mesh grants or which peer admitted work. [D, H, M1, M4]

Durable's submission `requestId` provides persisted deduplication within a
conversation. Using that across an HTTP retry needs a stable application request
identity; the current mesh skill contract does not define one. An HMAC request
nonce is an anti-replay proof, not that identity. Do not claim end-to-end
exactly-once execution without deciding the wire semantics. [D, M5]

### 5. Environment filtering has a concrete trap

In 1.0.2, `NodeExecutionEnv` builds shell environment as:

```ts
{ ...process.env, ...shellEnv, ...options.env }
```

Passing our filtered `buildSpawnEnv(process.env)` as `shellEnv` **does not remove**
excluded parent variables: overlaying an object cannot delete them. The default
bash tool inherits the environment. A local sentinel probe confirmed this. [N]

Use a worker launched with the already-filtered environment, or explicit
`inheritEnv: false` and the filtered environment for every tool execution. Keep
mesh secrets out of tool processes; do not mistake this for sandboxing.

### 6. Storage and observation change the obligations

- Core Durable storage assumes one owning process but provides no cross-process
  lock. Upstream's experimental application adds `proper-lockfile`; ownership is
  application policy, not an automatic SQLite guarantee. [D, L]
- SQLite uses WAL / `synchronous=NORMAL`: process-crash recovery is not a promise
  that the newest commit survives power loss. JSONL offers `fsync: true`. [D]
- JSONL avoids adding SQLite to the agent, but adds persisted task/document state.
  This still changes our current stateless-agent design. It needs an explicit
  exception for Pi-owned execution storage; the control plane must not become
  the required runtime or state owner. [M6]
- `watch()` starts with the current committed view, and replaces an overfull
  queue (100 frames) with a newest-view snapshot. `watchEvents()` likewise emits
  a snapshot on overflow. The limit is not our 64 KiB byte bound. [D]
- That view contains **active context**, not necessarily all historical entries
  before reset/compaction. Durable entry paging is still needed for complete
  offline history. Do not replace the cache's full transcript with `view.entries`.
  Our current source discriminators, ephemeral delta fallback and bounded SSE
  fan-out remain until deliberately revised. [V, E, M5, M7]

Recovery also is not exactly-once external effects: interrupted unsafe tools get
an error indicating they may have partially run; safe tools may rerun. We should
reuse this policy rather than write our own retry state machine, but never mark
arbitrary shell commands or remote handoffs replay-safe. Upstream tests explicitly
cover unsafe interruption and the stored/current safe-policy combination. [D, T]

## Smallest adoption path

1. **Decide ownership in ADR 0020 before coding.** Is the product allowed to run a
   distinct Durable agent, or must it run the same configured Pi as a local TUI?
   Settle storage/session identity, terminal stop vs crash recovery, restart with
   the grant closed, ordinary-session coexistence, and live snapshot projection.
   Keep A2A, per-request authentication, pairing and the two dashboard execution
   grants unchanged. Raise the Node floor if adopting 1.0.2.
2. **Preferred destination: supported upstream daemon + thin local adapter.**
   The mesh agent calls controller/model/transcript/session-management services
   over a private local connection; upstream owns workers, storage and locks.
   Keep that protocol local, never replace the LAN A2A contract with CBOR/Chord.
   Upstream's Unix transport itself does not implement peer authentication, so
   private socket permissions and mesh-side authorization are required. This is
   a target architecture, not a released turnkey option today. [S, C, E]
3. **If adoption is needed now, prove only one new Durable session.** Pin 1.0.2
   and use its public APIs and builtin Node storage/environment. JSONL is the
   least architectural change for our agent's no-database constraint. Use
   `submit({type: "input", whenBusy: "steer"})`, configure for model changes,
   abort for cancellation, watch for live state and entries for history.
   Keep any trial outside the deployed path; do not port our whole feature set
   or expose missing capabilities as if they existed.
4. **Retire code only after proving equivalence.** Measure removed code against
   the adapter/glue introduced. A bespoke model/settings/resource loader,
   transcript translator, worker supervisor and dual session reader can cost
   more than the current RPC layer. If so, stop and wait for upstream rather
   than complete an expensive fork disguised as reuse.

A release migration must make these clauses fail by name: gate-closed start and
restart execute nothing; allowed start executes real work; idle and busy prompts
are delivered; stop is terminal and idempotent; crash recovery does not duplicate
unsafe effects; unacknowledged starts are cleaned up; model selection uses the
configured fresh catalog; only owned jobs are controlled; second writers are
refused; mesh variables are absent from tools; disconnect/overflow reconciles a
committed view; old normal-Pi sessions stay readable/resumable as promised; and
all of it works with no control plane. Validate on both macOS and Linux, then the
actual Mac/Raspberry Pi deployment. Existing tests should be kept where they
protect these product clauses, not deleted because upstream also has tests.

## Measured spike (not integration acceptance)

A credential-free probe used upstream's `fauxProvider`, started a real child
process with pending model work, waited for positive evidence that the request
had started, killed that child with `SIGKILL`, and reopened its storage.

| Clause | Result |
| --- | --- |
| Admitted submission exists before retry after crash | Pass |
| Same `requestId` returns the original submission | Pass |
| Pending generation runs on reopen and completes | Pass, provider execution counted |
| Exactly one user entry after retry | Pass |
| Conversation ID persists and is numeric | Pass; confirms identity mismatch with current mesh UUID contract |
| Event watch supplies a nonempty committed snapshot | Pass |
| `whenBusy: "steer"` on idle conversation starts a turn | Pass |
| Filtered `shellEnv` removes parent mesh variable | **False**; sentinel remained |
| Explicit `inheritEnv: false` + filtered `env` removes it | Pass |

Both SQLite and JSONL (`fsync: true`) passed on macOS arm64, Node **22.19.0** and
**26.10.0**. The final crash probe passed **12/12 repeated runs** on Node 26.
The faux request keeps an interval alive because it has no real provider socket;
without that positive-control fixture detail Node 22 can exit with an unsettled
await before the intended kill.

Mutation check: changed the temporary published implementation's existing-request
return from `existing.id` to `existing.id + 1`. The probe failed at
`dedup: requestId survives crash` (`9 !== 8`), not a timeout or transport error.
Restored it before final successful runs.

**Not verified:** real models/OAuth/proxies, current Pi extensions or commands,
unsafe-tool hard-crash recovery, busy steering, writer locks, stop semantics,
resource bounds on a 2 GB Pi, Linux containment, mesh/dashboard integration or CI.
Unsafe-tool behavior above is upstream source/test evidence, not our measured
hardware result. No claim of deployed equivalence follows from this smoke test.

### Reproduce the crash probe

Save the following as `/tmp/pi-mesh-durable-probe/probe.mjs`, then run:

```sh
rtk npm install --prefix /tmp/pi-mesh-durable-probe --ignore-scripts --save-exact \
  @earendil-works/pi-durable@1.0.2 @earendil-works/pi-ai@1.0.2 @earendil-works/chord@1.0.2
rtk node /tmp/pi-mesh-durable-probe/probe.mjs
rtk npx --yes --package=node@22.19.0 node /tmp/pi-mesh-durable-probe/probe.mjs
```

```js
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, watchEvents } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';

const request = { type: 'input', content: 'recover this', requestId: 'mesh-probe-1' };
async function open(kind, directory, responses) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const storage = kind === 'sqlite'
    ? await openNodeSqliteStorage(join(directory, 'session.sqlite'))
    : await openNodeJsonlStorage(join(directory, 'jsonl'), ctx, { fsync: true });
  return Harness.open(storage, { models, registry: createRegistry() }, ctx);
}

if (process.argv[2] === 'child') {
  // A faux request has no network socket to keep Node 22's event loop alive.
  setInterval(() => {}, 1000);
  const harness = await open(process.argv[3], process.argv[4], [(_request, options) => {
    process.send({ reached: true });
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  }]);
  const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  const submission = await root.submit(request, ctx);
  process.send({ conversationId: root.id, submissionId: submission.id });
  await submission.wait(ctx);
} else {
  for (const kind of ['sqlite', 'jsonl']) {
    const directory = await mkdtemp(join(tmpdir(), 'pi-mesh-durable-check-'));
    const child = fork(fileURLToPath(import.meta.url), ['child', kind, directory], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let harness;
    try {
      const admitted = await new Promise((resolve, reject) => {
        let ids, reached = false;
        const timer = setTimeout(() => reject(new Error('positive control: model request did not start')), 10000);
        child.on('message', message => {
          if (message.reached) reached = true;
          else ids = message;
          if (reached && ids) { clearTimeout(timer); resolve(ids); }
        });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('positive control: worker exited before model request')); });
      });
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      assert.equal((await exited)[1], 'SIGKILL', 'crash: worker was hard-killed');
      let calls = 0;
      harness = await open(kind, directory, [() => {
        calls++;
        return fauxAssistantMessage('recovered');
      }, fauxAssistantMessage('idle steer answered')]);
      const root = await harness.root(ctx);
      assert.equal(root.id, admitted.conversationId, 'identity: conversation survives crash');
      assert.equal(typeof root.id, 'number', 'compatibility: durable conversation ID is numeric, not a mesh UUID');
      assert.ok(await harness.submission(admitted.submissionId, ctx), 'persistence: admitted submission exists before retry');
      const again = await root.submit(request, ctx);
      assert.equal(again.id, admitted.submissionId, 'dedup: requestId survives crash');
      assert.equal((await again.wait(ctx)).status, 'done', 'recovery: interrupted generation completes');
      assert.equal(calls, 1, 'recovery: reopened provider actually executed');
      const page = await root.entries({}, 100, undefined, ctx);
      assert.equal(page.items.filter(entry => entry.kind === 'pi.user').length, 1, 'dedup: exactly one user entry');
      const events = await watchEvents(harness, root.id, ctx);
      assert.ok(events.snapshot.entries.length > 0, 'watch: attachment starts with committed transcript');
      await events.stop();
      const idle = await root.submit({ type: 'input', content: 'next', whenBusy: 'steer' }, ctx);
      assert.equal((await idle.wait(ctx)).status, 'done', 'steer: idle conversation starts a turn');
      console.log(`${kind}: PASS hard-crash recovery, persistent requestId dedup, numeric identity, committed snapshot, idle steer`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await harness?.close(ctx);
      await rm(directory, { recursive: true, force: true });
    }
  }
}
```

## Primary sources

All upstream links below are pinned to the inspected release, not moving main.

[D]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md
[P]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/package.json
[Q]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/package.json
[E]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/src/experimental/services/README.md
[S]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/server/README.md
[C]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/client/README.md
[I]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/docs/spec.md#2-core-records
[J]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/src/storage/jsonl/storage.ts
[H]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/docs/spec.md#12-api-footguns
[L]: https://github.com/earendil-works/pi/tree/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/src/experimental/durable
[N]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/src/env/node.ts
[V]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/src/harness/view.ts
[T]: https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/test/harness-tools-recovery.test.ts
[M1]: ../../packages/agent/src/skills.ts
[M2]: ../../packages/agent/src/jobs.ts
[M3]: ../../packages/agent/src/sessions.ts
[M4]: ../adr/0008-spawn-policy.md
[M5]: ../PROTOCOL.md
[M6]: ../ARCHITECTURE.md
[M7]: ../adr/0018-dashboard-live-streaming.md

- [Durable API and experimental status][D]; [dependencies and Node floor][P].
- [Core format/identity specification][I]; [JSONL implementation][J].
- [Shutdown limitations][H]; [Node environment/process implementation][N].
- [Committed active-context view][V]; [tool recovery tests][T].
- [Source-only coding-agent services and worker responsibilities][E].
- [Durable coding-agent composition and locking][L].
- [Routing server][S]; [transport client][C]; [coding-agent packaging][Q].
- Mesh comparisons: [skill dispatch][M1], [job manager][M2], [session reader][M3],
  [spawn policy][M4], [protocol][M5], [architecture][M6], [stream contract][M7].
