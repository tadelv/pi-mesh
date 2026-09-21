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

1. pi-mesh application errors move out of A2A's reserved range, starting at
   `-32100`: Unauthorized `-32100`, Unknown session `-32101`, Process spawn
   denied `-32102`, Unknown job `-32103`, and Too many jobs `-32104`.
2. `-32001`-`-32099` is A2A's range and pi-mesh **never defines its own codes
   inside it**. A2A-mandated errors are of course still emitted, because the
   spec requires them and their codes are not ours to choose: `TaskNotFound`
   (`-32001`) for `tasks/get`/`tasks/cancel`, and `VersionNotSupported`
   (`-32009`) for an unsupported `A2A-Version`. The distinction is between a
   code *we invent* and a code *the protocol dictates*; reading this as "never
   emits" would be wrong, and the earlier phrasing invited that reading.
3. Only genuine application errors get a code. Two conditions previously
   listed as errors are removed:
   - **Handoff rejected** is an A2A task outcome (`TASK_STATE_REJECTED`), not
     an RPC error. Modelling it both ways would give one condition two
     representations and leave peers guessing which to trust.
   - **Peer unreachable** is a transport failure (timeout, connection
     error). As an RPC error it would conflate "the call failed" with "the
     call succeeded and reported a negative outcome".
4. Each code carries a `reason` in UPPER_SNAKE_CASE for A2A's
   `google.rpc.ErrorInfo` `details` entry, recorded in `docs/PROTOCOL.md` now
   so the M1 transport does not have to invent them.
5. pi-mesh targets A2A **1.0**, recorded as `A2A_PROTOCOL_VERSION` in
   `@pi-mesh/protocol` and cited at the top of `docs/PROTOCOL.md`.

## Consequences

- An A2A error and a pi-mesh error can never share a number, so a peer can
  route on the code without knowing which endpoint produced it.
- Clients must not treat the `-320xx` band as pi-mesh's, and any code that
  catches `PiMeshError` keeps working because it matches on the symbolic name
  rather than the number.
- The surface stays small: three application errors rather than five, because
  two of the original five were not errors to begin with. M2-4 later added
  `-32103` and `-32104` for job lifecycle failures, which are genuine errors
  rather than the two that were removed - so the range holds five codes again,
  but not for the reason the range was originally narrowed, and the narrowing
  itself is still the precedent that stops a code being invented to fit a
  message.
- The shift is a breaking wire change, made while nothing is deployed.
- Still outstanding, and to be tracked in milestone 1 rather than here: the
  A2A message *shapes* in `@pi-mesh/protocol` must be reconciled with
  revision 1.0 before the transport is written. The streaming update events
  carry `taskId` (not `id`), `TaskStatus.state` is one of the `TASK_STATE_*`
  values, and `message/send`'s send-configuration field name remains
  unverified and must be checked against the pinned revision rather than
  guessed. The revision itself should be pinned to a concrete source, not to
  the site's moving `/latest` page.
