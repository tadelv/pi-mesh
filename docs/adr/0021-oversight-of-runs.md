# ADR 0021 - Oversight of runs: seeing and controlling work the mesh did not start

Status: proposed - the operator's settlements and a two-advisor council review are
applied below (`docs/research/council-0021-oversight-of-runs.md`). Nothing is
implemented yet.

## Context

An extension on the operator's second machine ("overseer",
`~/.pi/agent/extensions/overseer`) already gives one Pi session visibility over
every other Pi session and every subagent run on that machine, in any project
folder, and lets it steer, stop or interrupt a run by id. Its shape:

- **Observe, no dependencies.** It reads what every Pi process already writes:
  `~/.pi/agent/sessions/--<munged-cwd>--/<iso>_<uuid>.jsonl` for sessions, and
  `<tmp>/pi-subagents-<scope>/async-subagent-runs/<runId>/status.json` for
  subagent runs (state, pid, `sessionId` = parent transcript, `sessionFile` =
  child transcript, steps, tokens, cost).
- **Rules.** Five deterministic thresholds (stale, long, cost, tokens, failure
  streak) become findings, delivered by `notify` (default), `steer` or `stop`.
- **Control.** `steer`/`stop`/`interrupt` by run id: executed in-process when
  this session owns the run (pi-subagents' RPC on `pi.events` is
  ownership-scoped), otherwise broadcast over pi-intercom's extension bus to the
  session that does own it.

What the mesh has today: `session.list`/`read`/`stream` over every session file
on a machine, `process.list`/`spawn`/`stop`, `session.steer`/`abort`/`resume`,
gated execution (ADR 0008), a dashboard with a live session view (ADR 0018), a
jobs mirror that is explicitly the agent's (ADR 0015), and `mesh.handoff`
(ADR 0010). All of it is scoped to work **the agent started**.

So the gap is exact, and it is the operator's stated product claim - the control
plane's job is overseeing and delegating Pi work across machines:

- the mesh sees sessions and agent-spawned jobs, and nothing about **subagent
  runs** - the most numerous and most expensive unit of work on these machines;
- it has no **findings**: nothing notices a stuck, long, over-budget or
  repeatedly failing run;
- it cannot **stop or steer work it did not start** - and most work is started by
  a human in a TUI, not by the dashboard.

## Facts the decision rests on

1. pi-subagents publishes an **in-process** extension API (`pi.events` RPC) and a
   display-only external-run registry. Neither is a cross-process control path.
2. Async/background runs can nevertheless be controlled from outside the Pi
   process, through a portable file-based control inbox the detached runner
   watches: `<runDir>/control/{interrupt.json, stop-requests/*.json,
   steer-requests/*.json}`, with `steer-inbox-closed.json` and
   `stop-inbox-closed.json` as explicit refusals.
3. Of that surface, **only `requestAsyncStop` is exported**
   (`pi-subagents/control-channel`). It writes a request file and returns its
   path; it never reads `status.json`, and it throws when the stop inbox is
   closed, re-checking the marker after the write. Steering and reading have no
   public writer or reader - a steer request must be written by us.
4. **Foreground/in-process runs have no such path.** Only the owning Pi session
   can act on them, which is what pi-intercom is for in the extension today.
5. A run's **child transcript is a real Pi session file but is not addressable
   today**: it sits nested at `<parent-session-dir>/<uuid>/run-0/session.jsonl`,
   while the agent's `SessionStore` enumerates only immediate
   `<sessions-root>/--<munged-cwd>--/*.jsonl` files
   (`packages/agent/src/sessions.ts`).
6. **Liveness from a pid is tri-state at best.** Upstream's own
   `checkPidLiveness` returns `alive` for `kill(pid, 0)` success, `dead` for a
   Linux zombie, `unknown` on EPERM, and still repairs a not-dead run as failed
   after a 24-hour `staleAlivePidMs` window because pid ownership is
   unverifiable (`src/runs/background/stale-run-reconciler.js`).
