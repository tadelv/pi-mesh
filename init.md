# init.md — Bootstrap pi-mesh

You are bootstrapping a new TypeScript monorepo called **pi-mesh**.
This file contains the full specification. Execute it top to bottom.

## Instructions for the executing agent

1. Read this entire file before writing anything.
2. Create every file listed in the **File tree** section, using the
   content from the corresponding `=== FILE: ... ===` block.
3. Do not invent files. Do not skip files. Do not rename files.
4. Run the **Validation** section at the end.
5. Report: files created, commands run, any failures.

## Conventions

- Package manager: **pnpm** (workspaces).
- Node floor: **22.x**.
- Module system: **ESM only** (`"type": "module"`).
- License: **GPL-3.0-or-later**.
- npm scope: **@pi-mesh**.

## File tree

    pi-mesh/
    ├── AGENTS.md
    ├── README.md
    ├── LICENSE
    ├── .gitignore
    ├── .editorconfig
    ├── package.json
    ├── pnpm-workspace.yaml
    ├── tsconfig.base.json
    ├── .github/workflows/ci.yml
    ├── docs/
    │   ├── ARCHITECTURE.md
    │   ├── PROTOCOL.md
    │   ├── SECURITY.md
    │   ├── DEPLOYMENT.md
    │   └── adr/
    │       ├── 0001-mesh-over-hub-spoke.md
    │       ├── 0002-a2a-as-transport.md
    │       ├── 0003-swarm-key-auth.md
    │       └── 0004-inverted-discovery.md
    ├── examples/docker-compose.yml
    ├── scripts/
    │   ├── dev.sh
    │   └── build.sh
    ├── tasks/milestone-0.md
    └── packages/
        ├── shared/
        │   ├── package.json
        │   ├── tsconfig.json
        │   └── src/index.ts
        ├── protocol/
        │   ├── package.json
        │   ├── tsconfig.json
        │   └── src/index.ts
        ├── agent/
        │   ├── package.json
        │   ├── tsconfig.json
        │   └── src/index.ts
        └── control-plane/
            ├── package.json
            ├── tsconfig.json
            └── src/index.ts

## Note on LICENSE

Do **not** paste GPL-3.0 text manually. Instead, after creating the
tree, run:

    curl -fsSL https://www.gnu.org/licenses/gpl-3.0.txt -o LICENSE

and verify the file begins with "GNU GENERAL PUBLIC LICENSE".

---

=== FILE: .gitignore ===
node_modules/
dist/
build/
coverage/
*.log
.DS_Store
.env
.env.*
!.env.example
.pi-mesh/
*.tsbuildinfo
=== END FILE ===

=== FILE: .editorconfig ===
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.md]
trim_trailing_whitespace = false
=== END FILE ===

