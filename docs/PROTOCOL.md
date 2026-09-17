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
| `_pi-mesh-control._tcp` | Control plane | `id`, `name`, `version`, `api_version`, `port` |
| `_pi-mesh._tcp` | Agent (only when swarm key present) | `id`, `name`, `version`, `agent_version`, `port`, `caps` |

`caps` is a comma-separated list of skill names the agent serves, and it MUST
list exactly the skills the listener actually answers. Advertising a skill that
would be refused is worse than omitting it.

There is no `fp` key. M0 advertised a constant `"unpaired"`, which looks like
data and verifies nothing; the key returns when it has verification semantics
(ADR 0006).

mDNS TXT attributes are unordered `key=value` strings with no separate value
concept, so an entry whose value is empty reaches the wire as a bare `key=` and
parsers disagree about the result. A key whose value would be empty MUST be
omitted instead; a reader treats a missing key as an empty value.

## Agent card

Every agent serves `GET /.well-known/agent-card.json` on its listening
port. The card declares only the skills that listener serves.

Each skill also declares its **exposure**:

| Skill | Exposure | Input | Output |
|---|---|---|---|
| `mesh.peers` | peer | `{}` | `{ peers: PeerSummary[] }` |
| `session.list` | peer | `{}` | `{ sessions: SessionSummary[] }` |
| `session.read` | peer | `{ id, since? }` | `{ entries: Event[] }` |
| `session.stream` | peer | `{ id }` | SSE stream of `Event` |
| `session.steer` | **not served in M1** | `{ id, message }` | `{ accepted: boolean }` |
| `session.abort` | **not served in M1** | `{ id }` | `{ stopped: boolean }` |
| `process.spawn` | **not served in M1** | `{ project, cwd, argv? }` | `{ pid, session_id }` |
| `process.stop` | **not served in M1** | `{ pid, grace_ms? }` | `{ stopped: boolean }` |
| `mesh.handoff` | **not served in M1** | `HandoffPayload` | `{ task_id }` |

A peer exposure means the skill is reachable by any swarm member, and never
means unauthenticated: every request carries a proof (below). Process and
steering skills are withheld until milestone 2 defines a spawn policy; see
ADR 0006.

## Peer authentication

There are no sessions, tokens or cookies. Every request is independently
authenticated, so there is nothing to capture and replay (ADR 0007).

### Handshake

Two POSTs, because a `GET` with a JSON body is an interop hazard:

1. Client `POST /handshake` with `{ peer_id, nonce }`.
2. Server responds `{ peer_id, nonce, hmac }` where
   `hmac = HMAC-SHA256(swarm_key, client_nonce || server_nonce || peer_ids)`.
3. Client `POST /handshake/verify` with its own HMAC over the same transcript.
4. On success both sides have verified the other. Nothing is issued: the
   handshake proves the key, it does not establish a session.

The swarm key is never transmitted. Both sides derive the HMAC key from
the raw swarm key bytes.

The handshake sits outside the JSON-RPC endpoint, so its failures are HTTP
status codes (`401`) with a small JSON body, never a JSON-RPC error code.

### Request proof

Every other request carries:

| Header | Meaning |
|---|---|
| `X-Pi-Mesh-Peer` | Sender's peer ID |
| `X-Pi-Mesh-Nonce` | Unique per request, base64 |
| `X-Pi-Mesh-Timestamp` | ISO 8601 UTC |
| `X-Pi-Mesh-Signature` | base64 HMAC-SHA256 over the request transcript |

The request transcript is `method`, `path`, `sha256(body)`, peer ID, nonce and
timestamp, each followed by a single LF, then UTF-8 encoded.

A server MUST reject a nonce it has already accepted within the acceptance
window, and any request whose timestamp is more than 60 seconds from its own
clock. Both are constants, not configuration.

### Transcript encoding

For both the handshake and the request proof, fields are joined with one NUL
byte (`\u0000`) and then UTF-8 encoded.

Field values MUST NOT contain `U+0000`, otherwise two distinct transcripts
could encode to the same bytes; a receiver MUST reject a `peer_id` or nonce
that contains one.

The `hmac` field is standard base64 (RFC 4648 section 4: 44 characters ending
in one `=`), and `nonce` is the base64 encoding of 32 random bytes.

## Session events and replay

`session.list` returns one `SessionSummary` per session:

| Field | Meaning |
|---|---|
| `id` | The session-file header UUID |
| `project` | The header's working directory |
| `name` | Display name from a `session_info` entry, when the session has one |
| `started_at` | Header timestamp |
| `updated_at` | Last entry's timestamp — last activity, not an end time |

There is deliberately no `status` and no `ended_at`. Pi's session format
records no lifecycle state, so neither is derivable; a field that is always
`"unknown"` looks like data while carrying none, which is the same defect as
the removed `fp` TXT key (ADR 0006). `updated_at` is named for what it is.

A session's durable entries are the canonical event stream. Each `Event`
carries the **Pi entry ID** (a string) as its cursor, in the field `entryId`
to keep it distinct from a session ID; there is no numeric
sequence.

`session.read` accepts `since` as an entry ID and returns entries appended
after it. `session.stream` emits newly appended entries in append order.

Token-level streaming deltas are deliberately not part of v1: they carry
neither a stable identifier nor a timestamp and cannot be resumed, so they
could not participate in replay.

## Task lifecycle

Skills that answer immediately return an A2A `Message`. A `Task` is used only
where work outlives the request, which in M1 means streaming.

Tasks are held in memory and expire after 15 minutes. `tasks/get` for an
unknown or expired task returns A2A's own `TaskNotFoundError` (`-32001`) —
never a pi-mesh code (ADR 0005). Tasks do not survive an agent restart, and
`tasks/cancel` on an expired task is `TaskNotFoundError`, not success.

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
start at `-32100`, so an A2A error and a pi-mesh error can never share a
number. See ADR 0005.

These are application errors only. A2A 1.0 expects A2A-specific errors to
carry a `google.rpc.ErrorInfo` in `details` with a `reason` in
UPPER_SNAKE_CASE; the `reason` column below is the value pi-mesh sends there
once a transport exists to carry it.

| Code | `reason` | Meaning |
|---|---|---|
| `-32100` | `PI_MESH_UNAUTHORIZED` | Unauthorized (swarm key mismatch) |
| `-32101` | `PI_MESH_UNKNOWN_SESSION` | Unknown session |
| `-32102` | `PI_MESH_SPAWN_DENIED` | Process spawn denied (policy) |

Two conditions are deliberately **not** error codes:

| Condition | Represented as |
|---|---|
| Handoff rejected | A2A task state `TASK_STATE_REJECTED` |
| Peer unreachable | A transport failure (timeout or connection error) |

Representing either as a JSON-RPC error would give one condition two
representations and would conflate "the call failed" with "the call
succeeded and reported a negative outcome".

Standard JSON-RPC 2.0 errors (`-32600`-`-32699`) are used as the
specification defines them and are not redefined here.
