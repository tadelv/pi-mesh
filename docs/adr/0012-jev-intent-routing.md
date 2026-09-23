# ADR 0012 — Jev intent routing is an optional control-plane integration

Status: withdrawn - the integration was removed from the project. The command
bar and `/api/intent` are gone; nothing supersedes this ADR, because nothing
replaced the feature. It is kept as the record of why it was tried and what it
cost (a third-party cloud call on a path that also carried session names and
ids, and a second credential in the deployment).

## Context

The control-plane vertical slice (ADR 0011) gives the operator a list of paired
agents and their sessions. The product claim is that a member can *route* work
to a suitable peer, and a dashboard that only lists things still leaves routing
to the person clicking. `init.md`'s "steering" and M3 exit criteria describe a
usable path, not only a readable one.

TypeSafe's Jev is a System One model: it takes a state (here, the operator's
sentence plus the known agents and sessions) and returns a typed, calibrated
judgement — a Choice over a closed set of actions and Nouls about which
arguments the sentence names — instead of prose. That is exactly the shape
"parse a command and pick a handler" needs, and it is the pattern TypeSafe's
own [intent routing](https://docs.typesafe.ai/patterns/intent-routing) and
[function calling](https://docs.typesafe.ai/cookbooks/function_calling)
documents describe.

The tension is `AGENTS.md` constraint 4: no cloud dependencies, everything runs
on a LAN with no outbound internet, "except optional integrations". Jev is a
hosted API. So it can be added only as an integration that the control plane
does not require and that fails closed, never as part of the path the mesh
needs to work.

## Decision

### 1. Off unless explicitly configured

Intent routing is enabled only when `TYPESAFE_API_KEY` is set. With it unset,
`POST /api/intent` answers `501 { "error": "intent_disabled" }` and the
dashboard renders its ordinary controls. No control-plane feature depends on
Jev; ADR 0011's read path is complete without it.

### 2. One request, a closed set of actions

`POST /api/intent` takes `{ "text": "..." }` and returns

    { "action": "show_sessions", "confidence": 0.87,
      "arguments": { "agent_id": "..." } }

The action set is closed and small:

| Action | Arguments | Effect |
|---|---|---|
| `show_devices` | — | list paired agents |
| `show_sessions` | `agent_id?` | list, optionally for one agent |
| `sync_now` | — | refresh snapshots from every paired agent |
| `open_session` | `agent_id`, `session_id` | open one session |
| `none` | — | nothing matched |

Questions are asked **together** in one `systemone` call, per TypeSafe's
guidance that independent judgements over the same state belong in one request:
a Choice over the actions, a Noul per candidate device that the sentence names,
and a Noul per candidate session. Candidate values come from the control
plane's own store, so the model selects from strings the code can then copy
verbatim — it never invents an id. **The session candidates are capped at the 50
most recently updated, and the request's `state` carries only those candidates,
not the whole fleet.** Both are hard protocol requirements rather than cost
tweaks: TypeSafe rejects a Choice with more than 255 options (measured: 300
options → HTTP 400 "Too many choices"), and it rejects an oversized request
(measured: 435 sessions as `state` → HTTP 400 `max_tokens_exceeded`, which the
option cap alone did not fix because the state was the cost). The first real
fleet held 435 sessions and took the whole route down until both existed.

### 3. Code owns the threshold and the argument fill

The model returns probabilities; the code decides. `none` wins the choice, or
its confidence is below `0.6`, or a winning action's required argument is not
named with probability `>= 0.5` → the response is `{ "action": "none" }` and the
dashboard says it did not understand. The code never executes an action whose
argument it could not resolve, and never guesses between two devices. `0.6` and
`0.5` are named starting points to evaluate against real utterances, not
calibrated truths.

### 4. No new dependency; a thin `fetch` client

The endpoint is one `POST https://api.typesafe.ai/v1/systemone` with a bearer
key and a JSON body; the response is JSON. A ~40-line wrapper (`src/jev.ts`)
that takes an injectable `fetch`, a timeout, and returns `undefined` on any
non-200 or malformed response is smaller than a dependency and testable without
the network. The control plane does not need the SDK's typing to read
`answers.<id>.choice`, `answers.<id>.noul` and `answers.<id>.confidence`.

### 5. Failure is invisible to the mesh

A network failure, a `429`, a `529` or a malformed response makes
`/api/intent` answer `503 { "error": "intent_unavailable" }`. The dashboard
falls back to its buttons. Nothing in the mesh can be blocked, slowed to a
network timeout, or broken by TypeSafe being unreachable.

## Consequences

- `packages/control-plane` gains `src/jev.ts` and an `/api/intent` route; its
  test suite exercises the router against a stub `fetch` and must prove the
  disabled, unavailable and low-confidence paths as well as the happy one.
- `SECURITY.md` states that enabling Jev sends the operator's text and the
  names/ids of paired agents and their sessions to a third party by choice, and
  that leaving `TYPESAFE_API_KEY` unset is the default.
- `README.md` describes the command bar as optional and names the environment
  variable.
- No agent-side change, and no change to any A2A message.