=== FILE: package.json ===
{
  "name": "pi-mesh",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "license": "GPL-3.0-or-later",
  "engines": {
    "node": ">=22.0.0"
  },
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "build": "tsc -b",
    "clean": "tsc -b --clean && rm -rf packages/*/dist",
    "test": "pnpm -r --if-present test",
    "lint": "pnpm -r --if-present lint",
    "dev": "./scripts/dev.sh"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
=== END FILE ===

=== FILE: pnpm-workspace.yaml ===
packages:
  - "packages/*"
=== END FILE ===

=== FILE: tsconfig.base.json ===
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "incremental": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
=== END FILE ===

=== FILE: .github/workflows/ci.yml ===
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
      - run: pnpm -r --if-present test
      - run: pnpm -r --if-present lint
=== END FILE ===

=== FILE: AGENTS.md ===
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
=== END FILE ===

=== FILE: README.md ===
# pi-mesh

A self-hosted mesh network for Pi coding agents across your local network.

Peers discover each other over mDNS, exchange work directly via the
[A2A protocol](https://a2a-protocol.org), and can be observed and steered
from an optional web control plane — no cloud, no central server required.

## Why

Running Pi on multiple devices (workstation, laptop, Raspberry Pis) means
losing visibility into what each instance is doing. pi-mesh gives you:

- **Peer discovery** — find other Pi instances on your LAN automatically.
- **Direct handoff** — agents pass tasks and context to each other.
- **Fleet overview** — a web dashboard for sessions, projects, and PRs.
- **Steering** — attach to any session from the dashboard and redirect it.
- **Process control** — start and stop Pi sessions on remote devices.

## Install

On each device that runs Pi:

    npm install -g @pi-mesh/agent
    pi-mesh-agent keygen > ~/.pi-mesh/swarm.key
    pi-mesh-agent start

Deploy the control plane (optional but recommended):

    docker compose -f examples/docker-compose.yml up -d

Open http://localhost:7331 and pair your agents with a token.

## Security model

- Agents only advertise on the LAN when a **swarm key** is present.
- Peer connections are authenticated with an HMAC challenge-response
  derived from the swarm key.
- The control plane uses token-based pairing for UI access.
- No mDNS record is published without a swarm key — safe on untrusted nets.

See [docs/SECURITY.md](docs/SECURITY.md).

## Packages

| Package | Purpose |
|---|---|
| `@pi-mesh/protocol` | Shared types, agent card schema, A2A message definitions |
| `@pi-mesh/agent` | The CLI daemon that runs on each device |
| `@pi-mesh/control-plane` | Web dashboard, registry, session cache |
| `@pi-mesh/shared` | Logging, error types, small utilities |

## Status

Pre-alpha. See [tasks/milestone-0.md](tasks/milestone-0.md) for the
current scope.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
=== END FILE ===

=== FILE: docs/ARCHITECTURE.md ===
# Architecture

## Nodes

| Node | Role |
|---|---|
| **Agent** | Runs on every device with Pi. Speaks A2A, manages local Pi processes, joins the mesh. |
| **Control Plane** | Optional. An agent plus a web UI, SQLite store, and project aggregators. |

The agent is the only required component. The control plane is a peer
with extra skills.

## Discovery

- Control plane publishes `_pi-mesh-control._tcp` via mDNS.
- Agents publish `_pi-mesh._tcp` **only when a swarm key is present**.
- Agents browse for both service types and maintain a peer registry
  with TTL-based pruning.
- No manual address configuration in v1. Manual peer fallback is
  deferred to a future milestone.

## Transport

- **A2A JSON-RPC over HTTP** between peers.
- Each agent runs a local HTTP server (default port assigned dynamically,
  advertised via mDNS TXT).
- Streaming uses SSE (`message/stream`).
- The control plane connects to agents the same way any peer does —
  there is no privileged channel.

## Session model

- Pi remains the source of truth for session state.
- Agents expose `session.list`, `session.read`, `session.stream`,
  `session.steer`, `session.abort` as A2A skills.
- The control plane caches snapshots in SQLite for offline viewing.
  On reconnect, it replays from the last cached sequence number.

## Work handoff

A handoff is a standard A2A `message/send` with a `pi-mesh.handoff`
extension payload:

    {
      "task": "run tests for repo X",
      "project": "my-repo",
      "context": { },
      "preferred_agent": "optional-peer-id"
    }

The receiving agent either accepts (returns a `task` with a stream) or
rejects (returns a structured error). Rejections are silent — no
escalation to an orchestrator.

## State and persistence

| Layer | Storage | Lifetime |
|---|---|---|
| Agent credentials | `~/.pi-mesh/credentials.json` | Persistent |
| Agent swarm key | `~/.pi-mesh/swarm.key` | Persistent |
| Agent peer registry | In-memory | Process lifetime |
| Control plane store | SQLite | Persistent |
| Session snapshots | Control plane SQLite | Persistent (bounded by config) |

Agents hold no persistent state beyond credentials and the swarm key.
This is intentional: an agent can be killed and restarted without
losing mesh membership.

## Failure modes

| Scenario | Behavior |
|---|---|
| Control plane offline | Mesh continues. UI unavailable. |
| Peer goes silent | TTL expires; peer removed from registry. |
| Session process dies | Agent emits `session.ended` with exit code. |
| mDNS blocked | No discovery. Manual config deferred. |
| Swarm key mismatch | Peer handshake fails; peer marked incompatible. |
=== END FILE ===

=== FILE: docs/PROTOCOL.md ===
# Protocol

pi-mesh uses the [A2A protocol](https://a2a-protocol.org) as its wire
format. This document specifies only the pi-mesh extensions and
conventions.

## mDNS service types

| Service | Advertised by | TXT keys |
|---|---|---|
| `_pi-mesh-control._tcp` | Control plane | `id`, `name`, `version`, `api_version`, `port`, `fp` |
| `_pi-mesh._tcp` | Agent (only when swarm key present) | `id`, `name`, `version`, `agent_version`, `port`, `fp`, `caps` |

`caps` is a comma-separated list of skill names the agent supports.

## Agent card

Every agent serves `GET /.well-known/agent-card.json` on its local
port. The card declares skills:

| Skill | Input | Output |
|---|---|---|
| `session.list` | `{}` | `{ sessions: SessionSummary[] }` |
| `session.read` | `{ id, since? }` | `{ entries: Event[] }` |
| `session.stream` | `{ id }` | SSE stream of `Event` |
| `session.steer` | `{ id, message }` | `{ accepted: boolean }` |
| `session.abort` | `{ id }` | `{ stopped: boolean }` |
| `process.spawn` | `{ project, cwd, argv? }` | `{ pid, session_id }` |
| `process.stop` | `{ pid, grace_ms? }` | `{ stopped: boolean }` |
| `mesh.peers` | `{}` | `{ peers: PeerSummary[] }` |
| `mesh.handoff` | `HandoffPayload` | `{ task_id }` |

## Swarm key handshake

Every peer connection begins with a challenge-response:

1. Client sends `GET /handshake` with `{ peer_id, nonce }`.
2. Server responds with `{ peer_id, nonce, hmac }` where
   `hmac = HMAC-SHA256(swarm_key, client_nonce || server_nonce || peer_ids)`.
3. Client verifies the HMAC, then sends its own HMAC over the same
   transcript.
4. On success, the connection is authenticated. All subsequent A2A
   messages are accepted without per-message signing.

The swarm key is never transmitted. Both sides derive the HMAC key from
the raw swarm key bytes.

## Handoff extension

Extension URI: `https://pi-mesh.dev/extensions/handoff/v1`

    {
      "task": "string",
      "project": "string",
      "context": { },
      "preferred_agent": "peer-id | null",
      "deadline_ms": 60000
    }

## Error codes

> **Superseded — do not copy this table.** These assignments predate ADR 0005,
> which moved pi-mesh's own codes above A2A's reserved `-32001`-`-32099` range
> because they collided with A2A's own errors (`-32001` is
> `TaskNotFoundError`, `-32003` is `PushNotificationNotSupportedError`). The
> live codes are in `packages/shared/src/errors.ts` and `docs/PROTOCOL.md`.
> Copying this table into ADR 0008 is exactly how the collision came back.

| Code | Meaning |
|---|---|
| `-32001` | Unauthorized (swarm key mismatch) |
| `-32002` | Unknown session |
| `-32003` | Process spawn denied (policy) |
| `-32004` | Peer unreachable |
| `-32005` | Handoff rejected |
=== END FILE ===

=== FILE: docs/SECURITY.md ===
# Security model

## Threat model

We assume an adversary on the same LAN who can:

- Observe mDNS traffic.
- Connect to any listening TCP port.
- Send arbitrary A2A messages.

We do **not** assume the adversary can break HMAC-SHA256 or read the
swarm key file from disk.

## Network profiles

The agent supports two profiles, set via `--profile`:

| Profile | Behavior |
|---|---|
| `lan` (default) | Advertise via mDNS if swarm key is present. Accept inbound peer connections. |
| `public` | Do not advertise. Do not accept inbound. Only connect to peers discovered through a trusted control plane. |

Use `public` on untrusted networks (coffee shops, conferences, hotels).

## Swarm key

**Format:** base64-encoded 32 bytes (256 bits).

**Generation:** `pi-mesh-agent keygen > ~/.pi-mesh/swarm.key`

**Storage:** `~/.pi-mesh/swarm.key`, mode 0600.

**Distribution:** manual, out-of-band. Copy the file to each device.
Future: `pi-mesh-agent join <code>` for QR-based sharing.

**Usage:**

1. **Advertisement gate.** No swarm key → no mDNS advertisement.
2. **Peer authentication.** Challenge-response HMAC over a nonce
   transcript (see PROTOCOL.md).

The swarm key is **not** used for message encryption in v1. Traffic on
the LAN is plaintext HTTP. Confidentiality relies on the LAN being
trusted. Encryption is deferred to a future milestone that adds Noise
or TLS.

## Pairing with the control plane

The control plane does not share the swarm key. It pairs with each
agent separately:

1. Control plane generates a short-lived token (TTL 10 min, single use).
2. User runs `pi-mesh-agent pair <token>` on the target device.
3. Agent and control plane exchange fingerprints over an ephemeral
   channel, then persist a per-agent credential.
4. Subsequent connections use the credential, not the token.

Revoking an agent from the control plane UI invalidates the credential
without affecting mesh membership.

## What the swarm key protects against

- Rogue peers joining the mesh.
- Passive observers forging A2A messages.
- Agents accidentally advertising on untrusted networks (public profile).

## What it does not protect against

- Eavesdropping on session content (plaintext HTTP).
- Malicious peers who already possess the swarm key.
- Physical access to a device with the key on disk.

## Revocation

To revoke a compromised swarm key:

1. Generate a new key: `pi-mesh-agent keygen > ~/.pi-mesh/swarm.key`
2. Distribute to trusted devices.
3. Restart agents. Peers with the old key will fail the handshake and
   be removed from the registry.

There is no online revocation list in v1.
=== END FILE ===

=== FILE: docs/DEPLOYMENT.md ===
# Deployment

Placeholder. To be filled in during milestone 2.

Planned content:

- Installing `@pi-mesh/agent` on Linux (systemd unit), macOS (launchd
  plist), and Windows (service wrapper).
- Deploying the control plane via `docker compose`.
- Reverse-proxy guidance for exposing the control plane on a VPN.
- Backups for the control plane SQLite database.
=== END FILE ===

=== FILE: docs/adr/0001-mesh-over-hub-spoke.md ===
# ADR 0001 — Mesh topology over hub-and-spoke

## Context

The control plane could either mediate all agent communication (hub-and-
spoke) or allow agents to talk directly (mesh). Mediated communication
simplifies auth and observation but adds a hop and makes the control
plane a hard dependency.

## Decision

Adopt a mesh topology. Every agent is a peer. The control plane is a
peer with extra skills (UI, persistence, aggregation).

## Consequences

- Agents must discover each other without a broker. mDNS is used.
- Session state is eventually consistent across the mesh.
- The control plane can be offline without breaking the mesh.
- Gossip and shared memory become natural future extensions.
=== END FILE ===

=== FILE: docs/adr/0002-a2a-as-transport.md ===
# ADR 0002 — A2A as the wire protocol

## Context

We need a message format and RPC shape for peer communication. Options
considered: custom JSON-RPC, gRPC, A2A.

## Decision

Use the [A2A protocol](https://a2a-protocol.org) as the wire format.
Extend it via declared extensions where needed (handoff, control).

## Consequences

- Agent cards, task lifecycle, and streaming come for free.
- Interop with non-Pi A2A agents becomes possible.
- Some pi-mesh-specific behaviors (inverted discovery, server push)
  require extensions documented in `docs/PROTOCOL.md`.
=== END FILE ===

=== FILE: docs/adr/0003-swarm-key-auth.md ===
# ADR 0003 — Swarm key for mesh authentication

## Context

Agents must authenticate each other on an untrusted LAN without a PKI.
Options considered: per-peer tokens, Tailscale identity, shared PSK.

## Decision

Use a shared 256-bit **swarm key**, distributed out-of-band, mode 0600
on disk. The key gates mDNS advertisement and drives an HMAC
challenge-response for peer authentication.

## Consequences

- Simple to set up: one file copied to each device.
- No central authority to run or trust.
- Revocation requires redistributing a new key to all peers.
- Traffic is not encrypted in v1; key is auth-only.
=== END FILE ===

=== FILE: docs/adr/0004-inverted-discovery.md ===
# ADR 0004 — Inverted discovery

## Context

In a hub-and-spoke design, agents advertise and the control plane
browses. In a mesh design, all peers advertise. But advertising from a
laptop on a hostile network leaks presence and capabilities.

## Decision

Invert discovery for agents: they advertise `_pi-mesh._tcp` **only**
when a swarm key is present **and** the profile is `lan`. Otherwise
they browse-only.

## Consequences

- A laptop in a coffee shop publishes nothing unless explicitly told to.
- Public-profile agents cannot be discovered by the mesh; they must
  find peers proactively.
- The swarm key doubles as an advertisement gate.
=== END FILE ===

=== FILE: examples/docker-compose.yml ===
services:
  control-plane:
    build:
      context: ..
      dockerfile: packages/control-plane/Dockerfile
    image: pi-mesh/control-plane:dev
    container_name: pi-mesh-control-plane
    restart: unless-stopped
    ports:
      - "7331:7331"
    volumes:
      - pi-mesh-data:/var/lib/pi-mesh
    environment:
      PI_MESH_PORT: "7331"
      PI_MESH_DB: "/var/lib/pi-mesh/pi-mesh.db"
      PI_MESH_LOG_LEVEL: "info"

volumes:
  pi-mesh-data:
=== END FILE ===

=== FILE: scripts/build.sh ===
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r --if-present test
=== END FILE ===

=== FILE: scripts/dev.sh ===
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install
pnpm -r build
exec pnpm --filter @pi-mesh/control-plane dev
=== END FILE ===

=== FILE: tasks/milestone-0.md ===
# Milestone 0 — Foundation (Week 1–2)

Goal: a compiling monorepo with protocol types, a scaffolded agent
CLI, and an mDNS publisher/browser that two devices can use to see
each other. No A2A yet. No control plane yet.

## Issues

### M0-1 — Scaffold pnpm workspace
- Create `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`.
- Add packages: `protocol`, `agent`, `control-plane`, `shared` (empty stubs).
- Configure `tsc -b` project references.
- Add CI workflow that runs `pnpm -r build && pnpm -r test`.
- **DoD:** `pnpm -r build` succeeds with empty packages.

### M0-2 — Implement `@pi-mesh/shared`
- Logger with structured JSON output and level control.
- `PiMeshError` base class with error codes from PROTOCOL.md.
- Small utilities: `sleep`, `retry`, `readJsonFile`.
- **DoD:** 100% coverage on shared utilities, no `any` in exports.

### M0-3 — Implement `@pi-mesh/protocol` (types only)
- Agent card types, skill enum, TXT record types.
- A2A message types: `message/send`, `message/stream`, `tasks/get`,
  `tasks/cancel` (types only, no transport).
- Handoff extension type.
- Discovery constants: service types, TXT keys.
- **DoD:** Every type used in ARCHITECTURE.md and PROTOCOL.md is exported.
  No runtime code beyond constants.

### M0-4 — Swarm key generation and loading
- `pi-mesh-agent keygen` writes base64(32 random bytes) to stdout.
- Loader reads `~/.pi-mesh/swarm.key`, validates length and permissions.
- Refuse to start with a world-readable key; emit a clear error.
- **DoD:** Unit tests for valid key, missing key, wrong length,
  wrong permissions.

### M0-5 — mDNS publisher (control plane side stub)
- Minimal CLI in `control-plane` that publishes `_pi-mesh-control._tcp`
  using `bonjour-service`.
- TXT record contains `id`, `name`, `version`, `api_version`, `port`, `fp`.
- **DoD:** `dns-sd -B _pi-mesh-control._tcp` on macOS shows the service.
  Test on Linux with `avahi-browse`.

### M0-6 — mDNS publisher + browser in agent
- Publish `_pi-mesh._tcp` **only when swarm key is loaded** and
  profile is `lan`.
- Browse for both `_pi-mesh._tcp` and `_pi-mesh-control._tcp`.
- Maintain an in-memory peer registry with TTL (default 30s).
- CLI command `pi-mesh-agent peers` prints the registry as JSON.
- **DoD:** Two agents on the same LAN see each other within 5 seconds.
  Killing one removes it from the registry within TTL.

### M0-7 — Handshake implementation
- Implement the challenge-response from PROTOCOL.md.
- `verifyHandshake(localKey, remoteResponse, transcript)` returns bool.
- Unit tests with fixed keys and nonces.
- **DoD:** Test vectors committed; passing on Node 22.

### M0-8 — `docs/adr/` stubs
- Write ADRs 0001–0004 as one-paragraph records summarizing decisions
  already made in this thread.
- **DoD:** Each ADR has Context, Decision, Consequences.

### M0-9 — `examples/docker-compose.yml`
- Placeholder compose file that starts an empty control-plane image.
- Not wired to a real server yet — just proves the image builds.
- **DoD:** `docker compose up` starts a container that exits 0.

## Not in milestone 0

- A2A HTTP server or client.
- Session introspection.
- Steering or process control.
- Web UI.
- SQLite.
- Pairing flow.

## Exit criteria

- CI green on `main`.
- Two-device mDNS discovery demonstrated in a recorded terminal session
  (asciinema or GIF) committed to `docs/demos/`.
- All ADRs written.
- No open `TODO`s in `packages/`.
=== END FILE ===

=== FILE: packages/shared/package.json ===
{
  "name": "@pi-mesh/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "license": "GPL-3.0-or-later",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run --passWithNoTests"
  }
}
=== END FILE ===

=== FILE: packages/shared/tsconfig.json ===
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
=== END FILE ===

=== FILE: packages/shared/src/index.ts ===
// SPDX-License-Identifier: GPL-3.0-or-later

export const PACKAGE_NAME = "@pi-mesh/shared";
=== END FILE ===

=== FILE: packages/protocol/package.json ===
{
  "name": "@pi-mesh/protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "license": "GPL-3.0-or-later",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@pi-mesh/shared": "workspace:*"
  }
}
=== END FILE ===

=== FILE: packages/protocol/tsconfig.json ===
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../shared" }
  ]
}
=== END FILE ===

