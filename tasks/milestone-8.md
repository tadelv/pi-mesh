# Milestone 8 - Delegation and oversight of runs

M7 shows a session working. What it does not give the operator is the thing the
control plane exists for: **one Pi session at a root folder that delegates,
oversees and controls the other Pi agents on the LAN.** Today the mesh can spawn,
steer and stop a session it started, and it can hand work to a peer, but no Pi
session can drive any of that itself, and no subagent run anywhere is visible.

`docs/adr/0021-oversight-of-runs.md` (proposed) is the plan; a council review and
a plan review are in `docs/research/council-0021-oversight-of-runs.md` and
`plan-reviewer` run `b930b2e7`. The plan review judged the earlier draft
*moderate* distance from the vision and named the missing link: not a new client -
the agent already ships an authenticated one - but a **discoverable Pi tool**
wrapping it, plus delegation inside the milestone instead of after it.

Order (revised by the operator after that review): **delegation first, then the
external-runs plane read-only, then run control, then findings.**

## In

1. The Pi package adopted as the carrier: local oversight preserved, plus the
   mesh tool and the root-session slice (M8-1, M8-2).
2. The actor named and the capability classifier fixed - the two changes
   delegation and run control both depend on (M8-3).
3. `packages/runs`: readers, tri-state liveness, thresholds, inbox writer, pinned
   dependency (M8-4).
4. `run.list` and findings on the agent, and child transcripts made addressable
   (M8-5, M8-6).
5. Control plane: mirrors and a read-only fleet panel, then run control behind the
   folded grant, then findings delivery (M8-7, M8-8, M8-9).
6. Docs and a three-machine transcript covering both flows (M8-10).

## Out

- **A dashboard delegate route.** Delegation is the root session's own action; a
  dashboard proxy is a later, separate decision (ADR 0013 deferred routing once).
- **Any new principal, relay or unauthenticated route.** The tool reuses the
  existing signed client paths to the local agent.
- **A control-plane orchestrator**, queue/retry scheduler, or second spawning path.
- **Live run streaming** (the child session is a session; M7 covers it when a mesh
  job owns it), **run spawning from the mesh**, **`run.interrupt`**, **run-level
  budget enforcement**, and **control of foreground runs with no inbox** - refused
  with a reason, not faked.
- **Shared-TUI attachment or a production Pi Durable migration** (ADR 0020's
  spike stays a spike).
- **Routing models or cloud integration** (ADR 0012 stays withdrawn), an agent
  database, a duplicate `run.read`, arbitrary-PID control.

## Issues

### M8-1 - the Pi package, adopted

`packages/pi-overseer` in this repository: the extension's panel, tool, rules and
local control preserved, installable with `pi install ./packages/pi-overseer`.
This is the carrier for M8-2, so it ships first.

**DoD:** with no agent and no control plane the panel, tool and local rules behave
as they do today; the package carries an SPDX header per file and installs from a
checkout; `pnpm -r build` and lint include it and CI provides Pi's types; the
README says which Pi and pi-subagents versions were tested and what a machine
without pi-subagents sees.

### M8-2 - the first product slice: a root session that delegates

The Pi-side mesh tool and the workflow it exists for: a managed root session,
started in the home folder through the existing dashboard spawn, chooses a peer,
hands off one task, keeps the returned handles, follows the work, steers it and
stops it.

**DoD:** the tool discovers peers and hands off a task, returning the agent,
session and job ids, and it reuses the existing authenticated client paths rather
than adding a route (a test asserts no new route is served and no unauthenticated
listener is opened); a handoff to a recipient whose execution grant is closed is
`-32102` **and starts nothing**, with the same handoff under an open grant as a
positive control starting exactly one job; the whole flow works with **no control
plane running**, and the dashboard mirrors the resulting job unchanged when one
is; the root session is a mesh-supervised session (spawning it is what makes it
steerable) and the DoD records that a discovered TUI transcript is not a supported
root; no routing model, no scoring, no network call beyond the mesh.

### M8-3 - the actor, and honest capabilities

The two changes everything downstream depends on: name the credential holder and
the destination grant, gate run control through the shared dispatch
classification rather than a handler-local check, and classify run capabilities by
actual availability.

**DoD:** the authority is stated where an operator reads it - a session acting
through the mesh tool speaks for its machine's swarm identity, there is no
per-session principal, and authorization to drive a session is not authorization
to execute elsewhere; the ADR 0008 one-gate test passes unchanged and no second
gate exists (asserted by a test that fails if a handler-local check appears);
`caps`, the agent card and the mDNS TXT record agree for the run skills, and a
test fails by name if the advertisement keys off `JobManager` availability; a
machine with an unrecognised run layout advertises no run skills.

### M8-4 - `packages/runs`: artifacts, liveness, thresholds, inbox

Pure fs and pure functions: discover runs, read one `status.json`, probe a pid into
`alive`/`dead`/`unknown` with a reason, evaluate the thresholds, stop a run through
pi-subagents' public `pi-subagents/control-channel` export, and write a steer
request into a run's control inbox. No Pi import, no mesh import, no I/O beyond the
directories it is given.

