# ADR 0009: Spawned sessions stream live events, not polled session files

Status: accepted

## Context

The mesh can start work on a peer (`process.spawn`, ADR 0008) but not *watch* it.
The only way to observe a running session is `session.read`, which returns the
durable entries written so far, so a peer polls a file and waits.

That was measured during the first dogfooding run: a session on the Raspberry Pi
spent minutes running the test suite, and the only window into it was a single
`session.read` afterwards, returning 9 entries. Polling is not merely wasteful
here, it is the wrong shape - it shows the answer after the work, when what a
peer wants is progress during it. Watching a remote agent work is the product;
`session.read` is the log.

The question was whether Pi offers streaming, or whether we would have to tail the
session file ourselves. Pi offers streaming, and we were throwing it away.

## Decision

### 1. Pi already streams; we consume it instead of watching files

`pi --mode rpc` writes JSON lines to stdout *during* operation (`docs/rpc.md`,
section "Events"): `agent_start`, `turn_start`/`turn_end`, `message_start`,
`message_update`, `message_end`, `tool_execution_start`/`_update`/`_end`,
`bash_execution_update`, `queue_update`, `compaction_*`, `agent_settled`.

`message_update` is the token-level feed: an `assistantMessageEvent` carrying
`text_start`/`text_delta`/`text_end`, `thinking_delta`, and `toolcall_start`/
`toolcall_delta`/`toolcall_end`. `tool_execution_update` streams tool progress.

`PiRpcClient` already re-emits each of these (`rpc.ts:546`,
`this.emit("event", message)`) and `jobs.ts` discards them - it looks at the
stream only to learn that the session is ready and that the child terminated.

So there is no file watcher to write, no polling interval to tune, and no new
dependency. The events are already on our side. Note that `fs.watch` was
deliberately avoided in `stream.ts` for platform reasons; that reasoning is now
moot for live sessions, because the live source is a pipe we already own.

### 2. `session.stream` gains a live source; it does not become a second skill

A `session.stream` request whose id maps to a **running job** is served from that
job's live RPC event stream. Anything else keeps today's behaviour: the durable
session file, polled with the existing cursor and retry logic.

The job table already carries the join key: `JobRecord.sessionId` is set when the
child reports state (`jobs.ts:292`), so "is this session live here, and which RPC
client owns it" is a lookup we can already answer.

One skill, one surface, one client code path. A new `session.attach` skill would
mean two ways to observe a session and a rule for choosing between them, for no
capability the discriminator does not already provide.

### 3. The two sources are distinguishable, and are NOT interchangeable

Session file entries are durable and resumable - `Event.entryId` exists precisely
so a client can reconnect and resume from where it was. An RPC delta stream is
**ephemeral**: deltas are not replayed, and a client that reconnects cannot ask
for the `text_delta` it missed.

That difference is load-bearing, so it is explicit rather than papered over:

- Live frames carry `source: "live"` and make **no resumption promise**.
- File frames keep `source: "file"` (today's shape) and remain resumable.

What makes an ephemeral stream safe is that it is never the only copy. Everything
durable Pi writes lands in the session file, so a reconnecting client resumes the
durable log and loses only deltas it could not have stored anyway. The stream is a
view; the file is the record.

### 4. Bounded replay on attach, so a late peer is not blind

A peer that attaches mid-turn should not have to wait for the next delta to learn
what is happening. Each job keeps a bounded ring of recent events (cap: 256
events or 64 KiB, whichever is hit first) and a new subscriber receives it before
the live tail. The bound follows the same reasoning as the `rawChunks` cap: an
unbounded buffer turns one long-running session into a memory leak on a 2 GB
machine. Older events are dropped, not held - the file covers the gap.

### 5. Streaming is not gated

Reading a session is a read operation, and membership grants read (ADR 0008
decision 1). `session.stream` stays ungated, so a member who may not run work can
still watch work another member started.

## Consequences

- The poll pain is fixed at the source: `session.read` remains the durable log and
  the reconnect path; live observation comes from the stream.
- No protocol extension is needed beyond documenting the live frame discriminator
  and its non-resumable promise in `docs/PROTOCOL.md`. No invented envelopes.
- The CLI gains a follow mode, which is where the difference becomes visible to a
  human: `session.stream` printing deltas as they arrive instead of one JSON blob.
- The alternative of tailing the session file was rejected: it is a second,
  slower, lossier implementation of a feed Pi already gives us, and it would show
  message boundaries rather than tokens.