=== FILE: packages/protocol/src/index.ts ===
// SPDX-License-Identifier: GPL-3.0-or-later

export const SERVICE_TYPE_MESH = "_pi-mesh._tcp";
export const SERVICE_TYPE_CONTROL = "_pi-mesh-control._tcp";

export type Skill =
  | "session.list"
  | "session.read"
  | "session.stream"
  | "session.steer"
  | "session.abort"
  | "process.spawn"
  | "process.stop"
  | "mesh.peers"
  | "mesh.handoff";
=== END FILE ===

=== FILE: packages/agent/package.json ===
{
  "name": "@pi-mesh/agent",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "license": "GPL-3.0-or-later",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "pi-mesh-agent": "./dist/cli.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@pi-mesh/protocol": "workspace:*",
    "@pi-mesh/shared": "workspace:*",
    "bonjour-service": "^1.2.1"
  }
}
=== END FILE ===

=== FILE: packages/agent/tsconfig.json ===
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../shared" },
    { "path": "../protocol" }
  ]
}
=== END FILE ===

=== FILE: packages/agent/src/index.ts ===
// SPDX-License-Identifier: GPL-3.0-or-later

export const PACKAGE_NAME = "@pi-mesh/agent";
=== END FILE ===

=== FILE: packages/control-plane/package.json ===
{
  "name": "@pi-mesh/control-plane",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "license": "GPL-3.0-or-later",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@pi-mesh/protocol": "workspace:*",
    "@pi-mesh/shared": "workspace:*",
    "bonjour-service": "^1.2.1"
  }
}
=== END FILE ===

=== FILE: packages/control-plane/tsconfig.json ===
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../shared" },
    { "path": "../protocol" }
  ]
}
=== END FILE ===

=== FILE: packages/control-plane/src/index.ts ===
// SPDX-License-Identifier: GPL-3.0-or-later

export const PACKAGE_NAME = "@pi-mesh/control-plane";
=== END FILE ===

---

## Validation

After creating all files, run:

    chmod +x scripts/*.sh
    pnpm install
    pnpm -r build
    pnpm -r test
    curl -fsSL https://www.gnu.org/licenses/gpl-3.0.txt -o LICENSE
    head -n 1 LICENSE

Expected results:

- `pnpm install` completes without errors.
- `pnpm -r build` exits 0 (empty packages compile).
- `pnpm -r test` exits 0 (no tests yet, `--passWithNoTests`).
- `LICENSE` first line contains "GNU GENERAL PUBLIC LICENSE".

## Report back

Summarize:

1. Files created (count and any deviations from the tree).
2. Command outputs from the validation section.
3. Any errors and how they were resolved.
4. Confirm that `AGENTS.md`, `README.md`, and `tasks/milestone-0.md`
   are ready for the next agent to pick up milestone 0 work.
