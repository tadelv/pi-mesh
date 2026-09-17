# Milestone 1 — Read-only mesh: sessions over authenticated A2A

Goal: two agents on a LAN complete an **authenticated** A2A request over
HTTP, and a peer can list, read and stream another agent's **real** Pi
sessions. No control plane, no web UI, no SQLite, no Pi subprocesses.

This is deliberately smaller than the first draft of this milestone. A
second look established that Pi's **session files** carry everything needed
for read-only introspection, and that Pi's **RPC mode** — the only reason to
spawn `pi` as a child process — is needed solely for steering and process
control. All of that moves to milestone 2, which removes every hard decision
about child-process ownership, authentication expiry mid-stream, and
interactive extension prompts, and removes CI's need for a real Pi binary and
a model provider.

## Scope

- **M1a — file-backed session introspection.** Provable on one machine with
  no network and no Pi process.
- **M1b — A2A transport.** Proves handshake, per-request authentication and
  task lifecycle across two real agents.

Evidence, verified in the Pi 0.85.1 install on hand:

- Sessions are a documented format at
  `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`: JSONL, entries
  linked into a tree by `id`/`parentId`, versioned headers (v1 linear, v2
  tree, v3 current), published entry types, and **string entry IDs in append
  order**. That append order is the replay cursor; there is no sequence
  number to invent.
- Pi's RPC mode exists but is **out of scope for M1**. See "Not in
  milestone 1".

## Decisions taken before coding

Recorded as ADRs in this milestone, not improvised:

- **ADR 0006 — one LAN listener, read-only exposure.** M1 exposes
  `session.list`, `session.read`, `session.stream` and `mesh.peers` to
  swarm peers. Process and steering skills are **not exposed to peers at
  all** until M2. `process.spawn` accepts `cwd` and `argv` and Pi runs with
  host permissions, so "any swarm member may spawn arbitrary processes" is a
  far larger grant than any document discusses — and `PI_MESH_SPAWN_DENIED`
  exists with no policy behind it. There is no loopback listener in M1
  because nothing in M1 consumes one; it arrives in M2 with the dashboard.
- **ADR 0007 — per-request HMAC, not a bearer token.** A reusable bearer
  sent over plaintext HTTP is capturable and replayable for its whole TTL,
  which breaks the guarantee in `docs/SECURITY.md` that passive observers
  cannot forge A2A messages. Each request carries a nonce and an HMAC
  derived from the swarm key, reusing the existing
  `computeHandshakeHmac`/`verifyHandshake` primitives. Confidentiality is
  still absent, exactly as `SECURITY.md` already states.
- **ADR 0008 — durable entry IDs are the cursor.** `Event.seq: number`
  becomes the Pi entry ID. `stream` tails newly appended session entries.
  Token-level `message_update` deltas are deferred; they carry neither an ID
  nor a timestamp and cannot be resumed.
- **ADR 0009 — task lifecycle.** Synchronous skills return an immediate A2A
  `Message`; in-memory `Task`s exist only for streaming, with a defined TTL.
  An expired or unknown task returns A2A's own `TaskNotFoundError`
  (`-32001`), never a pi-mesh code.

A useful consequence of ADR 0007: with no token there is no expiry to reason
about mid-stream. A stream is authorised once at establishment and allowed to
finish; reconnect requires a fresh request.

## Issues

### M1-1 — ADR 0006: listener topology, exposure boundary, disclosure
- One LAN-facing listener; which skills are exposed to peers and which are
  local-only; what a peer is authorised to read.
- State plainly that **binding to loopback** is the enforceable property —
  "only reachable in-process" is false, since any local process can reach a
  loopback port.
- Decide and document the disclosure boundary: swarm membership grants read
  access to the agent's sessions. That is a real grant and belongs in
  `docs/SECURITY.md`, not implied.
- Reconcile `ARCHITECTURE.md`'s "port assigned dynamically, advertised via
  mDNS TXT" with the fixed `PI_MESH_PORT` that M0 actually ships.
- **DoD:** ADR 0006 has Context, Decision, Consequences, and
  `ARCHITECTURE.md` plus `SECURITY.md` agree with it. No document still
  claims the loopback port is unreachable by other local processes.

### M1-2 — ADR 0007: request authentication and peer identity
- Per-request HMAC: what is hashed (method, path, body, nonce, timestamp),
  replay protection and its window, clock-skew tolerance, and what a
  rejected request looks like on the wire.
