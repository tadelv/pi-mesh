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
- Each agent runs **one** HTTP listener, LAN-facing, on a configurable port
  (`PI_MESH_PORT`, default 7330) which it advertises via mDNS TXT. Only the
  handshake (`POST /handshake`, `POST /handshake/verify`) and the agent card
  (`GET /.well-known/agent-card.json`) are reachable unauthenticated; every
  other route requires a per-request proof (ADR 0006, ADR 0007). The card must
  be public, since a peer cannot sign a request for an agent it has not yet
  discovered, and it discloses the agent's name, version and skill list - the
  name defaults to the hostname.
- Streaming uses SSE (`message/stream`).
- The control plane connects to agents the same way any peer does —
  there is no privileged channel.
- Agents serve read-only skills in v1. Process and steering skills are gated
  on an explicit per-machine opt-in and denied by default (ADR 0008); the
  spawn policy is what ADR 0006 deferred.

## Session model

- Pi remains the source of truth for session state.
- Agents expose `session.list`, `session.read`, and `session.stream` as A2A
  skills.
- The control plane caches snapshots in SQLite for offline viewing.
  On reconnect, it replays from the last cached **entry ID**, which is the
  cursor for a session's durable entries (ADR 0006's sibling decision; see
  `docs/PROTOCOL.md`). There is no numeric sequence to resume from.

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
rejects by settling the task as `TASK_STATE_REJECTED`. A rejection is not a
JSON-RPC error (ADR 0005); rejections are silent — no
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
