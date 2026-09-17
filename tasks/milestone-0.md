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
- Two-device mDNS discovery verified by the procedure in `docs/DEMO.md`.
  (Originally this required a committed asciinema/GIF recording. Dropped:
  a terminal dump cannot be re-run, cannot be reviewed, and its own run was
  too short to surface a peer-registry defect that a longer run did catch.
  The durable artifact is the procedure, not the recording.)
- All ADRs written.
- No open `TODO`s in `packages/`.
