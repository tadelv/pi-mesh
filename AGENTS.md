# AGENTS.md — guide for the coding agent

You are implementing **pi-mesh**, a peer-to-peer mesh for Pi coding agents.
Read `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, and `docs/SECURITY.md`
before writing code, and `docs/GOTCHAS.md` before trusting a green test run. The requirements are frozen; if you find a gap,
open an ADR in `docs/adr/` rather than improvising.

## Conventions

- **Language:** TypeScript, ESM only (`"type": "module"`).
- **Runtime:** Node.js >= 22.13.0. Do not use Bun-specific APIs. The control
  plane uses the builtin `node:sqlite`, which is only available without a flag
  from 22.13.0 (`docs/adr/0011`).
- **Package manager:** pnpm workspaces. Run `pnpm install` first.
- **Build:** `tsc -b` for each package, project references at the root.
- **Tests:** `vitest` for unit tests, `playwright` for the control plane UI.
- **Lint:** `eslint` + `prettier`. Zero warnings tolerated in CI.
- **Commit style:** Conventional Commits. One logical change per PR.
- **License:** GPL-3.0-or-later. Every new source file should carry
  an SPDX header: `// SPDX-License-Identifier: GPL-3.0-or-later`.

## Design constraints

1. **Mesh-first.** No component may assume a control plane is present.
   The mesh must function with agents alone.
2. **Inverted discovery.** The control plane advertises itself. Agents
   advertise only when a swarm key is configured.
3. **A2A as the wire protocol.** Do not invent new message envelopes
   unless the A2A spec has no equivalent. Document extensions in
   `docs/PROTOCOL.md`.
4. **No cloud dependencies.** Everything must run on a LAN with no
   outbound internet, except optional integrations (GitHub, etc.).
5. **Append-only session logs.** Mirror Pi's own event-log model.
   Never mutate past entries.
6. **Idempotent control commands.** A `process.stop` for an
   already-stopped process must succeed.

## Definition of done (per task)

- [ ] Code compiles with `pnpm -r build`.
- [ ] Unit tests added for new logic.
- [ ] Documentation updated if the public API changes.
- [ ] `docs/PROTOCOL.md` updated if a message or skill is added.
- [ ] No `TODO` left in committed code without a linked issue.
- [ ] PR description explains *why*, not just *what*.

## Verifying your own work

A green run is not evidence, and this repository has the scars to prove it: CI has
repeatedly caught failures that no local gate saw - test failures that passed on a
laptop, and workflow errors that nothing local runs - and most of the real defects
found in the last two milestones were tests that could not fail for the reason
they claimed. These rules are what those cost. They are not ceremony.

- **The failure line must name the clause.** A test whose failure is a transport
  error, a timeout, or a permission error from somewhere else is a non-answer: it
  reports identically whether the feature exists or not. Fix the harness first.
- **Break the thing the test protects** and check that the clause naming it is the
  one that fails. A test that passes with the implementation deleted is worse than
  no test, because it certifies absence.
- **Distrust the clause that cannot fail by accident.** "Rejection is not an error"
  passes trivially if nothing ever rejects; "nothing was started" passes trivially
  if nothing ever starts. Both need a positive control that is observably non-empty
  beforehand.
- **A fixture must refuse what reality refuses.** A stub that answers any request
  shape will hide a wire-format bug forever.
- **Deploy, then verify.** Checking against a machine still running the previous
  commit produces failures that look like product defects and are not.
- **Local gates are not CI.** The runner is Linux, with no `pi` binary and no model
  credentials, so the real-Pi clauses skip there. Read the CI result rather than
  assuming it covers what your laptop covered.
- **Test the test.** Observation-heavy issues here used a blind test author (a
  different model, forbidden to read `src/`), then an implementer, then an
  independent mutation pass. Those catch different failures - mirroring the
  implementation's bug versus not being able to fail at all - and neither
  substitutes for the other.

## Where the project is

Milestones 0, 1 and 2 are **done and closed**, and were verified on two real
machines on one LAN (a Mac and a Raspberry Pi), not only in tests. What exists
today: mDNS discovery, the swarmed A2A listener, file-backed sessions, bounded
and gated execution over Pi's RPC mode (`process.spawn`, `session.steer`,
`process.stop`, `session.abort`), live streaming of a session while it works, and
`mesh.handoff`.

