# Overseer

One pi session watching — and steering — every other pi session and subagent run
on the machine, in any project folder.

## Two planes

**Observe (no dependencies).** Reads the evidence every pi process already writes:

- `~/.pi/agent/sessions/--<munged-cwd>--/<iso>_<uuid>.jsonl` — every session transcript
- `<tmp>/pi-subagents-<scope>/async-subagent-runs/<runId>/status.json` — every subagent run

Runs are joined to their parent session via `status.json.sessionId`. A session is
"live" when its transcript was written in the last 2 minutes. A run's
liveness is tri-state - `alive | dead | unknown` with its evidence
(reason, probe time) - from `@pi-mesh/runs` (ADR 0021 decision 1): a
successful probe proves a process exists, never that it is this run's
runner; EPERM is `unknown`, a Linux zombie is `dead`. A run counts as
live only when its state is active (`queued/running/paused`) *and* its
probe came back `alive`; anything else is still listed, with its reason
shown (`◐ unknown(permission-denied)`).

**Control.** `steer` / `stop` / `interrupt` a run by id:

- If this session **owns** the run → executes the pi-subagents RPC locally.
- Otherwise → broadcasts an `overseer/v1` command over pi-intercom's extension bus.
  The owning session receives it and executes the RPC in **its** process.

Ownership matters because pi-subagents' RPC is ownership-scoped: only the session
whose branch spawned a run may control it. The target key is exactly pi-subagents'
own identity (`getSessionFile() ?? getSessionId()`), so keys always match.

pi-intercom is optional. Without it the overseer still observes everything and
controls its own runs; cross-window control goes quiet.

## Surfaces

- **`/overseer`** — live panel: control status, findings, live runs, sessions.
- **`overseer` tool** — actions `summary | runs | sessions | findings | steer | stop | interrupt`.
- **Status line** — `N live · X finding(s) · steer ready`.

## Rules

Deterministic thresholds in `config.json`:

| rule | fires when |
|---|---|
| `run-stale` | active run, no update for `staleMs` |
| `run-long` | active run older than `maxRuntimeMs` |
| `run-budget-usd` | any run cost > `maxCostUsd` |
| `run-budget-tokens` | any run tokens > `maxTokens` |
| `session-failure-streak` | trailing `failureStreak` consecutive `failed` runs in one session |

Thresholds are evaluated by `@pi-mesh/runs` - see "Run evidence comes
from `@pi-mesh/runs`" below for the old -> new differences this adoption
introduced.

`rules.action` decides delivery:

- `"notify"` (default) — a message, nothing is touched.
- `"steer"` — sends `autoSteerMessage` to the stalled run.
- `"stop"` — stops the run.

Findings notify once and re-arm only after they clear.

## Configuration

`~/.pi/agent/extensions/overseer/config.json`:

```json
{
  "maxAgeHours": 24,
  "autoSteerMessage": "Overseer: this run looks stalled...",
  "rules": { "action": "notify", "staleMs": 300000, "maxCostUsd": 5 }
}
```

Subagent child sessions load this extension too, so their runs are addressable.
They register for control but skip the scan, notifications, and auto-actions.

## Layout

| file | role |
|---|---|
| `discovery.ts` | scans sessions + run artifacts (plain `node:fs`, testable) |
| `rules.ts` | thresholds → findings |
| `control.ts` | pi-subagents RPC client (steer/stop/interrupt) |
| `channel.ts` | pi-intercom `overseer/v1` extension channel |
| `panel.ts` | `/overseer` view |
| `format.ts` | display helpers |
| `index.ts` | tool, command, lifecycle, rule execution |

## Adopted into pi-mesh (`packages/pi-overseer`)

This extension is developed here and installed into Pi from a checkout:

```sh
pi install ./packages/pi-overseer
```

Pi loads the TypeScript directly, so the package has no `build` script and no
`dist` output; it stays out of the `tsc -b` project graph. A fresh clone
needs `pnpm -r build` before Pi loads the package, because it now imports
`@pi-mesh/runs` from that package's built `dist`.

```sh
pnpm --filter @pi-mesh/pi-overseer typecheck
pnpm --filter @pi-mesh/pi-overseer lint
pnpm --filter @pi-mesh/pi-overseer test
```

Tested against **Pi 1.3.0** (`@earendil-works/pi-coding-agent` 1.3.0) and
**pi-subagents 0.78.0**. Pi supplies `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui` and `typebox` to extensions at runtime (carried as
`peerDependencies`); the same versions are pinned as `devDependencies` so
typecheck and lint work on a machine without Pi installed.

Three adoption-only deviations let the otherwise frozen extension pass this
repository's gates: the `registerTool` call carries explicit type arguments
naming the accurate union of the three `details` shapes it returns (Pi's own
example extension declares a single details type the same way), `panel.ts`
holds two `void _width;` no-op markers where its private line helpers ignore
their trailing width parameter, and this package's `tsconfig.json` sets
`exactOptionalPropertyTypes: false` - so the extension's optional properties
are checked less strictly than the rest of this repository. Transpiling the
sources before and after shows nothing else: the type annotations erase
entirely and only the two no-op statements (plus their renames and comments)
appear in the output.