7. The artifacts and the inbox are pi-subagents' **internal layout**, not a
   documented contract. Version guards and fail-closed behaviour are part of the
   decision, not a detail.
8. The mesh already has an authenticated client, and it is not Pi-specific:
   `packages/agent/src/client.ts` exposes `sendSkill`/`streamSkill` and the CLI
   wraps them (`cli.ts`). So a Pi session is not unable to delegate today - it can
   call that CLI from a shell - and the missing piece is a **discoverable,
   structured tool**, not a new client, principal or route.

## Decision

### 1. The run is a first-class read, with tri-state liveness

The agent gains `run.list` (peer exposure, ungated, like `process.list`): every
subagent run whose artifacts are within a bounded window, with `runId`, `state`,
`liveness`, `pid`, parent and child session references, `agent`, `mode`, timings,
steps, tokens and cost. Artifacts are read from disk on each call; the agent
stores nothing persistent (AGENTS.md, amended for decision 4).

`liveness` is `alive` | `dead` | `unknown`, never a boolean, and it carries the
evidence: a reason (`pid-alive`, `pid-dead`, `permission-denied`,
`namespace-unmatched`, `no-pid`, `zombie`), the probe time, and the status age.

- A successful `kill(pid, 0)` proves **a process exists**, never that it is this
  run's runner, and is never presented as identity.
- **EPERM is `unknown`**, not alive - matching upstream.
- A Linux zombie is `dead`.
- A pid observed in another namespace is `unknown`.
- Upstream's 24-hour repair is a heuristic about ownership, not a fact about the
  run: it is not a mesh window, it is never translated into a claimed death, and
  an active run older than any window is still listed.

**Detail is not free.** Because a run's child transcript is nested (fact 5), the
read path is fixed by extending session discovery and resolution to validated
child transcripts **inside** the sessions root, keeping the one session wire.
There is no `run.read`: a second read path for the same bytes is the drift this
project keeps paying for. A path outside the sessions root is refused, and a
transcript that is not a valid session file is refused rather than half-parsed.

### 2. Control is a request, and the grant is the spawn policy

The mesh serves two control verbs: `run.stop` (written through pi-subagents'
public export) and `run.steer` (a steer request in the run's control inbox).
Both are **gated**: external-run control is folded into the existing
`--allow-execution[=<ids>]` grant, the agent checks `SpawnPolicy` before writing
anything, and it advertises the two skills only where the grant is enabled
(ADR 0006 capability honesty).

This is a **new** grant, recorded as one. ADR 0008's ungated precedent covers
`process.stop`/`session.abort` over jobs *the agent started*; this reaches every
async run on the machine, including work a human started in a TUI. Owned-job
stop and abort stay ungated and unchanged. Note ADR 0007: a swarm peer id is a
claimed routing label, so `--allow-execution=<peer-id>` is the weak form of this
grant, and a paired control-plane id is the strong one.

**Who acts, and who authorizes.** The actor is named rather than implied. A root Pi
session initiating work acts with **its machine's swarm identity**; the mesh has no
per-session principal, so this is machine-level authority, not an authenticated
per-session identity, and a peer-id restriction on such a grant stays the weak
form (ADR 0007). Authorization does not travel: the dashboard being allowed to
drive a root session is **not** authorization for that root to execute elsewhere,
and every destination still opts in with its own `--allow-execution`. Run control
is gated through the **shared dispatch classification** every other execution
skill uses, not a second handler-local check, and run capabilities are classified
by their actual availability (an inbox, a recognised layout) rather than by
whether a managed `JobManager` exists - today's advertisement assumes the latter
and would therefore misreport run control (ADR 0006).

Semantics, in order of what they protect:

- **Order matters.** The agent reads the run's status first: a terminal run
  returns success and writes nothing; a live run's request is written.
- **A request is not an outcome.** The response carries the request id, an
  explicit `requested` indication, and the observed state. It never claims
  `stopped` or `delivered`: consuming the request and the run actually stopping
  are the runner's business, and upstream records a later steering failure in its
  own artifacts, not in our response.
- **A closed inbox is a refusal, not a crash.** Upstream's stop throw and our
  steer writer's closed-marker check both become `-32109`, with no partial file
  left behind and no unhandled rejection.
- **Idempotent.** Stopping an already-terminal run succeeds with the observed
  state (AGENTS.md constraint 6), by the status read above rather than by
  upstream behaviour.
- **Never signal a pid.** The runner's pid is not provably the runner's, which is
  why upstream uses a file inbox; a fallback signal is a defect.
- **An unrecognised layout is a refusal.** Nothing is written into a run
  directory whose shape is not the tested one.

`interrupt` (a resumable pause) is deliberately not served: the mesh cannot
resume a run, so a pause it cannot lift is a worse control than a stop.

### 3. pi-subagents is a pinned dependency, and the layout is still guarded

Settled by the operator: pi-subagents is a dependency of pi-mesh, **pinned from
 the registry** (an exact version, not a range, with the tested range recorded in
one place in `packages/runs`), not vendored. CI installs the pin.

| Need | How |
|---|---|
| `run.stop` | `requestAsyncStop` from the public `pi-subagents/control-channel` subpath |
| `run.steer` | a steer request written into `<runDir>/control/steer-requests/` - upstream exports no writer |
| reading runs | `status.json` and the run directory, read directly - upstream exports no reader for its own runs |

The public export covers one of the three things needed, and that asymmetry is
the risk this decision names rather than hides: a stop cannot be broken by an
upstream layout change; a steer and a read can. Three guards:

- A steer request mirrors upstream's own validation bounds (a non-empty message,
  at most 128 KiB, a timestamp, an id) and re-checks the closed marker after
  writing, so a request we write is one the runner accepts rather than silently
  drops.