**Milestone 3 is done and closed.** `mesh.handoff` (M3-1) is verified Mac-to-Pi;
the control-plane vertical slice (M3-2) - a dashboard, an SQLite cache and token
pairing (ADR 0011) - is verified
on three machines, a Portainer-managed Docker stack on apollo with the Mac and
devpi paired to it; packaging (M3-3) and `docs/DEPLOYMENT.md` (M3-4) are in.

**Milestone 4 is done and verified on three machines.** `README.md`'s "Steering"
and "Process control" bullets are true: the dashboard starts, steers, stops and
aborts on a paired agent by calling the agent's existing gated skills
(`docs/adr/0013-dashboard-control.md`) - two independent grants, one execution
path, and a per-agent opt-in by the control plane's id. The hardware proof is
summarised in `README.md`'s "Verified on real hardware".

**Milestone 5 is implemented and verified** (`tasks/milestone-5.md`): the
selected-session prompt, an inline-reviewed Start form, and Chromium regression
coverage. ADR 0016 fixes the identity and refusal model. The real-Pi prompt
turn, response, gate-closed refusal, deployed Portainer image and limitations
are summarised in `README.md`'s "Verified on real hardware". Actual screen-reader
speech is not verified. What remains is `README.md`'s "Someday" list and the
deferred encryption in `docs/SECURITY.md`.

**Milestone 6 is done and verified** (`tasks/milestone-6.md`): a model chosen
before a spawn (ADR 0017), the command surface, and a session status readout.
**Milestone 7 is done and verified** (`tasks/milestone-7.md`, ADR 0018): a
running session's transcript updates live in the dashboard over SSE - one
upstream fanned out per `(agent, session)`, an ambiguous or unconfirmed session
refused with a stated reason, and any close (`not-live`/`error`/`end`) falling
back to the durable page without claiming a missed delta. Both are summarised in
`README.md`'s "Verified on real hardware"; the first M7 hardware run found and
fixed a real subscriber-bound defect (recorded there).

Read order for revisiting M7 or changing the stream:

1. `tasks/milestone-7.md` and `docs/adr/0018-dashboard-live-streaming.md` - the
   clauses the stream must make fail by name.
2. `packages/control-plane/src/streams.ts` - the one-upstream fan-out and the
   bounded subscriber: the bound is on frames beyond the replay, not the replay.
3. `docs/GOTCHAS.md` - read this before trusting a green test run.

Read order for revisiting M5 or changing its execution path:

1. `tasks/milestone-5.md` - the issues, their Definition of Done, and what M5-1
   must settle before any code is written.
2. `docs/adr/0013-dashboard-control.md` and `docs/adr/0008-spawn-policy.md` - the
   two grants and the one gate every execution request must meet; M5's risk is a
   new path around them in the shape of a chat box.
3. `docs/adr/0015-job-listing.md` - the jobs mirror is non-authoritative, which is
   exactly why resolving a session to a job is a decision and not a lookup.
4. `docs/adr/0011-control-plane-vertical-slice.md` and `docs/PROTOCOL.md` - the
   credential and the wire the dashboard speaks.
5. `docs/GOTCHAS.md` - read this before trusting a green test run.

(For the M3 record, see `tasks/milestone-3.md` and the README's hardware proof.)

## What to build first

M5, M6 and M7 are complete; do not reimplement them. For a new issue, read its
requirements, the ADR it touches, and `docs/GOTCHAS.md` before trusting tests.
The requirements are frozen: if you find a gap, open an ADR in `docs/adr/`
rather than inventing a shape that suits the code.

## What NOT to do

- Do not add a database to `@pi-mesh/agent`. The agent is stateless
  except for its credentials file and process map.
- Do not implement GossipSub, ChromaDB, or shared memory yet. Those are
  milestone 3+.
- Do not add an unauthenticated route to the LAN listener. Every peer
  request carries its own proof (ADR 0007); the handshake is the only
  exception. There is no unauthenticated local server in v1 — and "only
  reachable in-process" is not a property loopback has, since any local
  process can reach a loopback port. Bind to loopback if you want that.
- Do not invent a new pairing protocol. Use the token + fingerprint
  flow in `docs/SECURITY.md`.
- Do not serve a dashboard execution route over plaintext, non-loopback
  HTTP. The dashboard token is an execution grant (ADR 0013) and a browser
  on an insecure origin cannot sign with it, so execution requires TLS or
  loopback (ADR 0014). `--allow-insecure-execution` is the only exception
  and it stays off by default.