Without pi-subagents on a machine, local oversight keeps working - the observe
plane is plain `node:fs` reads of session transcripts and run `status.json`
files with no pi imports. Control goes quiet: `steer` / `stop` / `interrupt`
need pi-subagents' ownership-scoped RPC in the owning session, so they time out
instead of acting, and cross-window control (which also needs the pi-intercom
extension bus) goes quiet with it.

## Run evidence comes from `@pi-mesh/runs` (M8-1b)

Run discovery, pid liveness and rule evaluation are `@pi-mesh/runs`'s
job; this package maps its config onto the module, presents the
module's findings, and keeps delivery (`notify` / `steer` / `stop`,
`autoSteerMessage`). Session scanning stays here - the module reads run
artifacts only.

Behavioural differences, old -> new with reason (liveness: ADR 0021
decision 1, tri-state `alive | dead | unknown`):

1. EPERM on a pid probe meant *alive* -> now `unknown`
   (`permission-denied`): an unsignallable process proves nothing about
   this run.
2. A Linux zombie read as *alive* (`kill(pid, 0)` succeeds) -> now
   `dead`: only `/proc/<pid>/stat` state `Z` is evidence.
3. The `maxAgeHours` window dropped any run whose `status.json` mtime was
   old -> now it bounds terminal runs only, by payload age
   (`now - (lastUpdate ?? startedAt)`), so an old running run is still
   listed: no window drops live work.
4. Ordering was newest-first by `lastActivityAt ?? startedAt` -> now
   newest-first by `lastUpdate ?? startedAt` with `runId` breaking ties
   (the module's order, adopted verbatim).
5. A missing pid counted as *live* -> now `unknown` (`no-pid`), never
   live; `liveRuns` means active state *and* an `alive` probe.
6. Active states were `running/queued/starting` -> now
   `queued/running/paused`; `starting` and other unknown states are
   skipped as unrecognised layout (the module's shape guard).
7. Freshness was `lastActivityAt` -> now `lastUpdate` (upstream's
   status-write clock); the stale age is `now - (lastUpdate ??
   startedAt)`.
8. Stale/long rules ran over live runs only -> now over all active-state
   runs: liveness no longer gates detection.
9. Budget rules ran over live runs with `>=` -> now over any run
   (including terminal) with `>`: a strict crossing on a finished run
   still counts.
10. The streak counted `failed/timeout/stopped/error` anywhere in the
    session group -> now trailing consecutive `state === "failed"` in
    start-time order; anything else breaks the streak and missing data
    never clears it.
11. Token totals tolerated partial shapes -> now a run without numeric
    `input`/`output`/`total` reports no token count and cannot trip the
    token rule (module shape guard); cost (`totalCost.costUsd`) is
    unchanged.
12. Steps of any shape were tolerated -> now a step without string
    `agent`/`status` skips the whole run as unrecognised layout; the
    agent is still the first step's.
13. `startedAt` was optional -> now required: a run without a numeric
    `startedAt` is skipped, never fabricated.
14. Finding text was composed here -> now the module's `summary` is the
    message; severity (`critical` at 3x stale, streaks) and `action`
    stay package-side presentation.
15. `findRun` scanned tmp ignoring age -> now module discovery with an
    unbounded window: same no-age-drop guarantee, one code path.

Config mapping (`rules` object, `maxAgeHours` as the window):

| package key | module equivalent |
|---|---|
| `rules.staleMs` | `staleMs` (non-finite values fall back to the module default) |
| `rules.maxRuntimeMs` | `longMs` |
| `rules.maxCostUsd` | `maxCostUsd` |
| `rules.maxTokens` | `maxTokens` |
| `rules.failureStreak` | `failureStreak` |
| `maxAgeHours` | `maxAgeMs` window (terminal runs only) |

Kept package-side with no module equivalent: `rules.enabled`,
`rules.action`, `autoSteerMessage`, finding severity, and the `cwd` /
latest-window token passthrough (display only, read best-effort
beside detection).

Candidates for the module (implemented here, not there, per M8-1b
scope): `cwd` and `totalTokens.window` passthrough on the record, a
`lastActivityAt` fallback for `lastUpdate`, surfacing discovery skip
reasons, and a lookup-by-id helper.

## Configuration file

The running extension reads its config from
`~/.pi/agent/extensions/overseer/config.json` - the installed location, loaded
by `loadConfig()` in `index.ts` - falling back to built-in defaults when the
file is absent or a field has the wrong type. The `config.json` copy in this
package is not read at runtime; it is the default shipped alongside the
extension so a fresh `pi install` starts from the documented thresholds.
