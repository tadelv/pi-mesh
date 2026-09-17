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

| Code | Meaning |
|---|---|
| `-32001` | Unauthorized (swarm key mismatch) |
| `-32002` | Unknown session |
| `-32003` | Process spawn denied (policy) |
| `-32004` | Peer unreachable |
| `-32005` | Handoff rejected |
