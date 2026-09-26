# Milestone 3 - Collaboration, not remote administration

Ordered by value, not by size. M2's closing note fixes the sequence and the
reason for it: `mesh.handoff` is first because it is the product's actual claim,
and it is bounded on purpose. If it slips twice, the honest move is to relabel
the product as fleet observability and control rather than keep promising
collaboration.

## In

1. `mesh.handoff` - a peer accepts a task, starts work, and hands back the
   handles to watch it (ADR 0010).
2. A thin, user-visible **control-plane vertical slice**: dashboard, SQLite and
   pairing as one narrow end-to-end path rather than three layers. The loopback
   listener arrives here as its first real consumer (ADR 0006 decision 3).
3. **Packaging**: `@pi-mesh/agent` is `"private": true` while `README.md` gives
   install instructions. Publish it, or keep the README honest.
4. `docs/DEPLOYMENT.md`, still a placeholder. It must carry the systemd scope with
   `KillMode=control-group`, because a hard-killed agent leaves tool commands
   behind on Linux as well as macOS (measured: ADR 0008 amendment).

## Issues

### M3-1 - `mesh.handoff`

- Input is the frozen `HandoffPayload`: `task`, `project`, `context`,
  `preferred_agent`, `deadline_ms`. No new envelope (ADR 0010 decision 1).
- It is an **execution skill**: registered unconditionally, gated by the same
  `gateExecution` path as `process.spawn`, refused with `-32102` when execution is
  disabled, and advertised only when it is enabled.
- Success returns `{ task_id, session_id, job_id }` - the handles that let the
  caller actually watch the work (ADR 0010 decision 3).
- `preferred_agent` naming another peer settles the task as `TASK_STATE_REJECTED`,
  which is **not** a JSON-RPC error and is not escalated (ADR 0010 decision 4).
- `task` becomes the child's initial prompt through the existing path; a non-empty
  `context` is rendered into that same prompt (ADR 0010 decision 7). `project`
  resolves under the workspace root with the usual containment check - it is not a
  free `cwd` (ADR 0010 decision 8).
- `deadline_ms` bounds **acceptance**, not execution (ADR 0010 decision 5).
- **DoD:**
  - A handoff to a peer with execution enabled starts exactly one session, whose
    prompt is the task (plus context when present), and returns all three ids.
  - A handoff with `preferred_agent` set to a different peer is rejected without
    starting anything - **no process, no session, no file** - and returns a
    rejected task rather than an error.
  - A handoff to a peer with execution disabled is `-32102`, and the capability
    surfaces agree (`process.spawn` and `mesh.handoff` appear together, or not at
    all) - ADR 0006 honesty, checked at the card and the DNS-SD `caps` boundary.
  - `deadline_ms` expiring before acceptance is a clean failure with nothing left
    running (`ps` shows no new `pi`, and the job table has no accepted entry).
  - A `project` that escapes the workspace root is refused by the same containment
    check as `process.spawn`; a symlink out of the root is refused too.
  - Rejection is distinguishable from denial: one is a settled rejected task, the
    other is `-32102`, and the test asserts the two differ rather than accepting
    either.
- **Evidence:** every clause must be broken and shown to fail by the clause it
  names. Two clauses deserve naming in advance, because they are the ones that
  cannot fail by accident: "rejection is not an error" passes trivially if the
  implementation never rejects, and "nothing was started" passes trivially if the
  process never started. Both need a positive observation (a settled rejected
  task; a process table before and after that is genuinely non-empty before).

## Outcome

`mesh.handoff` (M3-1) is **done and verified on hardware**, and this section is
what M3-2 should read before starting.

- Implemented in `9703bb5`; the CI race it exposed in `3081d31`; the hardware run
  in `README.md`'s "Verified on real hardware" (`913569a`).
- A handoff from the Mac started a real session on the Pi, which did the work and
  reported it - and the report is verifiable, because the commits it listed are the
  ones pushed from the Mac minutes earlier.
- The prompt the real session received carried the task *and* the context under the
  heading ADR 0010 pins, read back with `session.read`.
- A rejection settles `TASK_STATE_REJECTED` with no JSON-RPC error and starts
  nothing (0 `pi` processes before and after).
- A gate-closed machine drops `mesh.handoff` and `process.spawn` from the card
  together and answers `-32102` for both.
- Verified by breaking four things and confirming each break fails the clause
  naming it: neutering the gate (clause 3), dropping the project `cwd` (clause 5),
  reporting a rejection as `TASK_STATE_WORKING` (clauses 2, 4, 6), and dropping the
  context from the prompt (clause 1).
- **Not proven on hardware:** `deadline_ms` expiry, and the containment refusal for
  an escaping `project`. Both are covered by tests with mutation evidence, and
  neither should be described as verified on a real machine until it is.

### M3-2 - the control-plane vertical slice (write an ADR first)

`@pi-mesh/control-plane` exists as a stub. This issue asks for ONE narrow
end-to-end path - dashboard, SQLite and pairing - rather than three layers built
side by side, with the loopback listener arriving as the first real consumer of
ADR 0006 decision 3. Nothing about its shape is frozen yet, so **open an ADR before
writing code.** The constraint that will bite is the no-cloud rule in AGENTS.md:
any control-plane feature that assumes outbound internet is out of scope, and the
mesh must keep working with the control plane absent (constraint 1).

### M3-3 - packaging

`@pi-mesh/agent` is `"private": true` while `README.md` gives install
instructions. Either publish it or make the README honest. Do not leave the two
disagreeing, and do not publish as a side effect of another change.

### M3-4 - `docs/DEPLOYMENT.md`

