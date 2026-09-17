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
  with TTL-based pruning (default 30s).
- An mDNS responder never re-announces an unchanged record, so a peer must
  not be pruned on "no announcement recently": liveness is refreshed by
  re-querying on an interval, and only a peer that stops answering ages out.
  `docs/DEMO.md` has the two-device check for this.
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
      "preferred_agent": "optional-peer-id",
      "deadline_ms": 60000
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
