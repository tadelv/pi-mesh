# AGENTS.md — guide for the coding agent

You are implementing **pi-mesh**, a peer-to-peer mesh for Pi coding agents.
Read `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, and `docs/SECURITY.md`
before writing code. The requirements are frozen; if you find a gap,
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

## What to build first

Work through `tasks/milestone-0.md` in order. Do not start milestone 1
until milestone 0 is merged and CI is green.

## What NOT to do

- Do not add a database to `@pi-mesh/agent`. The agent is stateless
  except for its credentials file and process map.
- Do not implement GossipSub, ChromaDB, or shared memory yet. Those are
  milestone 3+.
- Do not add authentication to the local A2A server that runs on
  localhost. It is only reachable in-process.
- Do not invent a new pairing protocol. Use the token + fingerprint
  flow in `docs/SECURITY.md`.