- The handshake's HTTP shape: the spec says `GET /handshake` with a JSON
  body, and a GET body is a genuine interop hazard. Settle the method and
  status codes, since the handshake sits **outside** the A2A JSON-RPC
  endpoint and therefore cannot return a JSON-RPC error code.
- Peer identity: mDNS ID, handshake ID, and agent-card identity must agree.
  M0 currently defaults identity to `hostname()` and fingerprint to
  `"unpaired"`; decide what identity is and its lifetime. Remove or define
  `fp` rather than leaving a placeholder that verifies nothing.
- **DoD:** ADR 0007 has Context, Decision, Consequences; `docs/PROTOCOL.md`
  describes the settled handshake and request-authentication flow; the swarm
  key never appears in a request or response body.

### M1-3 — ADR 0008: session event model and replay cursor
- `Event.seq: number` becomes the Pi entry ID (a string). Update
  `@pi-mesh/protocol` accordingly.
- Define `since` semantics for replay, and what `stream` emits: durable
  entries only, in append order.
- State explicitly that token-level deltas are not part of M1 and why
  (no stable identifier, not resumable).
- **DoD:** ADR 0008 has Context, Decision, Consequences; no type in
  `@pi-mesh/protocol` carries a numeric sequence; `ARCHITECTURE.md`'s
  "replay from the last cached sequence number" is reworded to the entry ID.

### M1-4 — ADR 0009: A2A task lifecycle and retention
- When a skill returns a `Message` and when it returns a `Task`.
- In-memory task store: TTL, what `tasks/get` on an expired task returns,
  cancellation semantics, and behaviour across an agent restart.
- **DoD:** ADR 0009 has Context, Decision, Consequences; a test asserts that
  an unknown or expired task yields A2A's `-32001`, proving ADR 0005's
  separation holds on the wire.

### M1-5 — File-backed session discovery: `session.list` and `session.read`
- Read the documented format; do not re-derive it.
- Handle versioned headers (v1/v2/v3) without assuming the current one. One
  malformed line must not break a listing.
- Session scope must be explicit: which sessions are returned, how project is
  derived, what the public session ID is, and that a caller can never supply
  a file path.
- **DoD:** fixtures generated from **pinned Pi 0.85.1** and committed, not
  hand-written, so the fixture cannot encode the parser's own misreading;
  every documented entry type is covered; `session.read` returns entries in
  append order and supports `since`.

### M1-6 — Durable session streaming
- Tail newly appended entries from the session file and emit them as `Event`s
  with entry-ID cursors.
- A partially written trailing line must not be emitted as a record. Records
  split on LF **only**: `U+2028`/`U+2029` are legal inside JSON strings and
  Node's `readline` splits on them, so a session containing either would be
  silently corrupted.
- Session lifetime is independent of subscribers: a disconnecting subscriber
  must not affect the session.
- **DoD:** a unit test whose payload contains `U+2028` inside a JSON string
  is delivered as one record, and the same test fails against a
  `readline`-based implementation; a half-written final line is withheld
  until its terminating LF arrives; a read-to-stream race between an initial
  `read` and a `stream` neither drops nor duplicates an entry.

### M1-7 — A2A 1.0 pin, type reconciliation, and external conformance
- Pin a concrete A2A 1.0 source (tag or commit) rather than the site's moving
  `/latest`, and cite it in `docs/PROTOCOL.md`.
- Reconcile `@pi-mesh/protocol` against it. Known drift: streaming update
  events carry `taskId`, not `id`; `TaskStatus.state` is one of the
  `TASK_STATE_*` values; the required `A2A-Version` request header is absent;
  `AgentCard.protocolVersion` and `capabilities` are marked optional although
  A2A requires them. `message/send`'s send-configuration field name is still
  unverified and must be read from the pinned source, not guessed.
- This is the reconciliation ADR 0005 already requires before any transport is
  written, and it comes **before** M1-8.
- **DoD:** a conformance test validates our request/response shapes against
  fixtures or generated types derived from the **pinned external source**, not
  against our own `AgentCard` interface. That distinction is the whole point:
  M0 shipped tests that asserted our own constant while the wire format was
  wrong.

### M1-8 — A2A HTTP server
- `GET /.well-known/agent-card.json`, and a JSON-RPC 2.0 endpoint exposing
  `message/send`, `message/stream`, `tasks/get` and `tasks/cancel`. The first
  draft omitted `message/stream` while requiring remote streaming.