**DoD:** every reader takes its roots (`tmp`, sessions root, `now`) as options, so
tests run against fixtures with no machine state; a fixture whose `status.json` is
malformed or whose layout is unrecognised is skipped/refused and never becomes a
run; liveness is tri-state - a dead pid is `dead`, a simulated EPERM is `unknown`
and not alive, a run claiming `running` with a dead pid is not live, and removing
the EPERM branch fails that test by name; a successful probe is never reported as
identity; the steer writer mirrors upstream's bounds (non-empty, <=128 KiB,
timestamp, id), refuses when a closed marker is present, leaves no partial file
(atomic write) and re-checks the marker after writing; the pin is recorded in one
place and an unrecognised version refuses instead of writing; nothing in the
package imports the mesh.

### M8-5 - `run.list` and findings on the agent

An ungated peer skill returning runs with liveness evidence, and a findings result
carrying `evaluated_at`, the config that produced them, and per-agent coverage
(last success, last error, whether the layout was recognised).

**DoD:** `caps`, the agent card and the mDNS TXT record agree (ADR 0006),
including when the layout is unrecognised; no list window turns an older active run
into a failure or omits it; findings suppression survives inside one evaluator
epoch, a restart may notify again (asserted, not glossed), a failed observation
does not clear a finding, and an expired snapshot renders as unknown rather than
healthy; the read path starts no process and sends no signal.

### M8-6 - child transcripts become addressable

Session discovery and resolution accept a validated child transcript nested under
the sessions root, so a run's detail is readable over the existing session wire.

**DoD:** `session.read` resolves `<parent-session-dir>/<uuid>/run-0/session.jsonl`
from a real retained run, and `session.list` ordering and the ADR 0016 identity
rules are unchanged for ordinary sessions; a path outside the sessions root is
refused; a nested file that is not a valid session is refused rather than
half-parsed; a mutation that removes the containment check fails the escape test
by name.

### M8-7 - the control plane reads

`runs` and `findings` snapshots mirrored during sync, and a dashboard panel that
shows runs with their liveness evidence and findings labelled with coverage and
freshness. No control routes in this slice.

**DoD:** a mirrored snapshot is labelled with its age and coverage and never
presented as current (a cached row cannot render as fresh - the test fails by name
when the freshness stamp is removed); a run for agent A cannot render under agent
B; an agent whose discovery failed renders as unobserved rather than healthy; the
ADR 0013 guard test passes unchanged, and no control route exists yet.

### M8-8 - run control behind the folded grant

`run.stop` and `run.steer`, both gated by `--allow-execution`, advertised only
where the grant is open, with the request semantics and code mapping of ADR 0021
decision 2: status read first, a request id rather than a claimed outcome, and
`-32109` for a closed inbox rather than an unhandled throw.

Refined after an independent review (plan-reviewer, 2026-11-07); the wire shape
and the code split below are settled, and an implementation that invents a
different one is wrong even if its tests pass.

#### The contract

- `run.stop`: `{ run_id: string }`. `run.steer`: `{ run_id: string, message: string }`.
  Required strings non-blank, additional caller fields rejected. A steer message
  is trimmed and bounded at 128 KiB, mirroring the runner's own validation
  (`packages/runs/src/control.ts:177-193`). Never a path, a pid, a session
  principal, or writer options.
- Success: `{ run_id, request_id: string | null, requested: boolean, observed_state: RunState }`
  where `request_id` is the committed filename without `.json` and no filesystem
  path is exposed. A terminal run and a stop answer `requested:false,
  request_id:null`; an accepted write answers `requested:true` with an id.
  `observed_state` is an observation (`packages/runs/src/types.ts:13-28`), never a
  claimed outcome: no `stopped`, no `delivered`.
