# Council brief - operator product feedback on pi-mesh (2026-xx)

Read-only council. Parent: the pi-mesh operator's assistant. The operator (repo
owner, running the mesh on three machines) gave five product requests. The point
of the council is to decide **scope, shape and order** for each, not to write
code.

## Repo and ref

`/Users/vid/development/repos/pi-mesh` at `61fc185` (main, one local commit
ahead of origin). Read whatever you need.

Authority documents (these are frozen; a gap gets an ADR, not an improvisation):
`AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/SECURITY.md`,
`docs/GOTCHAS.md`, `docs/adr/0007-per-request-hmac.md`,
`docs/adr/0008-spawn-policy.md`, `docs/adr/0011-control-plane-vertical-slice.md`,
`docs/adr/0013-dashboard-control.md`, `docs/adr/0014-dashboard-transport.md`,
`docs/adr/0018-dashboard-live-streaming.md`,
`docs/adr/0021-oversight-of-runs.md`, `tasks/milestone-8.md`.

## Where the project is (parent-verified facts)

- Milestones 0-7 are done and hardware-verified on three machines
  (`README.md` "Verified on real hardware").
- Milestone 8 (delegation + run oversight) is in progress: M8-1..M8-5 are
  committed (`f7bccee`, `aba1072`, `601ce61`, `965d97f`, `a13fdc0`, `d82927a`);
  M8-6 (addressable child transcripts), M8-7 (control-plane mirrors + read-only
  fleet panel), M8-8 (run control behind the folded grant), M8-9 (findings
  across the fleet) and M8-10 (docs + three-machine transcript) are not started.
- Today the dashboard's session list comes from a SQLite **mirror** and is
  filled by a manual sync (`packages/control-plane/src/server.ts` around the
  `/api/sync` handler and `jobs_synced_at`); live streaming is a pull: the
  control plane opens one upstream SSE per `(agent, session)` on demand
  (`packages/control-plane/src/streams.ts`, ADR 0018).
- The control plane runs as a Portainer-managed Docker stack on `apollo.local`
  port 7331. Three machines are paired to it: `apollo` (Linux), `artemis`
  (Linux), both with agents; and this machine `phobos` (macOS) is **not** in the
  mesh: it has only `~/.pi-mesh/credentials.json` holding a bare `peerId`, no
  agent process, no pairing.
- `pi-intercom` v0.18.1 is installed on `artemis` (and the operator believes
  on `phobos`; it is not in `~/.pi/agent/npm/node_modules` there). What it is:
  a Pi extension that joins a **per-machine local IPC broker** and gives Pi
  sessions 1:1 messaging (`intercom` tool: list/send/ask/reply), rendering
  inbound messages into the recipient's transcript and triggering a turn.
  Sessions must have loaded the extension. It is explicitly same-machine only;
  a non-Pi process is not a session.
- The dashboard already renders `(session.name || session_id) + ' - ' +
  basename(session.project)` and groups by agent label; unnamed sessions
  therefore show a bare UUID.

## The five requests (verbatim intent, compressed)

R1 **Setup.** "I need more help with setup. Add `phobos` (this computer) to the
mesh; the control plane is on `apollo.local:7331` as a Portainer stack, the
Portainer API key is on apollo."

R2 **Push instead of sync.** "The control plane should actively ping for active
sessions on the nodes; the nodes should have an overseer/observer process (is it
the agent?) that streams any Pi session change back to the control plane, so the
sync button is not required."

R3 **Dark mode** in the control-plane UI.

R4 **Intercom.** "With pi-intercom it should be easy to connect and steer active
sessions without destructive attach. Even more, the mesh-observer agent could
monitor intercom for live sessions and spawn sessions if needed, but steer them
over intercom."

R5 **Session list UI.** "A list of unrecognisable UUIDs - show the last path
component instead, and use a collapsible dropdown to show sessions inside that
path."

## Questions for you

For **each** of R1-R5:

1. **Verdict:** ship now, ship later (which milestone), or refuse - and the one
   reason that decides it.
2. **Smallest correct shape:** the minimum change that satisfies the request,
   naming the file/module it lands in, and explicitly what it must NOT add (new
   route, new principal, second execution gate, new transport, agent-side
   database, control plane dependency in the mesh).
3. **The trap:** what looks easy in that request and is actually the expensive or
   forbidden part. For R2 and R4 this is the substance of the question: a
   node-side push stream and an intercom-driven steer both touch ADR 0008's one
   gate, ADR 0013's grant, ADR 0014's transport rule, ADR 0021's "no per-session
   principal", and ADR 0004's inverted discovery. Say which of those a naive
   version breaks, and what the honest version is.
4. **Ordering:** relative to M8-6..M8-10, what goes first, and what would you
   cut from M8 to make room.

Also answer: **is the observer/overseer the agent process, or a second process?**
and **does R2 make R5's sync-populated mirror obsolete, or does the mirror still
need to exist?**

## Output contract

Return the structured report; keep it under ~600 words. Cite file paths and ADR
numbers as sources. Mark an assumption `unverified` rather than presenting it as
fact. Do not edit anything, do not run mutating commands, do not spawn children.
