# ADR 0013 — Dashboard control reuses the one execution gate

Status: accepted

## Context

`README.md` promises "Steering - attach to any session from the dashboard and
redirect it" and "Process control - start and stop Pi sessions on remote
devices". M4 delivers those. `tasks/milestone-4.md` scopes the work; this ADR
fixes the trust model before any of it is written, because the work touches the
security property of M2 (ADR 0008).

Three facts make the milestone small and its risk specific:

1. **The agent already does all of it.** `process.spawn`, `session.steer`,
   `process.stop` and `session.abort` are served, and gated by `gateExecution`.
   The control plane's `callAgent` is generic, so a route is a thin proxy.
2. **The already-documented risk is a second spawn path.** ADR 0008's gate is one
   place; a control plane that builds a command line or manages a process would
   create a second, and one of them would eventually be forgotten.
3. **A paired control id is authenticated, unlike a swarm peer's claimed id**
   (ADR 0011). `--allow-execution=<control-id>` is therefore a real boundary for
   the first time, not the convenience ADR 0008 §3 warns about.

This milestone was also run past Jev (System One) before the decisions were
frozen; the answers are recorded under [Cross-check](#cross-check) rather than
presented as independent reasoning.

## Decision

### 1. The dashboard may control, and each agent opts in

Full control from the dashboard - start, steer, stop, abort - is in scope, and
it happens only on a machine that has enabled execution locally. There are **two
independent grants**, and both are required:

- the **dashboard token** lets an operator *ask*; and
- the **agent's opt-in** lets the machine *allow*.

Neither is sufficient alone. A dashboard token against a machine that did not opt
in is refused; an opted-in machine that nobody has a token for does nothing.

### 2. One execution path, and the agent owns it

Every execution is an A2A request to the agent's existing skill through
`callAgent`. The control plane constructs no command line, starts no process, and
manages no process lifecycle. **Any control-plane code that does is a defect, not
an implementation detail.** The agent's `gateExecution` is the only gate.

This is the milestone's load-bearing constraint and the thing its tests must
protect.

### 3. The opt-in is an explicit control id

An agent allows a control plane with `--allow-execution=<control-id>`, and the
dashboard displays its own id to copy. A policy value meaning "any paired
control" was considered and rejected: it widens the grant from *this* control
plane to *any* control plane that has ever completed a pairing, for the same
convenience a copy-paste already provides.

### 4. Pairing authenticates; it does not authorise

Completing a pairing must never, by itself, grant execution. Pairing proves which
control plane is calling (ADR 0011); execution is a separate local decision
(ADR 0008 §2). Collapsing them would make an authentication step grant code
execution on the machine, which is the exact inversion ADR 0008 exists to
prevent.

### 5. What the dashboard token now is

The dashboard token is the only authentication on the control plane's `/api/*`
routes, and those routes can now execute on opted-in agents. So the token is a
**conditional execution grant**, and the control plane's database - which holds
the token and the per-agent credentials - now protects execution, not just
reading. `SECURITY.md` states this plainly and says what protecting that file
means.

### 6. The jobs cache is a convenience; the agent's table is the truth

The control plane keeps a small `jobs` table so the dashboard can steer or stop a
job after a page reload. It is explicitly **non-authoritative**: the agent's job
table is the source of truth, `process.stop` stays idempotent on the agent, and a
control plane that loses its cache loses handles, not work.

### 7. Handoff is out of scope

`mesh.handoff` routes work to *whichever* agent should do it. That is peer
routing, not "drive this machine", and it belongs with the routing work rather
than here.

### 8. A spawn confirmation is UI, not a control

The dashboard asks for confirmation before a spawn. It is a convenience against a
mis-click, **not** a security boundary, and it is reversible: the enforcement is
the opt-in. (Jev rated it 0.58 - genuinely indifferent - which is why it is
recorded here as low-stakes rather than as a decision.)

### 9. A refusal is a result, not an error

`-32102` (this machine did not opt in) and `-32004` (this agent does not serve
the skill) are passed through distinctly, and a transport failure is separate
from both. Collapsing a refusal into a generic error would repeat the mistake
ADR 0005 and M3-1 were written to prevent, and it would train an operator to
retry or widen the grant instead of enabling the machine.

## Response shapes, pinned

Pinned so the M4-2 tests are deterministic and do not conform to whatever the
code happens to do. Every route requires the dashboard token (`401 {"error":
"unauthorized"}` otherwise).

| Route | Body | Success | Refusal | Transport |
|---|---|---|---|---|
| `POST /api/agents/:peerId/spawn` | `{ project, cwd?, prompt }` | `200 { ok: true, result: { job_id, session_id, pid } }` | `200 { ok: false, code, message }` | `502 { error: "agent_unreachable", message }` |
| `POST /api/agents/:peerId/steer` | `{ job_id, message }` | `200 { ok: true, result }` | `200 { ok: false, code, message }` | `502 { … }` |
| `POST /api/agents/:peerId/stop` | `{ job_id }` | `200 { ok: true, result: { job_id, state, pid } }` | `200 { ok: false, code, message }` | `502 { … }` |
| `POST /api/agents/:peerId/abort` | `{ job_id }` | `200 { ok: true, result }` | `200 { ok: false, code, message }` | `502 { … }` |

An unknown `peerId` is `404 { error: "unknown_agent" }`. `code` is the agent's
JSON-RPC code, so `-32102` survives the hop. The control plane does **not**
re-validate the skill inputs; the agent is the authority, and its `-32602` is
passed through - a second set of validation rules is a second thing to drift.

`client.ts` therefore needs an error that carries the agent's code instead of
throwing a message; that is part of M4-2.

## Consequences

- `SECURITY.md` gains: the dashboard token as a conditional execution grant, and
  what the control-plane database protects.
- `docs/DEPLOYMENT.md` gains the two-step opt-in (pair, then restart the agent
  with `--allow-execution=<control-id>`) and why it is two steps.
- M4-3 must surface capability honesty (ADR 0006) so the UI offers execution only
  where the agent advertises it, and shows "unknown" for an offline agent rather
  than guessing.
- The `README.md` "Why" bullets become true; the "Someday" list is unaffected.
- The residual risk is named and accepted: a stolen dashboard token plus a machine
  that opted in is code execution. That is written down here rather than
  discovered, exactly as ADR 0008 wrote down the swarm key's grant.

## Cross-check

Asked before the decisions were frozen (Jev 1.13.0, one `systemone` request, five
independent questions over the state above). Recommendation first, Jev second:

| Question | Recommendation | Jev | Confidence |
|---|---|---|---|
| Opt-in mechanism | explicit control id | explicit_control_id 0.99 | 0.98 |
| Handoff scope | defer | separate_defer 1.00 | 0.99 |
| Jobs cache | persist, non-authoritative | persist_non_authoritative 0.95 | 0.92 |
| Pairing grants execution? | no | no (0.09) | - |
| Top risk | second spawn path | second_spawn_path 0.79 (stolen token 0.21) | 0.71 |
| Spawn confirmation | yes | yes, 0.58 | - |

The one place the assessment disagreed with the recommendation was the
confirmation step: 0.58 is indifferent, not approval, and decision 8 records it
accordingly.
