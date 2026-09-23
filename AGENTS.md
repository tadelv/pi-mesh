# AGENTS.md — guide for the coding agent

You are implementing **pi-mesh**, a peer-to-peer mesh for Pi coding agents.
Read `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, and `docs/SECURITY.md`
before writing code, and `docs/GOTCHAS.md` before trusting a green test run. The requirements are frozen; if you find a gap,
open an ADR in `docs/adr/` rather than improvising.

## Conventions

- **Language:** TypeScript, ESM only (`"type": "module"`).
- **Runtime:** Node.js >= 22. Do not use Bun-specific APIs.
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
caught five failures that no local gate saw (four test failures and one
workflow-config error), and most of the real defects found in the last two
milestones were tests that could not fail for the reason they claimed. These rules are what those cost. They are not ceremony.

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

**Milestone 3 is in progress.** `mesh.handoff` (M3-1) is implemented, tested and
verified Mac-to-Pi. `tasks/milestone-3.md` carries the remaining work and its
order, which is deliberate: a thin user-visible control-plane slice, then
packaging, then `docs/DEPLOYMENT.md`.

Read order for picking up M3 - nothing here needs context beyond these files:

1. `tasks/milestone-3.md` - the issues, their Definition of Done, what is
   deliberately out of scope, and what has already been proven on hardware.
2. `docs/ARCHITECTURE.md` and `docs/PROTOCOL.md` - what the system is and what
   actually goes on the wire.
3. `docs/adr/` - the frozen decisions. Start with 0005 (error codes), 0007
   (per-request HMAC), 0008 (spawn policy, plus its two amendments), 0009 (live
   event streaming) and 0010 (`mesh.handoff`).
4. `docs/two-machine-proof.md` - what has been seen running on real hardware,
   including the clauses that have *not*.
5. `docs/GOTCHAS.md` - read this before trusting a green test run.

## What to build first

Work through `tasks/milestone-3.md` in issue order. The requirements are frozen:
if you find a gap, open an ADR in `docs/adr/` rather than inventing a shape that
happens to suit the code you are writing.

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