- A run directory whose shape is not recognised is refused (`-32109`), and the
  installed version is compared against the pin before anything is written.
- A version check cannot establish which version produced an *existing* run's
  artifacts, so the **shape** check, not the version, decides whether an old run
  is readable or controllable.

A dependency is not the same as assuming Pi is present: the dependency is an npm
package the agent always carries, while whether any run exists on a machine is a
runtime fact. A machine with no Pi has no runs and serves no run skills.

### 4. Findings are the agent's, in a volatile evaluator epoch

The agent evaluates the thresholds over the runs it can see and returns findings
with `evaluated_at`, the config that produced them, and per-agent observation
coverage (last success, last error, whether the layout was recognised). The
control plane mirrors and renders them; it does **not** re-evaluate them.

Suppression is held in a **bounded, volatile, evaluator-owned in-memory map**: no
database, nothing on disk, gone when the process exits. AGENTS.md is amended to
name this map, because "stateless" otherwise forbids the only mechanism that
makes notify-once meaningful. Consequences, stated rather than discovered:

- Suppression is promised **within one evaluator epoch**. A restart may notify
  again; that is accepted, not hidden.
- A **failed observation never counts as clearing** a finding.
- An **expired or absent snapshot means `unknown`**, never healthy.
- An age label alone cannot distinguish healthy-empty from never-evaluated, a
  failed discovery, an unsupported layout or an offline agent, which is why
  coverage travels with the findings.
- The control plane may persist snapshots; it never holds authoritative re-arm
  state.

### 5. The Pi package keeps working standalone

The extension moves into this repository as a Pi package
(`packages/pi-overseer`, `pi install ./packages/pi-overseer`, docs/packages.md)
so it is versioned, tested and installed with the mesh. `packages/runs` holds the
readers, the thresholds and the inbox writer, and both the agent and this package
import it; nothing in `packages/runs` touches the mesh, so the package still runs
standalone with local findings and no agent. CI must therefore provide Pi's types
for that package's build, and a local package's dependency tree is the
operator's to install (docs/packages.md).

