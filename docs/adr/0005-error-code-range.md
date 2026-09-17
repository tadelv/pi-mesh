# ADR 0005 — pi-mesh error codes move above A2A's reserved range

## Context

`docs/PROTOCOL.md` originally assigned `-32001` to `-32005` to pi-mesh's own
errors: Unauthorized, Unknown session, Process spawn denied, Peer unreachable,
and Handoff rejected.

ADR 0002 makes A2A the wire protocol, and A2A reserves the JSON-RPC range
`-32001` to `-32099` for its own errors, defined as:

| A2A error | Code |
|---|---|
| `TaskNotFoundError` | `-32001` |
| `TaskNotCancelableError` | `-32002` |
| `PushNotificationNotSupportedError` | `-32003` |
| `UnsupportedOperationError` | `-32004` |
| `ContentTypeNotSupportedError` | `-32005` |
| (and further codes up to `-32009` in A2A 1.0) | … |

All five pi-mesh codes collided with an A2A code of a different meaning, on
the same JSON-RPC channel. A `tasks/get` for a task that does not exist
returns `-32001`, which pi-mesh would have read as "swarm key mismatch". The
failure is silent: both sides believe they agree on the meaning of a number.

`docs/PROTOCOL.md` also pinned no A2A revision, so there was nothing to check
wire shapes against.

## Decision

1. pi-mesh error codes move out of A2A's reserved range, starting at `-32100`:
   Unauthorized `-32100`, Unknown session `-32101`, Process spawn denied
   `-32102`, Peer unreachable `-32103`, Handoff rejected `-32104`.
2. `-32001`-`-32099` is A2A's range and pi-mesh never emits a code from it.
3. pi-mesh targets A2A **1.0**, recorded as `A2A_PROTOCOL_VERSION` in
   `@pi-mesh/protocol` and cited at the top of `docs/PROTOCOL.md`.

## Consequences

- An A2A error and a pi-mesh error can never share a number, so a peer can
  route on the code without knowing which endpoint produced it.
- Clients must not treat the `-320xx` band as pi-mesh's, and any code that
  catches `PiMeshError` keeps working because it matches on the symbolic name
  rather than the number.
- The shift is a breaking wire change, made while nothing is deployed.
- Aligning the A2A message *shapes* in `@pi-mesh/protocol` to revision 1.0 is
  not part of this decision. Two names are known to differ from A2A 1.0 and
  must be reconciled before the M1 transport is written: the streaming update
  events carry `taskId` (not `id`), and `TaskStatus.state` is one of
  `TASK_STATE_SUBMITTED`, `TASK_STATE_WORKING`, `TASK_STATE_COMPLETED`,
  `TASK_STATE_FAILED`, `TASK_STATE_CANCELED`, `TASK_STATE_REJECTED`,
  `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`. `message/send`'s
  send-configuration field name is unverified and must be checked against the
  pinned revision rather than guessed.