- Map pi-mesh failures to the three codes in ADR 0005; let A2A's own errors
  pass through untouched.
- **DoD:** the agent card validates against the pinned A2A schema, includes
  the required fields and the `A2A-Version` header is honoured; an unknown
  task returns A2A's `-32001` and not a pi-mesh code; `message/stream`
  delivers a real event from a real streaming session.

### M1-9 — Request authentication, client and server
- Server middleware that rejects unsigned, wrongly signed, stale or replayed
  requests; client that signs them.
- **DoD:** verification is proven with **independent fixed vectors** and by
  asserting that the client verifies the server's challenge and the server
  verifies the client's response — two pi-mesh implementations sharing one
  mistaken interpretation would otherwise agree with each other. A captured
  request replayed verbatim is rejected. The swarm key never appears on the
  wire, asserted by scanning the exchange.

### M1-10 — A2A client
- Handshake, then authenticated calls to a peer discovered through the M0
  registry.
- **DoD:** a call to an unreachable peer fails as a **transport** error, not
  an RPC error (ADR 0005 decision 3); a call to a live peer returns its
  result; a rejected authentication surfaces as a distinguishable failure and
  not as an empty result.

### M1-11 — Read-only skills over the mesh
- `mesh.peers`, `session.list`, `session.read`, `session.stream`.
- Capability honesty: the agent card and the mDNS `caps` TXT record list only
  skills that are implemented **and** exposed on that listener.
  `docs/PROTOCOL.md`'s skill table currently advertises every skill
  unconditionally, including `mesh.handoff`, which M1 defers — a peer would
  be told about a capability that does not exist.
- **DoD:** agent A calls `mesh.peers` and `session.list` on agent B and gets
  B's real data; calling a not-exposed skill (for example `process.spawn`) is
  refused rather than attempted; the advertised `caps` list equals the set of
  skills the listener actually serves, asserted by requesting every
  advertised skill and every unadvertised one.

### M1-12 — CLI surface
- `pi-mesh-agent sessions [--peer <id>]`, `stream <session>`,
  `call <peer> <skill> [json]`, `doctor`.
- `doctor` reports the Pi version in use and the supported floor.
- **DoD:** every command writes machine-readable JSON to stdout (SSE for
  `stream`) with logs on stderr, so `| jq` keeps working as it does for
  `peers`; each command is asserted against a **real second agent**, since
  valid-JSON output alone does not prove it contacted the requested peer or
  skill.

## Not in milestone 1

- **Everything requiring a `pi` subprocess.** Spawning `pi --mode rpc`,
  child-process supervision, the process map, `process.spawn`,
  `process.stop`, `session.steer`, `session.abort`, and RPC event framing all
  move to milestone 2.
- Control plane: SQLite, web UI, pairing flow. Milestone 2.
- The loopback listener. No consumer exists until the M2 dashboard.
- `mesh.handoff`.
- Encryption. `docs/SECURITY.md` defers Noise/TLS; traffic stays plaintext on
  a trusted LAN, and M1 does not claim otherwise.
- GossipSub, shared memory, ChromaDB. Milestone 3+.
- Manual peer configuration or any non-mDNS discovery.

## Risks

- **Pi session-format drift.** Sessions auto-migrate to v3 when Pi loads them,
  so a reader must tolerate older versions rather than assume the current one.
  The floor is **Pi 0.85.1**, the version whose documentation this plan was
  written against.
- **A2A revision drift.** M1-7 pins a source; the pin is what makes M1-8
  reviewable. Without it, "conformant" is unfalsifiable.
- **Read-only is a real grant.** Swarm membership exposes session content to
  every member. That follows from the swarm-key model, but it must be stated
  rather than discovered.
- **No confidentiality.** Authentication is not encryption; anyone on the LAN
  can read session traffic. `SECURITY.md` already says so, and ADR 0007 must
  not appear to change that.

## Exit criteria

- CI green on `main`.
- A cross-machine, authenticated A2A call returns real session data **and** a
  streamed event from a live session, verified by the procedure in
  `docs/DEMO.md` and extended to cover it.
- A2A shapes validated against the pinned external source, not against our own
  types.
- ADRs 0006, 0007, 0008 and 0009 written.
- No open `TODO`s in `packages/`.
