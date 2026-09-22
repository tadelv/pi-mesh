# Protocol

pi-mesh uses the [A2A protocol](https://a2a-protocol.org) as its wire
format. This document specifies only the pi-mesh extensions and
conventions.

The targeted A2A revision is **1.0**, pinned to a commit rather than to the
specification site's moving `/latest` page: `a2aproject/A2A` tag `v1.0.1`,
commit `3303592588e388e62e0f69f701af531d2f4e3991`. The normative file is
vendored verbatim at `packages/protocol/spec/a2a.proto` with its provenance
recorded alongside, and the conformance test derives expected field names from
that file rather than from our own declarations. A change of revision is a
protocol change.

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
| `session.steer` | **gated on the spawn policy** | `{ job_id (mesh id, not PID), message }` | Pi RPC response; refused with `-32102` when closed |
| `session.abort` | peer (ungated) | `{ job_id (mesh id, not PID) }` | Pi RPC response |
| `process.spawn` | **gated on the spawn policy** | `{ project, cwd?, prompt }` | `{ job_id, pid, session_id }` |
| `process.stop` | peer (ungated) | `{ job_id (mesh id, not PID) }` | `{ job_id, state, pid }` |
| `mesh.handoff` | **gated on the spawn policy** | `HandoffPayload` | `{ task_id, session_id, job_id }` on acceptance; `{ task: Task }` when rejected; refused with `-32102` when closed |

A peer exposure means the skill is reachable by any swarm member, and never
means unauthenticated: every request carries a proof (below).

**Gated** means reachable only from a peer the machine has explicitly allowed
to execute, and refused with `-32102` otherwise; see ADR 0008. Start enables the
local grant with `--allow-execution` (or, for a service manager, the lower-
precedence `PI_MESH_ALLOW_SPAWN` fallback). Three details of the shapes above
are load-bearing:

- `process.spawn` takes a required, non-blank `prompt` that starts the first
turn. It takes **no `argv`**. The server constructs the command line; a remote
caller chooses a project, not a program. Peer-chosen argv could change the
provider, the session directory, or which extensions load.
- `process.spawn`'s `cwd`, when given, must resolve inside the workspace root
  (which defaults to the user's home directory), because the realpath check is
  an accident guard and project selector. It is not a sandbox: the spawned
  agent can leave that directory at will.
- The child inherits the parent's environment except for every `PI_MESH_*`
  variable. This keeps mesh secrets out of the child without pretending to
  provide process isolation; Pi is not a sandbox.
- `process.stop` takes a **mesh job id**, never a bare PID. The agent stops only
  jobs it started and still tracks, so a peer cannot signal arbitrary processes
  on the machine.

Steering is gated with spawning because injected prompts cause tool
execution. Stopping is not gated: `session.abort` and `process.stop` are
allowed to any member, since reducing activity cannot be the more dangerous
operation.

## Skill invocation

A skill call uses the standard A2A `message/send` method. The request's
`Message` has `role: "ROLE_USER"` and one data part containing
`{ "skill": "session.list", "input": { ... } }`; the skill name is not a
custom JSON-RPC method or top-level field. A synchronous result is returned as
the A2A `SendMessageResponse` oneof wrapper: `{ "message": <Message> }` (or
`{ "task": <Task> }` for an asynchronous task). For a message response, the
agent `Message` has `role: "ROLE_AGENT"` and its data part contains
`{ "result": ... }`. Streaming calls use `message/stream` and return
`StreamResponse` objects over SSE, with the same result message shape for each
session event.

### Client

The agent package exports `handshake`, `call`, `sendSkill`, and `streamSkill`.
`streamSkill` consumes the authenticated `message/stream` SSE response. Failures
are classified as `PeerUnreachableError` for transport failures,
`PeerIdentityMismatchError` when discovery and handshake identities differ,
and `ClientProtocolError` for malformed or unsupported peer responses.
`ClientProtocolError.status` carries an HTTP status when one was received;
HTTP 503 handshake failures are therefore distinguishable and retryable.

## Peer authentication

There are no sessions, tokens or cookies. Every request is independently
authenticated, so there is nothing to capture and replay (ADR 0007).

### Handshake

Two POSTs, because a `GET` with a JSON body is an interop hazard:

1. Client `POST /handshake` with `{ peer_id, nonce }`, where `nonce` is the
   client nonce.
2. Server responds `{ peer_id, nonce, hmac }`, where `nonce` is a freshly
   generated **server** nonce and
   `hmac = HMAC-SHA256(swarm_key, client_nonce || server_nonce || peer_ids)`.
3. Client `POST /handshake/verify` with `{ peer_id, nonce, hmac }`, echoing the
   **server** nonce from step 2 and its own HMAC over the same transcript.
4. On success the server responds `200 {"ok":true}`. Nothing is issued: the
   handshake proves the key, it does not establish a session.

The verify step identifies the pending handshake by the echoed server nonce,
which is unique per hello. It MUST NOT accept the client nonce as an
alternative lookup key: a client that repeats a hello (a retry after a
timeout) leaves several pending handshakes that share one client nonce, so that
lookup is ambiguous, and resolving it by choosing one of them means verifying a
transcript the client may never have meant to send.

A failed handshake is `401` with `{"error": "<reason>"}`, or `503` when the
bounded pending-handshake table is full: that route carries no proof, so an
anonymous flood must not be able to displace the handshake a legitimate peer is
about to verify. Pending handshakes expire, and a proof naming an expired or
unknown nonce is refused like any other.

The swarm key is never transmitted. Both sides derive the HMAC key from
the raw swarm key bytes.

The challenge in step 2 is what makes a peer's `peer_id` provable rather than
merely claimed: the HMAC covers a transcript naming the server, so a peer that
produces a valid challenge has proven swarm membership for the `peer_id` it
sent. A client that dials an address directly (`--peer-host`) relies on
exactly this to learn a peer's identity without discovery. It cannot be
skipped on that path: every signed request binds the recipient into its
transcript, so an unproven identity would let a response addressed to one
agent authenticate at another (see ADR 0007).

The handshake sits outside the JSON-RPC endpoint, so its failures are HTTP
status codes (`401`, or `503` when the pending-handshake table is full), never
a JSON-RPC error code.

### Request proof

Which routes are unauthenticated, and why

Exactly three routes are reachable without a proof: `POST /handshake`,
`POST /handshake/verify` (both below), and `GET /.well-known/agent-card.json`.
The card is public by necessity - a peer cannot sign a request for an agent whose
identity and transport it has not yet discovered - and it discloses the agent's
name (the hostname, unless `PI_MESH_NAME` says otherwise), version and skill
list to anyone on the LAN. Everything else requires a proof.

Every other request carries:

| Header | Meaning |
|---|---|
| `X-Pi-Mesh-Peer` | Sender's peer ID |
| `X-Pi-Mesh-Nonce` | Unique per request, base64 |
| `X-Pi-Mesh-Timestamp` | ISO 8601 UTC |
| `X-Pi-Mesh-Signature` | base64 HMAC-SHA256 over the request transcript |

The request transcript is `method`, `path`, `sha256(body)`, sender peer ID,
**recipient peer ID**, nonce and timestamp **in that order**, joined per
[Transcript encoding](#transcript-encoding) below.

The recipient is the peer ID of the agent being called, which a peer learns
from the mDNS TXT `id` record or from the handshake, and the server verifies it
by substituting its **own** peer ID: a signature addressed to a different agent
does not verify. This is required because replay state is per process, so
without it a request observed on the wire would be a fresh nonce at every other
member and could be executed once per agent.

`sha256(body)` is the **lowercase hex** digest of the raw request body bytes
(the bytes as received, before any parsing or re-serialisation), or the hex
digest of the empty string when the request has no body. Hashing the received
bytes rather than a re-encoded form means a signature covers exactly what was
sent, and cannot be invalidated by a different but equivalent JSON encoding.

`path` is the request target exactly as sent, including any query string.
`timestamp` MUST be an ISO 8601 instant carrying an explicit UTC designator
(`Z` or a numeric offset). A bare date or a local-time string is rejected
rather than interpreted, because the two sides could resolve it to different
instants and report an authentication failure instead of a malformed request.

A server MUST reject a nonce it has already accepted within the acceptance
window, and any request whose timestamp is more than 60 seconds from its own
clock. Both are constants, not configuration.

### Transcript encoding

For both the handshake and the request proof, fields are joined with exactly
one NUL byte (`\u0000`), in the order given above, and the result is UTF-8
encoded. There is no trailing separator. This is the only encoding: an
earlier revision of this document described the request transcript as
LF-separated, which contradicted this rule and would have produced a distinct
signature for the same request.

Field values MUST NOT contain `U+0000`, otherwise two distinct transcripts
could encode to the same bytes; a receiver MUST reject a `peer_id` or nonce
that contains one.

The `hmac` field is standard base64 (RFC 4648 section 4: 44 characters ending
in one `=`), and `nonce` is the base64 encoding of 32 random bytes.

## Session listing and replay

`session.list` returns one `SessionSummary` per session, for **every**
`*.jsonl` under `~/.pi/agent/sessions/--*--/`, across all projects — one
summary per file, with no project filter.

| Field | Meaning |
|---|---|
| `id` | The session-file header UUID |
| `project` | The header's working directory (empty string for old sessions) |
| `name` | Display name from the **latest** `session_info` entry, which is Pi's own rule |
| `started_at` | Header timestamp |
| `updated_at` | Last entry's timestamp — last activity, not an end time |

`name` is omitted when the latest `session_info` entry carries no name, which
Pi treats as an explicit clear; a rename therefore takes effect and a clear
removes it. Omitted is not the same as empty.

`updated_at` is the last *entry's* timestamp. Pi's own `/resume` ordering uses
the latest **message** timestamp instead, so a session whose final entry is a
label, custom or `session_info` entry can order differently here. Ours is
defined above so a peer knows which it is sorting by.

A session whose header `id` is not a UUID cannot be addressed and is not
listed; that skip is reported rather than silent, because Pi permits a
caller-supplied session id and such sessions are real.

There is deliberately no `status` and no `ended_at`. Pi's session format
records no lifecycle state, so neither is derivable; a field that is always
`"unknown"` looks like data while carrying none, which is the same defect as
the removed `fp` TXT key (ADR 0006). `updated_at` is named for what it is.

## Session events and replay

A session's durable entries are the canonical event stream. `Event.data`
carries the file's entry **unnormalised**: Pi applies migrations (v1 → v2 → v3)
when it loads a session and this reader does not, so a v1 file's
`hookMessage`-era entries or `firstKeptEntryIndex` reach a peer as written. The
header's `version` is reported so a consumer can tell.

Each `Event` carries the **Pi entry ID** (a string) as its cursor, in the field
`entryId` to keep it distinct from a session ID; there is no numeric
sequence.

For v1 sessions there is no Pi entry ID at all: v1 predates the tree, and Pi
assigns **random** ids when migrating. This reader instead synthesises stable
ids of the form `v1-<line>` and chains parents, so that `since` and append
order still work. For v1, `entryId` is this specification's, not Pi's.

`session.read` accepts `since` as an entry ID and returns entries appended
after it. `session.stream` emits newly appended entries in append order.

Token-level streaming deltas are deliberately not part of v1's durable
replay: they carry neither a stable identifier nor a timestamp and cannot be
resumed, so they could not participate in replay.

`session.stream` uses a live source when its id belongs to a locally running
job. Live frames are the raw Pi RPC event with `source: "live"`; they do not
carry `entryId` and make no resumption promise. A subscriber attaching during
a turn receives a bounded replay of recent live events (at most 256 events or
64 KiB, whichever is reached first), followed by the live tail. Events older
than that bound are dropped; clients must use the durable session file to
resume after a disconnect.

When the session is not owned by a running local job, `session.stream` remains
file-backed. Its frame carries `source: "file"` in the streamed Pi entry and
retains the existing `entryId` cursor semantics, so `session.read` can resume
after that cursor. Live and file frames are intentionally not interchangeable:
only file frames promise replay or resumption.

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

A successful handoff returns an A2A `Task` wrapper whose status message result
is exactly:

    { "task_id": "…", "session_id": "…", "job_id": "…" }

A peer preference naming another agent, or expiry before acceptance, returns a
`Task` wrapper instead of an error. Its task status is
`TASK_STATE_REJECTED`, and `tasks/get` for that task id returns the same settled
task. A local execution-policy refusal remains `-32102`; it is distinct from a
peer's ordinary rejection. `task` is the child's initial prompt. When
`context` is non-empty it is appended to that prompt under the exact `Context:`
heading. `project` is resolved beneath the configured workspace root and uses
the same containment check as `process.spawn`.

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
| `-32103` | `PI_MESH_UNKNOWN_JOB` | Unknown job |
| `-32104` | `PI_MESH_TOO_MANY_JOBS` | Job concurrency or start-rate limit exceeded |
| `-32105` | `PI_MESH_SPAWN_FAILED` | Process failed to start or become ready |

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
