# ADR 0022 - The control plane watches; the sync button stops being the operator's job

Status: proposed, revised after a plan review (the review's findings and the
corrections are recorded in "Review corrections" below)

## Context

The dashboard's session list is a SQLite mirror filled by a manual
`POST /api/sync` (`packages/control-plane/src/server.ts:422-535`). Nothing
refreshes it otherwise, so a session that starts on a node is invisible until the
operator clicks. `tasks/milestone-7.md` gave the *selected* session a live view,
but only as a pull the operator initiates (ADR 0018), and only for a session a
running job claims.

Two measurements decide the shape:

- **A listing is not cheap.** `SessionStore.list()` reparses every transcript on
  the machine (`packages/agent/src/sessions.ts:261-315`). Measured on the two
  nodes on 2026-11-06: artemis 521 sessions, phobos 142. A watch that re-lists on
  every change would spend its life parsing JSONL.
- **The agent already prefers polling to `fs.watch`** for the same class of
  problem, for a stated reason: `fs.watch` is platform-inconsistent and can miss
  events, which replay cannot tolerate (`packages/agent/src/stream.ts:16-18`).

The operator's request ("the control plane should actively ping for active
sessions on the nodes ... so the sync button should not be required") is satisfied
by updates arriving without a click. It does not require the agent to initiate a
connection.

## Decision

### 1. The control plane holds the subscription

The control plane opens one long-lived `message/stream` subscription per agent and
keeps it open. From the operator's chair this is push: the node emits changes
without being asked. On the wire the control plane is the caller, which is what
every other peer request already is.

**A callback is not refused as forbidden, it is refused as unnecessary.** ADR 0004
governs *advertisement* (`docs/adr/0004-inverted-discovery.md:11-19`), not
connection direction, and an agent-initiated callback would not by itself create a
new principal. What it would need is a new **proof direction**: every peer request
in this project is signed by its caller (ADR 0007), so an agent calling a control
plane would need a credential the control plane can verify as "this node", plus an
answer to "which of the paired control planes may this node call". A held socket
needs neither, and it degrades correctly on a mesh with no control plane at all
(ADR 0011). If a callback is ever wanted, it is its own ADR.

### 2. One new streamable skill: `mesh.watch`

The agent gains a skill that streams **inventory facts**, never transcript
content: a session added, a session's summary changed, a session removed, and a job
changing state.

This is a deliberate **supersession of ADR 0018's "the rule is not widened"**
(`docs/adr/0018-dashboard-live-streaming.md:55`), and the reason is that the two
surfaces are different questions. ADR 0009 forbids a second way to observe the
**same transcript** (`docs/adr/0009-live-event-stream.md:43-55`); an inventory feed
carries no entries and cannot be read as one. The server must not pretend
otherwise: admitting the skill to the existing handler is not enough, because that
handler requires `input.id` and picks a session-specific iterator
(`packages/agent/src/server.ts:901-918`), and the control plane's fan-out refuses
frames that are not `source: "live"`
(`packages/control-plane/src/streams.ts:308-320`). `mesh.watch` gets its own
dispatch, its own frame type, and its own buffer bound; the session-stream path is
untouched.

### 3. Deltas come from a metadata index, reconciled periodically

The watch keeps a per-path `(mtime, size)` index over the **enumerated** session
directories (`packages/agent/src/sessions.ts:207-235`), not just the root, because
an append happens inside an existing file. It stats on an interval (the reasoning
at `stream.ts:16`) and reparses only paths whose metadata **differs** - compared
for inequality, not for increase, so a clock that steps backwards is still a
change.

The tuple is an optimisation, not a correctness contract. The cases it must
handle, each with its own test:

- **Rename**: the path set is reconciled; a moved file is not a deleted session.
- **The name is derived, not stored**: a session's display name is its latest
  `session_info` entry (`sessions.ts:300-307`), so a rename or a clear inside the
  file is a summary change like any other.
- **Truncation**: a size decrease invalidates the summary and forces a reparse;
  a truncated file with no complete header is skipped with a stated reason, never
  emitted as an empty session.
- **Two writes inside one poll**: ordinary appends coalesce; same-size rewrites
  within one timestamp resolution can be missed, which is why the next item
  exists.
- **Reconciliation while connected**, not only on close: a periodic re-list
  repairs a silently missed change. Close-triggered reconciliation cannot repair a
  miss that never closes.

