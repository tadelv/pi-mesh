# ADR 0020 — Reuse Pi's durable runtime; prove shared-session attachment first

Status: accepted (research-informed direction and spike scope; production runtime migration is not approved)

## Context

We want to maintain the mesh, not a second agent harness. The
[research](../research/pi-durable.md) checked published Pi Durable **1.0.2** and
upstream release commit `cd32f7725fdbddbaecdff5b1e68491563394e0ca`. Hard-crash
recovery, persisted submission deduplication, committed snapshots and idle
steering passed a credential-free probe with SQLite and JSONL on macOS, Node
22.19.0 and 26.10.0. These checks establish a useful foundation, not equivalence
with our deployed Pi execution path.

Pi Durable is an experimental **agent runtime**, not a supervisor for existing
`pi --mode rpc` children. It owns conversation entries, model/tool tasks, queued
input, recovery, compaction, usage and live state. Our current model loop and
ordinary persistence are already Pi's; savings require retiring our RPC and
live-state plumbing, not adding another scheduler around it.

The multi-client capability is especially valuable: upstream's
[service RPC server](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/server/README.md)
supports multiple presentation attachments to one Session. Its
[coding-agent application](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/src/experimental/services/README.md)
has a worker-owned Harness, a session-directory writer lock, a shared Transcript
service and an AgentController. That application is **experimental and
source-only**, excluded from npm and standalone builds. The published
`pi-server`/`pi-client` libraries provide routing and transport, not the complete
coding-agent daemon or its authorization policy.

## Decision: what to adopt now

1. **Raise the supported runtime baseline to Pi >=1.0.2 and Node >=22.19.0.**
   Align the documented requirements, package engine and doctor's reported Pi
   floor. This is a support baseline, not a new startup version-enforcement
   mechanism. Keep older saved-session fixtures and read compatibility; a newer
   installed Pi requirement does not invalidate historical conversations.
2. **Approve a narrow, isolated Durable spike, not a production switch.** Pin
   `pi-durable`, `pi-ai` and Chord to the researched 1.0.2 release for the spike.
   Reuse their public submission, task/recovery, abort, configuration, committed
   watch and entry-paging APIs. Do not implement our own durable scheduler,
   inbox, retry journal or state reducer. New trial sessions only: never open
   normal Pi JSONL files with Durable's backend.
3. **Make shared-session attachment the spike's primary integration check.**
   Evaluate upstream's existing experimental server with two clients/TUIs
   observing the same session, rather than building another terminal client or
   copying its worker manager into pi-mesh. Keep any source checkout pinned and
   outside the deployed path. This is an evaluation of an upstream application,
   not a promise that installing Pi 1.0.2 enables `pi server`/`pi client`.
4. **Prefer an upstream-owned execution service as the migration destination.**
   One local worker owns a session's Harness, storage and tools; presentation
   clients attach to it. A future mesh adapter translates our existing skills
   into upstream controller/model/transcript operations over a private local
   connection. LAN traffic stays authenticated A2A, not Pi's CBOR/Chord protocol.
   Adopt the upstream application when its supported packaging and required
   behavior permit it; do not fork its experimental composition to ship sooner.

The [exported coding-agent `RpcClient`](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/src/modes/rpc/rpc-client.ts)
is also worth comparing before maintaining more protocol code, but **is not
approved as a drop-in replacement** for our supervised client. In 1.0.2 it
merges the parent environment, retains stderr without our bound, and does not
provide our process-group, record-size and per-command deadline guarantees.
Wrapping away all those differences may cost more than it removes. Merely
raising the version floor must not weaken them.

## Shared-session semantics

**Attachment** means another view/controller of an already-owned runtime. It is
not **resume**, which starts a new process against a saved conversation (ADR
0019), and it is not opening one file in two independent Pi processes. Ordinary
stdin/stdout RPC is a single child-process connection; upstream's multi-client
service RPC is a separate interface. Two dashboard tabs already share our A2A
upstream (ADR 0018); the new target is sharing the runtime with upstream TUI
clients too.

The spike must demonstrate:

- Two clients attach to the **same session and single runtime/writer**, and both
  receive committed transcript updates while a turn is still running.
- Input from either controller enters that runtime's submission/steering queue;
  it neither starts a second session nor writes directly to its storage.
- Detaching one client does not abort admitted work or disconnect the other.
  A late or reattached client receives the current committed snapshot, without
  claiming replay of every missed delta. Zero attached views alone must not
  retire a worker with live work.
- A runtime crash/reopen preserves the session and committed work. Abort stops
  current work; **terminal stop** must not become pending work that automatically
  resumes. Non-cooperative tool code still needs a process/supervisor boundary.

Multiple controllers do not create a new execution grant. Any future mesh or
browser controller still needs the existing authorization; a read-only attach
must not enable execution. Local socket access is application policy, not a
security guarantee supplied by Pi's experimental transport.

## What stays ours; what is deferred

Keep mesh discovery, per-request HMAC, pairing, execution opt-in, workspace/model
validation, admission/rate limits, owned-job control, unacknowledged-start cleanup,
A2A/SSE transport bounds, accessibility and the optional control-plane cache.
Mesh-first operation and both dashboard execution grants remain unchanged.

Do not migrate the deployed backend, remove the current job/session readers,
change protocol shapes or remove ADR 0019's warning as part of this decision.
Production migration needs a follow-up decision covering:

- Normal Pi extensions, skills, prompt templates, commands, credentials and
  existing saved-session compatibility.
- Mesh UUIDs/string cursors versus Durable's storage-local numeric IDs, and
  complete history versus its active-context view.
- Persistent execution storage and exclusive writer ownership. Prefer upstream
  storage ownership; a direct agent spike can use builtin JSONL rather than add
  an agent database. An upstream SQLite worker is not our control-plane cache.
- Explicit authorization before restart recovery: a machine restarted with its
  execution gate closed must not resume tools merely because work was persisted.
- Terminal stop/idempotence, background ownership, unacknowledged requests and
  resource/containment limits on the Raspberry Pi.
- Environment exclusion: Durable's `shellEnv` is an overlay, so supplying a
  filtered object alone does **not** remove inherited `PI_MESH_*` secrets. Use a
  filtered worker environment or explicit non-inheritance for every tool call.

Unsafe interrupted tools may have partially executed; Durable reports that
rather than promising exactly-once external effects. Do not mark arbitrary bash
or remote handoff replay-safe. Persisted `requestId` deduplication is not yet an
end-to-end mesh retry contract.

## Promotion gate

Adopt only when the adapter removes more maintenance than it introduces and the
above clauses fail by name when broken. Before deployment, verify configured Pi
compatibility, gate-closed restart, terminal stop, writer exclusion, secret
filtering, overflow/reconnect and operation without a control plane on macOS and
Linux, then on the actual Mac/Raspberry Pi fleet. The two-client/TUI demonstration
is a required new check, not a capability we currently advertise.