A Pi session is a first-class actor, not only the dashboard. The package therefore
ships an optional **mesh tool** beside its local oversight: discover peers, hand
one task to a chosen recipient and keep the returned agent, session and job
handles, then follow that session, steer it or stop it. It reuses the agent's
existing authenticated client paths (`sendSkill`/`streamSkill`, the credential
loaders) instead of adding a principal, a relay or a route: the tool speaks to the
local agent over the existing signed wire. Two limits are stated rather than
discovered - a handoff addressed at loopback starts work **on this machine**, not
remotely, and the tool carries the machine's identity, so a recipient that never
opted in refuses (`-32102`). With no agent installed the package keeps working and
simply has no mesh tool.

### 6. Delegation is the first product slice

Settled by the operator after review: explicit-peer delegation is in this
milestone, because it is the vision's central action and it needs no new
infrastructure. The root session is the actor, and it is spawned and supervised
like any other session - a managed session started in the home folder - which is
what makes it steerable at all: discovering an existing TUI transcript does not
make its runtime controllable (ADR 0016, ADR 0020).

Delegation reuses the existing gated path unchanged:

| Step | Existing machinery |
|---|---|
| choose a peer | `mesh.peers` (read, ungated) |
| hand off one task | `mesh.handoff` (gated, ADR 0010) -> task id, session id, job id |
| follow it | `session.read` / `session.stream` |
| redirect it | `session.steer` (gated) |
| end it | `process.stop` / `session.abort` |

No routing model and no cloud: ADR 0012 stays withdrawn, and "which peer" is an
explicit choice. **There is no dashboard delegate route in this milestone** - a
correction to the earlier draft of this ADR, which implied one already existed;
none does (`packages/control-plane/src/server.ts` serves spawn, steer, stop and
abort only). A dashboard proxy for handoff is a later, separate decision; ADR 0013
deferred routing once already.

### 7. Sequencing: delegation first, then read, then control

Settled by the operator after review, revising the earlier read-only-first
settlement. The revision is recorded as a revision in the council memo rather than
quietly overwritten:

1. **Delegation and the root session** (decision 6) are the first product slice:
they demonstrate the operator's workflow with machinery that already exists.
2. **The external-runs plane reads first.** Mirrors, `run.list`, child-transcript
resolution and a read-only fleet panel land before any run-control route. A read
can be wrong safely; a control will not be.
3. **Run control, then findings.** The two routes below land only after the folded
grant, the request semantics and the capability classification have tests, and
findings delivery follows them.

The two run-control routes, once sequencing reaches them:

| Route | Body |
|---|---|
| `POST /api/agents/:peerId/run/stop` | `{ run_id }` |
| `POST /api/agents/:peerId/run/steer` | `{ run_id, message }` |

They follow ADR 0013's shapes exactly - `200 {ok:true,result}`,
`200 {ok:false,code,message}` for an agent refusal with the agent's code
preserved, `502` for transport, `404 unknown_agent` - and re-validate nothing the
agent owns. New codes, past the existing `-32107` range: `-32108
PI_MESH_UNKNOWN_RUN`, `-32109 PI_MESH_RUN_CONTROL_UNAVAILABLE` (no inbox, closed
inbox, unrecognised layout, or a version outside the pin). No new streamable
skill; M7's live view is untouched.

## What this does not do

- **No live run streaming.** A run's in-flight output is watched through its child
  session when that session belongs to a running mesh job (M7), and not otherwise.
- **No `run.interrupt`.** A resumable pause the mesh cannot lift is not a control
  it should offer; Pi keeps it locally.
- **No run spawn.** Subagents are spawned inside a session; the mesh spawns
  sessions (ADR 0008, ADR 0020).
- **No run-level budget enforcement.** Rules notify; nothing kills a run for cost.
- **No foreground-run control from another machine.** Runs without an inbox are
  controllable only by the session that owns them; the dashboard says so instead
  of pretending.
- **No dashboard delegate route** (decision 6). Delegation is the root session's
  own action through its mesh tool, not a control-plane proxy.
- **No transitive authority.** The dashboard driving a root session is never
  authorization for that root to execute elsewhere; each destination opts in.
- No new principal, no encryption or revocation change.

## Verification this decision commits to

Clauses M8 must make fail for their own named reason, not a timeout or an empty
fixture:

