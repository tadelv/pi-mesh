# ADR 0018 - Live session streaming reaches the browser, as a view

Status: accepted (operator-settled; the decision points are resolved below)

## Context

The dashboard reads a session by paging `session.read`, and each page request
fetches the whole session from the agent before serving the cached page
(`PRODUCT.md`). The panel refreshes on `render()`
(`packages/control-plane/src/dashboard.ts`) and, since M5, on a bounded automatic
re-read after an accepted prompt (the `observePrompt` loop, `:317-344`) - but
there is no interval and no stream, so a session that is working now still looks
frozen unless the operator acts. ADR 0011 declared streaming out
(`docs/adr/0011-control-plane-vertical-slice.md:223-224`: *"No live streaming in
the dashboard; it reads cached and refreshed"*), and nothing has changed it since.

What already exists, and is thrown away:

- **The agent streams.** `session.stream` serves a live source when the id
  belongs to a locally running job; frames are the raw Pi RPC event with
  `source: "live"` and make no resumption promise. Otherwise it serves durable
  file entries with `source: "file"` and the existing resume cursor
  (`docs/PROTOCOL.md:323-339`, ADR 0009).
- **The peer wire streams.** A2A `message/stream` is implemented on both the
  agent server (`packages/agent/src/server.ts:505`, SSE at `:855-900`; it refuses
  any skill but `session.stream`) and the agent client (`streamSkill`,
  `packages/agent/src/client.ts:479`).
- **The control plane does not.** `callAgent` is `message/send` only
  (`packages/control-plane/src/client.ts:47-180`). It has no streaming sibling,
  so the dashboard cannot even ask.

So this is not a defect in the agent: it is a missing consumer. The decision is
what shape the consumer takes, because two transports are involved and each has
an auth question the other does not.

## Decision

### 1. The stream is a view; the session file stays the record

Unchanged from ADR 0009 §3, and restated here because the dashboard is the
surface most likely to forget it. Live frames are ephemeral and non-resumable.
The dashboard keeps its page-reads as the durable path and adds a live overlay
*only* for a session that belongs to a running job. On disconnect, the browser
re-reads the durable page and continues from there; it never claims the deltas it
missed. No past entry is mutated.

### 2. The control plane gains a streaming client, not a second skill

Add a sibling to `callAgent` that consumes `session.stream` over A2A
`message/stream` (the agent end already exists; the agent client's `streamSkill`
is the working reference implementation). It stays a read: `session.stream` is
ungated (ADR 0009 §5), so this needs the dashboard token and the paired agent
credential, and **not** the execution grant or ADR 0014's transport requirement -
those govern execution, and watching is not executing. The agent server's
one-streamable-skill rule (`server.ts:867`) is not widened.

### 3. The browser hop is SSE over `fetch`, authenticated by header

`GET /api/sessions/:agentId/:sessionId/stream` on the control plane, served as
`text/event-stream` to the selected tab. The browser consumes it with
`fetch()` + `ReadableStream` rather than `EventSource`, because `EventSource`
cannot send the `X-Pi-Mesh-Ui` header and the dashboard token must never enter a
URL (`PRODUCT.md`). If a future implementation wants `EventSource`, it needs a
short-lived single-use ticket that is not the token - that is a larger change and
is not this ADR's default.

### 4. Only an unambiguously running job's session streams

The endpoint resolves `(agent_id, session_id)` to a running job by the same rule
as ADR 0016: matching `session_id`, `state === "running"`, with the agent's jobs
table as the authority. Two things follow from ADR 0016 and from the code the
stream rests on:

- **Ambiguity is refused, not resolved by luck.** The agent's own live lookup
takes the *first* matching running job (`packages/agent/src/jobs.ts:483-491`) -
exactly the silent choice ADR 0016 forbids. If more than one running job claims
the session, the control plane offers no stream and states it; the operator must
disambiguate a job as the prompt path already requires. A session-ID-addressed
stream must not become the way around a decision ADR 0016 already made.
- **"Running" is checked, not implied by send.** `JobManager.send` rejects an
  `exited` job but still accepts a `stopping` one
  (`packages/agent/src/jobs.ts:556-566`), so the running check belongs to the
  endpoint's resolution, not to the transport's tolerance.

A session with no running job, an unreachable agent, or an unconfirmed jobs
listing gets no stream, with the reason stated. No cached row opens a stream.

### 5. One upstream per selected session, fanned out

At most one A2A stream per `(agent_id, session_id)` per control-plane process,
shared by every open browser tab on that session, closed when the last
subscriber leaves. Bounded buffers only: the agent already drops older events
past its replay ring (ADR 0009 §4), and the control plane must not reintroduce an
unbounded queue on the other side. Backpressure that would grow memory closes the
stream and tells the browser to fall back to page-reads.

### 6. Frames carry `source`, including when the source is not live

The control plane forwards the agent's frame discriminator (`source: "live"` vs
`"file"`) and an explicit end/disconnect signal. This is load-bearing, not
decorative: a confirmed running job can stop between the freshness check and the
attach, and the agent then serves the **file** source, which can replay the whole
durable session (`packages/agent/src/stream.ts:116-149`). The endpoint therefore:

- inspects the first **message/data** frame's `source` - the A2A task frame is
  written first and carries no discriminator (`packages/agent/src/server.ts:899`),
  so it is not a message frame and is skipped - and on `"file"` does not present
  it as a live overlay; this ADR's promise is not silently downgraded;
- does not merge replayed file entries into the transcript on top of the page
  already rendered (no duplicate entries); it falls back to the durable page and
  states that the session is not live here;
- treats a *message* frame with no discriminator as a protocol error, not as live.

A closed stream is not evidence the turn ended; a quiet stream is not evidence
the agent is gone. Nothing is inferred from absence.

### 7. Announcements go to a dedicated status region

The transcript panel has **no** `aria-live` region today - the earlier draft of
this ADR asserted one existed. The transcript's existing status region is
`#transcript-status` (`role="status" aria-live="polite"`), alongside other
status elements (`#auth-note`, `#status`) at
`packages/control-plane/src/dashboard.ts:215-219`; `#transcript-panel` at `:219`
has none. Live frames
do not land in a live transcript: token deltas would flood a screen reader.
Appended **entries** are announced through a dedicated polite status region at
entry boundaries, and the panel itself stays silent - the same restraint M5
applied to `#transcript-status`.

## Resolved points

- **SSE, not WebSocket.** SSE matches the agent wire and is one direction; the
  dashboard sends prompts through the existing POST route, so there is nothing to
  send back. `fetch()` + `ReadableStream` in the browser, with the
  `X-Pi-Mesh-Ui` header.
- **Transport posture.** The stream keeps the dashboard's existing posture rather
  than inventing a second rule. It is recorded explicitly that a plaintext LAN
  observer still recovers a token that can execute elsewhere - ADR 0014's concern
  is not removed by the stream being a read.
- **Screen-reader churn.** Token-level deltas never reach a live region; a
  dedicated status region announces entry boundaries (decision 7). Behavior, not
  transport; noted for the M7 implementation.

## Verification this decision commits to

These are the clauses M7 must make fail for their own named reason - not a
timeout, a transport error, or an empty stub:

- **Deltas before completion.** A live frame arrives while the agent's turn is
  still running - asserted by more than one frame before the upstream closes, not
  by a final payload.
- **Header authentication.** The browser request carries `X-Pi-Mesh-Ui` and no
  token appears in a URL or query string.
- **Ambiguity refuses.** Two running jobs claiming one session yield no stream and
  a stated reason; deleting the ambiguity check makes that test fail by name.
- **Source downgrade.** A `source: "file"` first frame produces the durable-page
  fallback with no duplicated entries, not a live-looking overlay.
- **One upstream, two tabs.** Two subscribers on one session open one upstream;
  the last unsubscribe closes it, and removing the close makes the teardown test
  fail by name.
- **Shutdown and unpair.** Control-plane shutdown and agent unpair each close the
  stream; no upstream survives them.
- **Bounded overflow.** A subscriber that stops reading is disconnected rather
  than buffered without limit.
- **Reconnect reconciliation.** After a drop, the page re-reads the durable
  session and does not claim the missed deltas.

## Consequences

- The dashboard finally shows work happening; the "frozen session" complaint is
  addressed at the source instead of by a polling loop that would re-read whole
  session files.
- The control plane gains a long-lived outbound connection it did not have, so
  shutdown, pair/unpair, and agent restart all need to close it. That lifecycle is
  new surface and is the main implementation risk.
- No protocol extension: `message/stream` and `session.stream`'s live shape
  already exist and are documented. `PROTOCOL.md` gains only the control plane's
  `/api/.../stream` endpoint description.