### 4. Deltas are not applied through `upsertSessions`

`upsertSessions` treats its input as a **complete listing** and deletes every
mirrored row absent from it (`packages/control-plane/src/db.ts:228-245`). Feeding
it one delta would delete the rest of that agent's sessions - a data-loss bug that
looks like a display bug. The store therefore gains explicit
`upsertSession`/`removeSession` (or an equivalent that never infers absence from a
partial input), and `upsertSessions` keeps its full-listing meaning for the sync
and bootstrap paths.

### 5. Lifecycle is explicit

- **Bootstrap:** the subscription starts with one complete listing, produced by the
  same code as sync, then switches to deltas.
- **Ownership:** one subscription per agent per control-plane process, shared by
  every browser and every request that needs it, in the shape ADR 0018 already uses
  for session streams.
- **Close:** any close - clean, error, backoff, capability withdrawn - marks the
  mirror stale and re-lists once. Reconnect uses bounded exponential backoff with
  jitter.
- **Shutdown and unpair are explicit**, not deferred to "the next request
  boundary", which a held stream may never reach: an unpair closes the
  subscription and evicts the mirror; process shutdown closes every subscription
  (the same requirement as `docs/adr/0018-dashboard-live-streaming.md:161-164`).
- **Browser delivery:** the dashboard gets its own SSE endpoint fed by the
  subscription, and re-renders without losing the selected session, an unsent
  draft, or scroll position.

### 6. Watching is not executing

The opening request is signed with the paired credential, exactly as every other
peer request is (ADR 0007). It needs no execution grant, no TLS/loopback
(ADR 0014 governs execution, not observation), and it creates no per-session
principal (ADR 0021). The execution dispatch gate
(`packages/agent/src/server.ts:893-896`) is not touched.

### 7. The old path stays until the new one is proven

`POST /api/sync` stays served. The dashboard stops *offering* the button for an
agent whose advertisement includes `mesh.watch`, and keeps offering it for one
that does not. Removing a working path in the same change that introduces its
replacement is how a mixed-version fleet becomes an outage; a three-machine
transcript (M8-10's pattern) is what retires the route, in a later change.

### 8. The mirror keeps its role

The mirror is a cache, not authority (ADR 0015). Changing how it is refreshed does
not make it authoritative, and nothing in the mesh depends on the control plane
being present.

## Out of scope

Transcript content in the browse view (ADR 0018's selected session), a findings
push (M8-9 has its own delivery path), an agent database, TLS termination, and any
change to how a session is spawned or steered.

## Consequences

- **Cost moves, it does not vanish.** One socket per agent at the control plane,
  and a directory stat per interval per node. The first snapshot stays expensive
  and is paid once per connection instead of once per click.
- **A delta can lie about liveness.** A file's metadata says a session was written
  to, not that a Pi process is running. The watch claims no liveness; job state
  comes from the jobs plane, and a discovered TUI transcript remains
  not-a-supported-root (M8-2).
- **Capability skew is visible, by design** (decision 7).

## Tests that must be able to fail

The discriminating test: **establish the watch, then create a named session on the
fixture agent, and require its frame and its dashboard row to appear before any
close, with the sync and list fallbacks forbidden for the duration.** With
`mesh.watch` deleted the frame cannot arrive and the assertion fails by name - not
by timeout.

Plus, each failing by its own named clause:
- a rename, a truncation, a backwards mtime, and a same-size rewrite, each
  producing the right outcome rather than a spurious delete;
- a delta applied to the mirror not removing another session (the
  `upsertSessions` data-loss case);
- a periodic reconciliation repairing a change the watch deliberately dropped;
- an agent that does not advertise `mesh.watch` leaving the button visible and the
  mirror unreachable without a click (positive control that the old path works);
- unpair and shutdown closing the subscription rather than leaving it open.

## Review corrections

A plan review (`plan-reviewer`, 2026-11-06) found five things, all applied above:
the callback rationale misused ADR 0004; widening the streamable rule supersedes
ADR 0018 rather than sitting beside it; the `(mtime,size)` tuple was stated as a
contract when it is an optimisation, with the directory-enumeration, rename,
truncation and clock cases missing; reconciliation-on-close cannot repair a silent
miss; and feeding deltas to `upsertSessions` would delete unrelated rows. It also
found the original reconciliation test would pass with the feature deleted, which
the discriminating test above replaces.