- **The grant is the gate.** With execution closed, `run.stop` and `run.steer` are
  `-32102` **and no file appears in any inbox** (positive control: the same call
  with the grant open writes exactly one request).
- **A terminal run is untouched.** Stop on a terminal run returns success and
  leaves the inbox untouched; the positive control is the same call on a live run
  writing exactly one request; deleting the status-first check fails that test by
  name.
- **A request is not an outcome.** The response names a request id and the
  observed state; a test that returns `stopped` fails by name.
- **A closed inbox is a refusal, not a crash.** `steer-inbox-closed.json`, and the
  public stop API's closed-inbox throw, both become `-32109` with no leftover file.
- **Liveness is tri-state.** A dead pid is `dead`; a simulated EPERM is `unknown`,
  not alive; a run claiming `running` with a dead pid is not alive; removing the
  EPERM branch fails that test by name.
- **No window drops live work.** An active run older than the list window is still
  listed, and its age is never rendered as failure.
- **A nested child transcript is addressable, and nothing else is.**
  `session.read` resolves `<parent-session-dir>/<uuid>/run-0/session.jsonl`; a
  path outside the sessions root is refused; a malformed file is refused rather
  than half-parsed.
- **Findings epoch.** Suppression survives inside one epoch; a restart may notify
  again (asserted, not glossed); a failed observation does not clear; an expired
  snapshot renders as unknown, not healthy.
- **The first slice has no control.** No control route exists yet, and the ADR
  0013 guard test passes unchanged - no control-plane code builds a command line
  or owns a process.
- **No pid signal** is ever sent for a run the agent did not start; a test fails
  if a signal is sent.
- **An unrecognised run directory is not a run.** A malformed `status.json` or an
  unknown layout yields a refusal, never a fabricated run and never a write.
- **Delegation is explicit and gated.** A handoff to a recipient whose execution
  grant is closed is `-32102` **and starts nothing** (positive control: the same
  handoff with the grant open starts one job and returns its handles).
- **Mesh-first.** The root session's tool discovers peers, hands off and follows a
  job with **no control plane running**, and the dashboard's fleet view is
  unchanged when one appears.
- **No new surface.** The tool reuses the existing authenticated client paths; a
  test asserts no new route is served and no unauthenticated listener is opened.
- **Authority does not travel.** A dashboard token that may drive a root session is
  not thereby authorized to execute on whatever destination that root chooses;
  each destination's own gate decides, asserted by the closed-grant case above.
- **Capability honesty for runs.** A machine whose run layout is unrecognised does
  not advertise run skills, and a test fails by name if the advertisement keys off
  `JobManager` availability instead.

## Consequences

- The mesh finally sees the work most likely to be stuck or expensive, and can
  stop it without the operator's shell - under an explicit local grant.
- `packages/runs` is a new pure module with fs fixtures, imported by the agent and
  by the Pi package; the control plane gains two mirror tables (runs, findings
  snapshots) and a read-only fleet panel first, two control routes later.
- `packages/agent` gains its first runtime dependency on a Pi-ecosystem package,
  pinned: CI installs it, and the lockfile changes.
- `packages/agent` gains one bounded volatile map, and AGENTS.md says so.
- `PROTOCOL.md` gains three skills and two codes; the mDNS `caps` list gains the
  control skills only where the grant is open (capability honesty).
- `SECURITY.md` states that the dashboard token now also stops runs on machines
  that opted in, and that an id-list grant over swarm peers is the weak form. It
  also gains the authority statement this ADR introduces: a Pi session acting
  through the mesh tool speaks for its **machine's** swarm identity, there is no
  per-session principal, and authorization to drive a session is not authorization
  to execute elsewhere.
- The agent's capability classifier changes: `caps` can no longer claim execution a
  machine cannot perform, and the ADR 0008 one-gate test must still pass
  unchanged.
- Residual risk, named: pi-mesh's run *read* and `run.steer` depend on a layout
  pi-subagents does not document, while `run.stop` uses its public export. The
  guard is a shape check and a fail-closed refusal, not a contract.
