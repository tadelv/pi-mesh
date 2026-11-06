# ADR 0023 - pi-intercom is a local channel, never a mesh transport

Status: proposed (operator asked for intercom-based steering; this is the shape
the protocol actually supports)

## Context

The operator installed `pi-intercom` (v0.18.1) on the nodes and asked that the
mesh "connect and steer active sessions without destructive attach", and that an
observer "monitor intercom for live sessions and spawn sessions if needed".

What the package actually is, read from its source (study:
`docs/research/council-0022-product-feedback.md`, and the report summarised
below):

- **A per-machine broker** on `~/.pi/agent/intercom/broker.sock` (Windows: named
  pipe; opt-in loopback TCP), auto-spawned by the first client
  (`broker/spawn.ts:130`, `broker/paths.ts:73`), with **no authentication**: it is
  a same-UID file-permission boundary, and the session metadata is explicitly
  display data, not identity (`types.ts:142`, `broker/broker.ts:312`).
- **A tiny wire**: 4-byte big-endian length + JSON, 1 MiB cap
  (`broker/framing.ts:3,18,23`), with `register`/`list`/`send` and
  `delivered`/`delivery_failed` replies correlated by `requestId`/`message.id`
  (`types.ts:153-187`, `broker/client.ts:366,387,612,678`).
- **Honest delivery vocabulary** only when the recipient is a Pi extension client:
  `socket_delivered` and `queued` are transport facts, `receiver_received` and
  `injected` are the recipient's own receipts, and a timeout yields
  `delivery:unknown, retryable:true` (`broker/broker.ts:1163,1172,1208`).
  A non-Pi client cannot produce `injected` itself.
- **Cross-machine is `name@machine` over `ssh`** with an `ssh-asserted` trust label
  and `send` only (`cross-machine-envelope.ts:7,33`,
  `cross-machine-transport.ts:11,70`). It is not a peer protocol, it carries no
  mesh proof, and it is out of scope here.

## Decision

### 1. The agent is a broker client; the broker is never a command ingress

An outbound connection is not the unauthenticated local route AGENTS.md forbids -
that prohibition is about mesh request ingress. Two rules keep the distinction:
broker replies and receipts are consumed as **untrusted data**, and an unsolicited
broker message never invokes a skill, is never relayed to a peer, and confers no
authority.

The agent MAY connect to the local broker as a client - the protocol is a
`node:net` socket with a length prefix, which the CLI itself demonstrates
(`cli.ts:129,302`) - to list live local sessions and to send a message. The agent
does **not** register a listener that accepts commands: the socket has no auth, so
any same-UID process, including any unrelated Pi session, could then drive the
mesh through it. That would be an unauthenticated local route, which this project
refuses on principle (AGENTS.md: "there is no unauthenticated local server in v1").

### 2. Listing is a read and belongs in the mirror

`intercom.list` gives what `session.list` cannot: which Pi sessions are **live
right now** on this machine, rather than which transcript files exist. It is a
read - it needs the paired credential, no execution grant, no TLS/loopback - and
it is advertised as its own capability, present only when the broker socket exists
and answers a `protocol:pi-intercom v1` health probe
(`broker/paths.ts:9`, `broker/spawn.ts:74`). Absent broker, absent capability,
stated reason; never an empty list that looks like "no sessions".

### 3. A message into a session IS execution, so it passes the same gate

Sending to a session makes a model turn run and invokes that session's tools;
ADR 0008 (`:60-62`) already classifies exactly that as execution. `intercom.send`
is therefore registered in the shared execution dispatch (`:150-164`), not beside
it, and meets the *same* two conditions as `session.steer`: the agent's own opt-in
naming this control id (ADR 0013 `:37-38,53-55`) and the dashboard token on the
operator side (ADR 0014). There is no second control-plane-side gate to invent and
none to skip; no intercom-specific bypass, no new principal (ADR 0021).

### 4. Delivery is reported in the words the protocol supports

`delivered`/`queued`/`unknown` with the broker's own reason code, passed
through unchanged. `unknown` is reported as "may have arrived; do not retry
blindly", never as failure. `injected` - the only receipt that means a turn
started - is reported when the recipient supplies it and never inferred. The
dashboard must not render "steered" for anything weaker.

### 5. Observation may propose; only the gate may spawn

The observer may notice that no live session exists for pending work and *propose*
a spawn. It may not spawn on its own: that is a second execution path around
ADR 0008's one gate. A spawn is `process.spawn`, at the operator's or the root
session's instruction.

### 6. The compatibility boundary is tested, and it is not called "v1 safe"

A health response identifies a protocol *family*; it does not prove compatibility
with the release this was written against. The framing (4-byte big-endian length
plus JSON, 1 MiB cap) and the request/response shapes (`register`, `list`, `send`,
`delivered`, `delivery_failed`) are pinned by a conformance test built from
upstream-derived fixtures - a recording of a real broker exchange - not from a
fixture written to match this implementation. A shape the fixture does not cover
is unsupported, reported as unsupported, and never "refusal-safe": a probing
answer that looks like data while carrying none is the defect ADR 0006 removed
together with the `fp` TXT key.

### 7. No runtime dependency on pi-intercom

The agent implements the framing itself (20 lines, tested against a fixture
broker) rather than importing the package's internals, because a peer dependency
on another extension's private modules is not a foundation. The cost is
version skew, which decision 2's health probe makes visible and refusal-safe.

## Out of scope

Cross-machine `name@machine` relay (no mesh proof, `send` only), intercom as a
mesh transport between nodes, attachments/ask/replyTo, and any intercom-driven
spawn.

## Consequences

- The mesh gains live *local* liveness, which the session-file mirror cannot know.
- A same-UID process can still talk to the broker without the mesh's knowledge;
  that is the broker's trust model, unchanged by us, and the reason nothing here
  grants authority.
- Testing needs a fixture broker speaking the frame, and a negative control: a
  session the mesh did not spawn must still be refused a steer through
  `session.steer` while remaining reachable through `intercom.send`.
