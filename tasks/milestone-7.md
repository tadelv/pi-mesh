# Milestone 7 - Watching a session work

M6 lets the operator choose what answers and which commands exist. It still shows
a frozen transcript: the dashboard re-reads session pages only when the operator
acts, so a session that is working right now looks like a session that stopped.

This is not a defect in the agent. `session.stream` already serves a live source
for a running job's session, A2A `message/stream` is implemented on both the
agent server and the agent client, and `PROTOCOL.md` documents the live frame.
The gap is that the control plane's `callAgent` is `message/send` only and the
browser has no stream at all (ADR 0011 declared it out).

The decision, the boundaries, and the honesty rules are in
`docs/adr/0018-dashboard-live-streaming.md` (accepted). This milestone implements
them; it does not re-decide them.

## In

1. A control-plane streaming client for `session.stream` over A2A
   `message/stream`, alongside `callAgent` (M7-1).
2. `GET /api/sessions/:agentId/:sessionId/stream`, SSE, token-by-header (M7-2).
3. The dashboard live overlay, with a durable-page fallback and bounded
   announcement (M7-3).
4. Connection lifecycle: one upstream per session, fan-out, close on unpair /
   shutdown / agent restart, backpressure closes rather than grows (M7-4).
5. Tests, docs, and a two-machine transcript (M7-5).

## Out

- **WebSocket.** SSE is one direction and the prompt already has a route.
- **Resuming deltas.** Live frames are ephemeral (ADR 0009 §3); reconnect re-reads
  the durable page.
- **The token in a URL.** No `EventSource`; a short-lived ticket is not this
  milestone's shape.
- **Incremental `session.read`.** Paging still re-reads; unchanged deferral.
- **Gating the stream.** Watching is a read (ADR 0009 §5), so no execution grant
  and no ADR 0014 transport gate. The plaintext-token exposure is recorded, not
  fixed, in ADR 0018.
- **A second streamable skill.** The agent server refuses any skill but
  `session.stream`; that stays.

## Issues

### M7-1 - control-plane streaming client

A sibling to `callAgent` that consumes the A2A `message/stream` SSE response and
yields frames. The agent client's `streamSkill` is the working reference.

**DoD:** frames arrive incrementally (assert more than one frame before the
upstream closes, not just a final one); the `source: "live"` discriminator
survives the hop; an agent error mid-stream is surfaced as a distinct outcome,
not an empty stream; the paired credential signs the request as `callAgent` does.

### M7-2 - the browser endpoint

`GET /api/sessions/:agentId/:sessionId/stream` served as `text/event-stream`,
authenticated with the existing `X-Pi-Mesh-Ui` header, opening an upstream M7-1
stream for a session that resolves to a running job per ADR 0016.

**DoD:** a session with no running job, an unreachable agent, an unconfirmed jobs
listing, or **more than one running job claiming the session** gets a stated
refusal rather than an empty stream - the ambiguity case has a two-competing-jobs
test that fails by name when the check is removed. The endpoint adds no process
machinery (the ADR 0013 guard test passes unchanged); an unauthenticated request
gets 401; the response is never buffered whole.

### M7-3 - the dashboard overlay

The selected session's transcript updates as frames arrive, falling back to the
durable page on disconnect, with the announcement buffered to entry boundaries.

**DoD:** entries appended from the stream appear without operator action; a
disconnect falls back to the page-read path and says the live view ended (a quiet
stream is not rendered as "the agent stopped"); a first **message** frame with
`source: "file"` is downgraded to the durable page rather than presented as live
(the leading A2A task frame carries no discriminator and is not the message
frame), and replayed entries are not duplicated into the transcript; the ownership
guard
from M5 still holds - a frame for session A cannot render over session B; entries
are announced through a dedicated polite status region at entry boundaries, not
per token, and not through the transcript panel (which has no live region today).

### M7-4 - lifecycle and bounds

**DoD:** one upstream per `(agent_id, session_id)` shared by every tab, closed
when the last subscriber leaves; unpair, control-plane shutdown, and agent restart
all close the upstream rather than leaking it; a slow subscriber is disconnected
rather than buffered without bound; a test that removes the close-on-last-subscriber
fails on the clause it names.

### M7-5 - tests, docs, proof

- `PROTOCOL.md`: the control plane's `/api/.../stream` endpoint and its frames.
- `PRODUCT.md` / `DESIGN.md`: live view vs record, and the fallback rule.
- `README.md`: the streaming bullet says what is live and what is a re-read.
- `README.md`'s "Verified on real hardware": a transcript of a second machine's
  session updating live, and the same session after the agent is stopped.

## Risks

- **A long-lived connection is new surface.** Shutdown, unpair and agent restart
  are the leak sites; M7-4's clause is the point of the issue.
- **A live view mistaken for the record.** Token deltas are not durable; the UI
  must keep saying so, and reconnect must not imply it recovered what it missed.
- **Buffering that turns one session into a memory leak.** The agent already
  bounds its replay ring; the control plane must not undo that with an unbounded
  fan-out queue.
- **Screen-reader flood.** The cheapest implementation is the worst one here;
  M7-3's boundary buffering is a requirement, not polish.

## Decisions

Settled by `docs/adr/0018-dashboard-live-streaming.md` (accepted): SSE over
`fetch`, running-job sessions only (ambiguity refused, not resolved), one upstream
fanned out, streaming is a read, the `source:"file"` downgrade path, and
dedicated status-region announcements. The ADR's "Verification this decision
commits to" section is the clause list these issues must make fail by name.

## Exit criteria

- A running session's transcript updates in the browser without operator action,
  and a stopped or unreachable agent falls back to the durable page with the
  reason stated.
- No stream survives unpair, shutdown or agent restart, and no subscriber can
  grow an unbounded buffer.
- The M5 ownership guard still holds with a stream in flight, and the ADR 0013
  guard test passes unchanged because the stream adds no process machinery.