Still a placeholder. It must carry the systemd unit with `KillMode=control-group`
and explain why: a hard-killed agent leaves tool commands behind on Linux as well
as macOS, because Pi's bash tool `setsid()`s each command out of the process group
the agent signals (measured; see the ADR 0008 amendment and `docs/GOTCHAS.md`). It
must also say plainly that the workspace root is an accident guard rather than
isolation.

## Outcome (M3-2)

`@pi-mesh/control-plane` is no longer discovery-only. The slice landed as one
end-to-end path, with the shape frozen in `docs/adr/0011-control-plane-vertical-slice.md`
and the optional intent router in `docs/adr/0012-jev-intent-routing.md` before
any code.

- **Agent:** accepts a paired control plane as a second authenticated principal
  on its existing listener (no new socket), and gains
  `pi-mesh-agent pair <token>`. The swarm path is unchanged, and a control id is
  credential-bound with no swarm-key fallback.
- **Control plane:** `serve` starts an HTTP dashboard, a `node:sqlite` store and
  the pairing handshake, and advertises itself over mDNS. `/api/*` requires a
  dashboard token; a token-authenticated pair derives a per-agent credential.
- **Optional:** a Jev intent router behind the dashboard command bar, off unless
  `TYPESAFE_API_KEY` is set (`/api/intent` is `501` otherwise and `503` on a Jev
  outage). Nothing on the read path depends on it.
  **Removed after M4** (`/api/intent`, the command bar, `intent.ts` and `jev.ts`
  are gone; ADR 0012 is withdrawn). Kept here because this file records what was
  built and what it cost, not only what survived.
- **Verified locally:** `pnpm -r build`, `typecheck`, every package's tests
  (shared 15, protocol 24, control-plane 39, agent 194), `lint` and
  `format:check` pass; a mutation removes each of the load-bearing behaviours and
  fails the clause naming it.
- **Verified on three machines (2026-09-23):** the control plane runs in a
  Portainer-managed Docker stack on `apollo` (`192.168.12.164`), and the Mac
  (`artemis`) and the Raspberry Pi (`devpi`) each paired to it with
  `pi-mesh-agent pair`, storing a credential at
  `~/.pi-mesh/control-credentials.json`. `POST /api/sync` pulled 423 sessions
  from the Mac and 12 from the Pi through the credential path; a live
  `session.read` returned 16 entries; and Jev routed "show me the sessions on
  devpi" to devpi's real peer id. Discovery was confirmed on the wire
  (`dns-sd -B _pi-mesh-control._tcp` → `apollo`), and the dashboard token held
  `TYPESAFE_API_KEY` in the container environment only, not the image or the
  repo.
- **Review:** an independent read-only reviewer found four blocking defects the
  gates did not — credentials returned by `/api/state`, an empty model choice
  read as session index 0, a hello proof replayable as the verify proof, and
  cached events rewriting history — plus a disabled command bar that stayed
  visible. All were fixed; the pairing proof is now direction-separated and the
  agent's address is recorded at hello.
- **Two defects only the real fleet exposed:** with both agents paired and 435
  sessions cached, every `/api/intent` call answered `503`. The first cause was
  a Choice above TypeSafe's 255-option limit; the second, which survived the
  option cap, was `400 max_tokens_exceeded` because the whole fleet was sent as
  the request state. Both are fixed (candidates capped at 50, and the state
  trimmed to the candidates) with tests that fail when the fix is removed. A
  stubbed suite could not have caught either, because a stub does not enforce a
  token budget.
- **Still not proven on hardware:** the offline cache against a *device* that
  goes away. It is exercised in-process by stopping the agent, and was not
  repeated by pulling the plug on a real one.

## Outcome (M3-3, M3-4)

- **M3-3 - packaging:** resolved by keeping the packages private and making
  `README.md` honest. The install section now presents the checkout path as the
  only real one, aliases the built CLI so the rest of the document reads
  normally, and says plainly that `npm install -g @pi-mesh/agent` does not work
  yet. Publishing was **not** done: there is no npm token for the `@pi-mesh`
  scope, and the three packages a release needs (`shared`, `protocol`, `agent`)
  are `private: true` and must ship together. `docs/DEPLOYMENT.md` records
  exactly what a release requires, so the decision is written down rather than
  implied by an install command that would fail.
- **M3-4 - `docs/DEPLOYMENT.md`:** written. It carries the systemd unit with
  `KillMode=control-group` and the measurement behind it (Pi's bash tool
  `setsid()`s each command, so a hard-killed agent leaves tool commands
  reparented to init in their own session, which no process-group signal
  reaches), states plainly that the workspace root is an accident guard and not
  isolation, and documents the control plane as a compose stack: mDNS and host
  networking, the data volume and backups, the revocation limit, and not
  port-forwarding the plaintext dashboard.

## Exit criteria

- A member can hand a bounded task to a peer that opted in, watch it work, and
  stop it - without a control plane and without the caller holding any credential
  but the swarm key.
- A member that did not opt in advertises no execution skill and refuses handoff
  with `-32102`.
- Nothing in this milestone requires outbound internet.

## Risks

- **The product claim and the feature can drift apart.** If handoff lands but
  nobody can route to a suitable peer, the mesh is still a remote-administration
  tool with extra words. M3-2's slice is what makes the claim usable; if it slips,
  say so in `README.md` rather than describing a capability nobody exercises.
- **Two spawn paths.** `mesh.handoff` must reuse the spawn path rather than growing
  a second one; the moment there are two, the gate has two places to be forgotten.
- **The workspace guard is an accident guard.** It is not isolation, and
  `DEPLOYMENT.md` must not imply otherwise (ADR 0008 amendment).
