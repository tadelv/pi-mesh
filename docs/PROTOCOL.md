# Protocol

pi-mesh uses the [A2A protocol](https://a2a-protocol.org) as its wire
format. This document specifies only the pi-mesh extensions and
conventions.

The targeted A2A revision is **1.0** (see `A2A_PROTOCOL_VERSION` in
`@pi-mesh/protocol`). Wire shapes in this document are defined against that
revision; a change of revision is a protocol change.

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

### Transcript encoding

The HMAC transcript is the four fields `client_nonce`, `server_nonce`,
`client_peer_id`, and `server_peer_id`, joined with one NUL byte (`\u0000`) in
that order and then UTF-8 encoded.

Field values MUST NOT contain `U+0000`, otherwise two distinct transcripts
could encode to the same bytes; a receiver MUST reject a `peer_id` or nonce
that contains one.

The `hmac` field is standard base64 (RFC 4648 section 4: 44 characters ending
in one `=`), and `nonce` is the base64 encoding of 32 random bytes.

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

pi-mesh carries A2A on the wire, and A2A reserves JSON-RPC codes
`-32001`-`-32099` for its own errors (`TaskNotFoundError` is `-32001`,
`TaskNotCancelableError` is `-32002`, and so on). pi-mesh errors therefore
start at `-32100` so that an A2A error and a pi-mesh error can never share a
number. See ADR 0005.

| Code | Meaning |
|---|---|
| `-32100` | Unauthorized (swarm key mismatch) |
| `-32101` | Unknown session |
| `-32102` | Process spawn denied (policy) |
| `-32103` | Peer unreachable |
| `-32104` | Handoff rejected |
| `-32600`-`-32699` | Reserved for standard JSON-RPC 2.0 errors |