- Codes, pinned per refusal - and the two families are deliberately different:
  - `-32102` execution grant closed (the existing gate);
  - `-32108` unknown run;
  - `-32109` `RUN_CONTROL_UNAVAILABLE`: no inbox, closed inbox, an unrecognised
    **per-run** shape, a terminal steer, or an installed version outside the pin
    (ADR 0021's table). Terminal-steer messages name the observed state;
  - `-32004` the machine-level requirement: no recognised run layout at all, so
    the skill is not served. This is the framework's requirement refusal and
    applies to every skill alike; the skill should not be advertised in that
    state, and a direct call reaching it gets the framework answer;
  - `-32602` malformed input, and an ambiguous `run_id` ("two runs claim it") -
    never resolved by picking one, the rule ADR 0016 already sets elsewhere;
  - `-32603` status or inbox I/O failure.

  ADR 0021's own entry lumps "unrecognised layout" into `-32109`, which reads as
  the per-run shape; M8-10 must state this split in `PROTOCOL.md` so the two codes
  stop looking interchangeable. If an implementer reads the ADR the other way,
  that is an ADR correction, not a code decision.

#### The gate, the lookup and the write

- Both skills are `{ exposure: "gated", requires: "run-layout" }`, registered
  through `SkillRegistry.registerExecution` (`packages/agent/src/skills.ts:81,265-273`)
  so they join `AgentServer.call -> gateExecution -> assertExecutionAllowed ->
  skills.invoke` (`server.ts:833-844,902`). No second authorisation check; no
  handler-local grant test.
- The status read is fresh, after authorisation, before either writer; the local
  writers do not implement terminal idempotence themselves.
- The lookup is **unwindowed**: discovery currently omits old terminal runs
  (`packages/runs/src/discover.ts:166-169`), and a windowed lookup would answer
  `-32108` for a run that plainly exists. A retained artifact outside the listing
  window is still a known run.
- Writing: resolve the id uniquely under the configured run roots, never build a
  path from caller text. Stop goes through the public `requestAsyncStop`
  (`control.ts:128-143`); steer writes
  `<runDir>/control/steer-requests/<padded-ts>-<base64url(id)>.json` and re-checks
  the closed marker after writing (`control.ts:253-294`). Both publish by
  temp-file-plus-rename, so a killed process cannot leave a partial **final**
  request; it can leave a hidden temporary file, which is a documented limitation
  (record it in `docs/GOTCHAS.md`) and not a claim to make in the DoD.
- No path signals a pid for a run this agent did not start. Pid existence proves no
  identity (ADR 0021:95-96), and external-run control must never route through
  `JobManager.stop` (`packages/agent/src/jobs.ts:576-600`).

#### DoD

With execution closed, both calls are `-32102` and **no file appears in any
inbox** (positive control: with the grant open, exactly one request); a stop on a
terminal run returns success and leaves the inbox untouched (positive control: a
live run writes exactly one request), and deleting the status-first check fails
that test by name; the response names a request id and the observed state and
never `stopped`/`delivered`; a closed steer inbox and the public stop API's
closed-inbox throw both become `-32109` with no leftover file; an unknown run id is
`-32108`; no code path signals a pid for a run the agent did not start (a test
fails if a signal is sent); refusals are results with the agent's code preserved,
not transport errors.

Named tests, one per clause, each failing for its own reason:

1. `closed-grant-writes-nothing` - both verbs return exactly `-32102`; every inbox
   stays empty. Positive control: open grant, exactly one file per isolated call.
2. `terminal-stop-status-first` - parameterised over every terminal state
   including an old retained artifact: success, null id, zero writer calls, zero
   files. Deleting the status-first branch must fail the named zero-write
   assertion, with an open inbox so the refusal cannot come from the gate.
3. `request-not-outcome` - exact result keys and types, the id matches the
   committed filename, and no outcome is claimed.
4. `closed-inboxes-preserve-code` - the steer marker and the real public stop
   throw both become `-32109` with no leftovers.
5. `unknown-run-preserves-code` - `-32108`, no writes.
6. `external-run-never-signalled` - an unrelated live pid is recorded; the call
   must send no non-zero signal and the fixture must keep running.
7. `refusal-is-not-transport` - assert the JSON-RPC `error.code` and then the
   preserved `AgentSkillError.code`; a disconnected agent must instead produce
   `AgentUnreachableError`. A refusal is an application result, never a 502.
8. `exit-between-status-and-write` - closure injected after observation: `-32109`
   and no request. Without observed closure, success means "requested", not
   "consumed".
9. `two-controls-distinct-requests` - two independently signed, authorised callers
   produce two distinct complete requests, not one shared request or a claimed
   outcome.
10. Ambiguity, malformed input, unsupported version, and interrupted publication
    each get their own case.

The one-gate assertion stays unchanged, but its fixture must add both skill stubs
and the run-layout fact (`test/spawn-policy.test.ts:82-141`), and T12's inputs
must require the run layout rather than a job manager
(`test/control-skills.test.ts:578-626`) - otherwise both pass for the wrong reason,
returning `-32004` where the test claims to prove `-32102`.

### M8-9 - findings across the fleet

Thresholds evaluated per agent, snapshots mirrored, delivery `notify` by default,
with `steer`/`stop` auto-actions off until an operator turns them on per machine.

**DoD:** a finding fires once per epoch and re-arms only after it clears, with the
restart caveat asserted rather than glossed; an auto-action, when enabled, is an
ordinary control call that meets every M8-8 gate (positive control: with the grant
closed it is refused and writes nothing); a threshold crossing is computed from the
same pure function the Pi package uses (one implementation, asserted by import,
not by copy).

### M8-10 - docs and hardware

**DoD:** `PROTOCOL.md` documents the run skills, their gating, tri-state liveness
and the two new codes; `SECURITY.md` gains the authority statement (a session acts
for its machine; authorization does not travel) and states that the dashboard token
now also stops runs on machines that opted in, with an id-list grant over swarm
peers named as the weak form (ADR 0007); `DEPLOYMENT.md` covers the folded grant;
`README.md`'s fleet overview and Someday list match what is true; a transcript on
three machines (Mac, Pi, Artemis) shows, with no control plane running, a root
session handing off to a peer, following and steering it, and stopping it - and,
with the control plane running, a run listed with its liveness evidence, a real
stop, a refusal with the grant closed, a terminal-run stop that wrote nothing, and
a finding that fired and re-armed.
