# @pi-mesh/runs

Readers, tri-state liveness, thresholds and inbox writes for pi-subagents
async runs. Pure Node, ESM, TypeScript. No `@pi-mesh/*` dependency, no Pi
import, no I/O beyond the directories passed in as options.

Pinned upstream: **pi-subagents `0.78.0`** (exact - see `src/version.ts`,
where the pin is the single source of truth for the supported release
line).

## What it does

- `discoverRuns({ tmp, now, maxAgeMs, sessionRoot? })` reads
  `<tmp>/pi-subagents-*/async-subagent-runs/*/status.json` and maps runId,
  state, pid, parent/child session files, agent, mode, timings, steps,
  tokens and cost. A missing root, a malformed `status.json` or an
  unrecognised shape is skipped, never thrown and never a fabricated run.
  `maxAgeMs` bounds terminal runs only: an active run older than the window
  is still listed. Runs are returned newest-first by
  `lastUpdate ?? startedAt`, with `runId` breaking ties.
- `probeLiveness(pid, deps?)` returns `{ state, reason, probedAt }` with
  `state` in `alive | dead | unknown`. `kill(pid, 0)` success is `alive`
  (a process exists - never proof it is this run's runner); `ESRCH` is
  `dead`; `EPERM` is `unknown` (`permission-denied`), not alive; a
  missing/non-integer pid is `unknown` (`no-pid`); a Linux zombie is `dead`;
  a Linux pid in a different pid namespace than ours is `unknown`
  (`namespace-unmatched`), falling back to the kill(0) result when a
  namespace cannot be read. Only signal 0 is ever sent.
- `evaluateRules(runs, config, now)` applies `DEFAULT_RULES` (stale 5 min,
  long 30 min, cost 5 USD, tokens 2,000,000, failure streak 3) for the five
  rules `run-stale`, `run-long`, `run-budget-usd`, `run-budget-tokens` and
  `session-failure-streak`. Pure function, no I/O.
- `stopRun(runDir, options?)` writes a stop request through upstream's
  public `pi-subagents/control-channel` export (`requestAsyncStop`), turning
  its closed-inbox throw into a typed refusal.
- `writeSteerRequest(runDir, request, options?)` writes a steer request into
  `<runDir>/control/steer-requests/` (upstream exports no writer), mirroring
  upstream's bounds and file shape, refusing on a closed inbox and writing
  atomically with a post-write marker re-check.
- `assertSupportedLayout(runDir)` / `assertSupportedVersion(version)` refuse
  (typed, never throw) when the shape or version is not the tested one;
  control writes check both before touching the inbox.

## Upstream-layout warning

The read path and the steer writer depend on pi-subagents' internal run
layout (`status.json` fields, `control/steer-requests/`, the closed-inbox
markers), which is **not a documented contract** - only `requestAsyncStop`
is a public export. The guard is a shape check plus a fail-closed refusal,
not a contract. If upstream changes the layout, discovery skips and control
refuses; nothing is fabricated and nothing is written.
