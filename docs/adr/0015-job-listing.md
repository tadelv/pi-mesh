# ADR 0015 — The agent lists the jobs, not the control plane

Status: accepted

## Context

ADR 0013 §6 made the control plane's `jobs` table explicitly non-authoritative: a
cache filled by `process.spawn`, never reconciled, so the dashboard labels every
entry "(last known)". M4 confirmed on hardware what that means in practice — the
list contains only the jobs *this* control plane started. Work started by hand, by
another paired control plane, or arriving through `mesh.handoff` is invisible, and
a job that exits is noticed only when someone presses Stop.

The agent has always held the truth: `JobManager` keeps a `JobRecord` per job it
started, with live state (`running | stopping | exited`), pid, session id,
project and cwd. There was simply no skill that exposed it, so the control plane
had nothing to ask.

Scoping this turned up an honesty defect next door. `process.stop` and
`session.abort` sit in `SERVED_SKILLS` and are therefore advertised by every
agent, but their handlers need a `JobManager`, and `cli.ts` only constructs one
when the spawn policy is enabled. A gate-closed machine therefore advertises two
skills it answers with `-32004`. Observed on this project's own hardware: the Mac
answered `process.stop` with `-32004 process.stop requires a job manager` while
advertising it in its card.

## Decision

### 1. `process.list` reads the agent's job table

A new skill returns the agent's own `JobRecord`s, reduced to what a reader needs:

```
{ job_id, session_id, pid, project, cwd, state, started_at, exit? }
```

- **No `argv`.** A spawn command line is the most sensitive field present and no
  reader needs it; the project, cwd and session id identify the work.
- **No `peerId`.** Which control plane or peer started a job is not the reader's
  business, and publishing it would leak cross-control-plane topology.
- **No job manager → `-32004`**, the same idiom `process.stop` already uses.
- **Ungated**, like `process.stop`. The fields are a strict subset of what
  `session.read` already discloses to the same authenticated principals, so
  gating it would protect nothing while inventing a second authorisation rule.

### 2. Job-backed skills are advertised only when a job manager exists

`servedSkills()` becomes three groups rather than two:

| Group | Skills | Condition |
|---|---|---|
| always served | `mesh.peers`, `session.list`, `session.read`, `session.stream` | none |
| job-backed | `process.list`, `process.stop`, `session.abort` | a job manager exists |
| execution | `process.spawn`, `session.steer`, `mesh.handoff` | the spawn policy allows it |

A gate-closed machine advertises 4 skills; a gate-open machine 10.

This is **advertisement, not authorisation**. ADR 0008 §5 keeps stopping and
aborting ungated, and who may call them does not change. What changes is that a
machine which cannot answer stops claiming it can — the M2-8 rule that
`process.stop` was violating. One visible consequence: the dashboard stops
offering Stop and Abort on a machine with no job manager, which is what `-32004`
was already telling the operator one click too late.

### 3. The control plane mirrors the agent, and says how old the mirror is

- `/api/sync` already calls every paired agent. It now also calls `process.list`
  for each agent that advertises it and **replaces** that agent's rows in the
  `jobs` table with the answer. The cache stops being a guess and becomes a mirror
  of the authority.
- Freshness is per agent and **in memory** (`Map<peerId, number>`), matching the
  capability map. A restart forgets it, which is the correct default: this process
  has verified nothing yet.
- A failed call leaves the last mirror in place and drops the freshness mark.
- `/api/state` reports each agent's `jobs_synced_at`, so the page can say "from
  the agent" or "cached, not synced" instead of implying the same confidence for
  both.
- `process.spawn` and `process.stop` keep writing the cache as they do today; the
  next sync overwrites them with the agent's answer. ADR 0013 §6 still holds —
  this is a cache, now refreshed from the truth instead of assumed to be it.

### 4. What this does not do

- **It does not list `pi` processes the agent did not spawn.** The agent has no
  portable way to attribute those, and inventing one would create a second, worse
  source of truth. "Jobs" means "work pi-mesh started on this machine".
- **It does not stream.** `/api/state` stays a local read; freshness comes from
  sync, and the label carries it. A poll would be a separate decision.

## Consequences

- `docs/PROTOCOL.md` gains `process.list` in the skill table, in the ungated row
  group with its input and output shape.
- The capability tests gain the gate-closed advertisement assertion; the M2-8
  card and mDNS assertions must agree with the three-group split.
- `docs/two-machine-proof.md`'s M4 transcript records the Mac advertising 6
  skills. That is a historical record and stays; the current number for a
  gate-closed machine is 4.
- The dashboard's Jobs section shows the agent's table with per-agent freshness.
- Control-plane code still starts no process and manages no lifecycle: this ADR
  adds a read of the agent's table, so the ADR 0013 §2 guard (a test that scans
  `packages/control-plane/src` for process machinery) must keep passing.

## Alternatives considered

- **Have `/api/state` call the agents live.** Rejected: a page load would fan out
  to N machines and the read path would acquire a failure mode. Sync is where the
  control plane already talks to the fleet.
- **Expose `argv` and `peerId` because they are already in `JobRecord`.** Rejected:
  a new read surface gets the smallest shape that answers the question.
- **Add `process.list` without fixing the stop/abort advertisement.** Rejected:
  that would have shipped a third skill that lies on a gate-closed machine, and
  the fix is the same rule the M2-8 work already established.
