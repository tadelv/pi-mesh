# Milestone 4 - Control from the dashboard, without a second gate

M3 shipped a control plane that can read. `README.md` already promises more:
*"Steering - attach to any session from the dashboard and redirect it"* and
*"Process control - start and stop Pi sessions on remote devices"*. M4 makes
those true, over the credential and the gate that already exist.

That framing bounds the work. `process.spawn`, `session.steer`, `process.stop`,
`session.abort` and `mesh.handoff` are already served by the agent, already gated
(ADR 0008), and already reachable by the control plane through
`packages/control-plane/src/client.ts`'s `callAgent`. What is missing is routes,
a UI, capability honesty, and the trust analysis that says out loud that the
dashboard token becomes an execution grant once an agent opts in.

The milestone's risk is the one M3 named: **two spawn paths.** The moment the
control plane grows its own way to start a process, the gate has two places to
be forgotten. Every execution in this milestone is an A2A request to the agent's
existing skill.

## In

1. An ADR that fixes the trust model before any code (M4-1).
2. The control plane can start, steer, stop and abort on a paired agent through
   the agent's existing skills and its existing gate - no second spawn path.
3. A dashboard that surfaces those actions *and* surfaces refusals rather than
   hiding them.
4. Per-agent capability honesty: the UI offers execution only where the agent
   advertises it (ADR 0006).
5. `SECURITY.md` updated, and a three-machine hardware proof.

## Out

- Live SSE streaming of a spawned session in the dashboard. Cached/live
  `session.read` is enough to confirm a spawn; streaming is its own issue
  (ADR 0009, and ADR 0011 deferred it from the read slice).
- Multiple operators, roles, or per-action tokens. One token, one operator.
- Credential revocation or rotation UI (ADR 0011 names that gap; unchanged).
- Executing on an agent the control plane has not paired with.
- A stored job *history* or metrics. The agent's job table is the truth.

## Issues

### M4-1 - the trust model for dashboard execution (ADR 0013, accepted)

Done: `docs/adr/0013-dashboard-control.md` is accepted. It fixes the two grants
(dashboard token to ask, per-agent opt-in to allow), the single execution path,
the explicit-control-id opt-in, "pairing authenticates, it does not authorise",
the conditional-execution meaning of the dashboard token, the non-authoritative
jobs cache, handoff as out of scope, and the pinned route/response shapes.

**DoD:** met. M4-2 onward cite it.

### M4-2 - control-plane execution routes

- `POST /api/agents/:peerId/spawn`  `{ project, cwd?, prompt }`
- `POST /api/agents/:peerId/steer`  `{ job_id, message }`
- `POST /api/agents/:peerId/stop`   `{ job_id }`
- `POST /api/agents/:peerId/abort`  `{ job_id }`
- A non-authoritative jobs cache so the UI can act after a reload.

All four require the dashboard token, resolve the agent from the store, and call
the agent's skill through `callAgent`. The agent's error is passed through, not
flattened: `-32102` (the machine did not opt in) and `-32004` (the skill is not
served) mean different things and the UI must be able to tell them apart.

**DoD:**
- A spawn on an agent with execution enabled starts exactly one session and
  returns `{ job_id, session_id, pid }`; the same input through `pi-mesh-agent
  call process.spawn` starts one too, through the same gate.
- A spawn on an agent with execution disabled is `-32102` and starts nothing -
  **no process, no session** - with a positive control that the process table was
  genuinely non-empty before (the M3-1 rule).
- With execution enabled but the control id not allowed, `-32102` as well.
- `stop` is idempotent, `abort` reaches a running session, and neither is gated.
- Killing the control plane between spawn and stop loses the handles but does
  not orphan the session (the agent owns it).
- **Evidence:** each clause broken and shown to fail by the clause it names.

### M4-3 - capability honesty per agent

The dashboard must offer execution only where the agent advertises it. The agent
card is public (`GET /.well-known/agent-card.json`), and `servedSkills(enabled)`
already drives it, so the control plane fetches the card for each paired agent
and exposes the skill list on `/api/state` (no credential needed to read a card).

**DoD:** an agent with the gate closed shows no execution controls, and the route
still returns the agent's own `-32102`, never a 500. An agent that is offline
degrades to "unknown", not to "disabled" or "enabled". A test asserts the card
and the UI agree, and that deleting the gate from `servedSkills` fails it - the
same shape as the M2-8 capability-honesty test.

### M4-4 - the dashboard UI

Per agent: a start form (project required, prompt required, cwd optional), a list
of that agent's jobs with stop, and a steer box for a live job. Refusals are
shown inline with their reason; a `-32102` must never look like a crash.

**DoD:** the page renders execution controls only for capable agents; a refused
spawn shows the agent's message; the operator can copy the agent's control id
(the page shows it) to put in `--allow-execution`. No external URLs, no framework
(the ADR 0011 constraints still hold).

### M4-5 - docs and hardware proof

- `SECURITY.md`: the dashboard token is a conditional execution grant; the
  control-plane database now holds execution-capable credentials.
- `docs/DEPLOYMENT.md`: the two-step opt-in (pair, then restart the agent with
  `--allow-execution=<control-id>`), and why it is two steps.
- `README.md`: the "Why" bullets become true; remove them if they do not.
- A three-machine transcript: spawn from the dashboard on apollo, steer it,
  watch it in the session read, stop it, and the gate-closed refusal.

**DoD:** the transcript is in the repo and names what it does and does not show.

## Decisions (settled by ADR 0013)

Full control from the dashboard is in scope; the agent opts in per machine; the
opt-in is an explicit control id; handoff is deferred; the jobs cache is
non-authoritative; pairing never grants execution; a spawn confirmation is UI,
not a control. `docs/adr/0013-dashboard-control.md` records each with its
reasoning, and the Jev cross-check that agreed with all but the last (0.58,
indifferent).

## Risks

- **The dashboard becomes an execution surface.** A stolen dashboard token plus a
  machine that opted in is code execution. That is the deliberate consequence and
  must be written down, not discovered, exactly as ADR 0008 wrote down the swarm
  key's grant.
- **Two spawn paths.** The milestone's whole risk. Any control-plane code that
  builds a command or manages a process is a defect, not an implementation
  detail.
- **A refusal that looks like a bug.** `-32102` shown as a generic error trains
  an operator to retry, or to widen the grant, instead of fixing the opt-in.
- **Capability drift.** The UI's idea of "can execute" and the agent's
  advertisement must be one source, or the page offers a button the agent refuses.

## Exit criteria

- An operator can start a session on a paired agent from the dashboard, steer it,
  watch it, and stop it - and every one of those is the agent's existing skill
  behind the agent's existing gate.
- An agent that did not opt in advertises no execution skill and refuses the
  dashboard with `-32102`, and the UI says so.
- Nothing in this milestone requires outbound internet.
