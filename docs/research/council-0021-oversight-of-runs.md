# Council memo - ADR 0021 (oversight of runs)

Date: 2026-10-15. Parent: the Pi session that wrote `docs/adr/0021-oversight-of-runs.md`
and `tasks/milestone-8.md`. Passes run: 2 (the declared cap). Nothing in this memo
has been applied to the ADR yet.

## Question and scope

Does `docs/adr/0021-oversight-of-runs.md`, plus `tasks/milestone-8.md`, give
pi-mesh a correct and shippable path to overseeing and controlling Pi subagent
runs across a LAN? Settled before launch, not open to the council: pi-subagents
may be a runtime dependency, and one shared module (`packages/runs`) holds the
readers, the thresholds and the inbox writer.

Scope: the five questions in the brief (control semantics, liveness, gating,
findings freshness, milestone slicing). Out of scope: implementation, and any
re-litigation of the two settled decisions.

## Roster, runs and context modes

| Seat | Profile | Model | Context | Pass 1 | Pass 2 |
|---|---|---|---|---|---|
| adversary A | `council-grok-a` | `opencode-go/grok-4.7` | fresh | **failed** (3 attempts) | not run |
| realist | `council-grok-b` | `opencode-go/grok-4.6` | fresh | complete, `9203c734` | **failed**: `opencode-go` 429 quota |
| adversary B | `council-codex` | `openai-codex/gpt-6.1-sol` | fresh | complete, `b059cd0a` | complete, `d915664d` |

No fallback `oracle` was forked and no fresh-context fallback was used. Two
advisors reported; **one of the two cross-exams is missing**, so C1 and C2 below
are unresolved by the council and are recorded as owner decisions rather than
consensus.

Adversary A failed twice for a harness reason and once for the provider:
background subagent children inherit this session's ambient Pi Fabric extension,
whose only model tool is `fabric_exec` - unregistered inside a detached runner -
so both of its first two reports were written without reading a single file.
Fixed by `extensions: []` in the advisor profile. Its third attempt died on
the same 429. Those two prose reports are **not admitted as council input**: the
workflow that produced them asserts a tool surface that could not read the repo.

## Recommendation (parent)

The ADR is **not shippable as written**. Four of its decisions need repair before
any implementation, and the milestone's first slice should shrink. The direction
is right: the run is a first-class read, the inbox is the control wire, and the
findings belong to the agent - but three of those are stated more strongly than
the evidence supports, and one (the transcript claim) is false.

## Accepted feedback, with the parent's verification

1. **Stop is a request, and the code must say so.** `requestAsyncStop` is the
   only public export (`package.json` exports map); it writes a request file and
   returns its path, never reads `status.json`, and throws when
   `stop-inbox-closed.json` exists, re-checking after the write. So `-32109` is
   upstream, but "a terminal run writes nothing" is **our** policy and must be
   ordered before the call, not derived from its result. Both advisors also
   insist the response must not claim `stopped`/`delivered`: return the request
   id and the observed state. Accepted; decision 2 and M8-3 are rewritten.
2. **Liveness is tri-state, and the pid probe is weaker than I wrote.** Verified
   myself in `stale-run-reconciler.js:312-336,403-420`: `kill(pid,0)` success is
   "alive", a Linux zombie is "dead", EPERM is "unknown", and a successful probe
   is still repaired as failed after a 24h `staleAlivePidMs` window because pid
   ownership is unverifiable. My ADR's "EPERM still means alive" is wrong, and
   `live: boolean` overstates what can be known. Accepted: alive/dead/unknown,
   each with reason, probe time, namespace confidence and status age; the
   24-hour figure is upstream's repair heuristic, not a mesh list window, and no
   older active run may be dropped for it. Codex's refinement is kept: upstream
   downgrades only a *dead* probe on a namespace mismatch, not a successful one.
3. **A run's transcript is not addressable today - decision 1 is false.**
   `run-0/session.jsonl` (and siblings) sit nested under the parent session
   directory; the agent's `SessionStore` enumerates only immediate
   `<sessions-root>/--<munged-cwd>--/*.jsonl` files (`packages/agent/src/sessions.ts:206-236`).
   Codex verified this against a real retained run of its own. Accepted, with the
   parent's choice of fix: extend session discovery/resolution to validated child
   transcripts and keep the one session wire, rather than adding a second read
   path (`run.read`) that would duplicate `session.read`.
4. **Findings need an owner and an epoch.** A cached age label cannot distinguish
   healthy-empty from never-evaluated, failed discovery, an unsupported layout or
   an offline agent, and re-arm state collides with AGENTS.md's "no database in
   the agent". Accepted (codex's refinement, which is smaller than grok-b's
   removal): a bounded, volatile, evaluator-owned in-process map; suppression is
   promised only within one evaluator epoch (a restart may notify again); failed
   observation never counts as clearing; an expired snapshot means unknown, not
   healthy; the control plane may persist snapshots but never authoritative
   re-arm state. Deferring findings out of the first slice is accepted; deleting
   them from the milestone is not (grok-b's stronger position is not adopted - see
   rejected, below).
5. **Bookkeeping defects.** M8-4 says "three routes" where ADR decision 7 defines
   two; `closeStopInbox()` runs at runner shutdown before state goes terminal,
   which is the ordering the DoD must assert. Accepted.

## Rejected feedback, with reasons

- **"Ungated `run.stop` follows ADR 0008."** Rejected. ADR 0008's ungated
  precedent is `process.stop`/`session.abort` over jobs *the agent started*;
  `run.stop` reaches every async run on the machine, including work a human
  started in a TUI. Both advisors challenged it independently. It is a new grant
  and it is now an owner decision, not an inherited precedent.
- **"Documentation is enough for that grant."** Rejected (codex): documentation
  is not consent. Any wider grant must be a deliberate, local opt-in.
- **"Findings should leave M8 entirely"** (grok-b's position, restated in its
  pass-1 report). Partially rejected: deferring the findings slice is accepted,
  removing the capability from the milestone is not, because codex showed a
  volatile bounded map satisfies the statelessness constraint without a DB.
- **Adversary A's two undelivered "do-not-ship" reports.** Not admitted: both
  were produced by a child whose file tools did not exist, so their confidence
  carries no evidence. Their one useful contribution is the harness defect
  itself, recorded below.

## Owner decisions (settled by the operator, 2026-10-15)

Answered after this memo was written, so the reasoning below stays as first
written:

1. Stop grant: **fold external-run stopping into `--allow-execution[=<ids>]`**.
2. First slice: **read-only**.
3. Findings: **in M8, after the read slice**; AGENTS.md amended to permit the
   volatile bounded evaluator map.
4. Dependency: **pinned from the registry**, not vendored.

Revised later the same day, after a plan review
(`plan-reviewer` run `b930b2e7`, which judged the plan *moderate* distance from
the operator's stated vision of one root Pi session delegating to, overseeing and
controlling the other agents):

5. Sequencing: **root-to-peer delegation is the first product slice**, with
   read-before-write staging kept inside the external-runs work and findings
   after it. This explicitly revises answer 2 above; the review required the
   revision to be recorded rather than silently applied.
6. Delegation scope: **explicit-peer delegation in M8**, reusing the existing
   gated `mesh.handoff` unchanged, with no dashboard delegate route and no
   routing model.

## Owner decisions as put to the operator

1. **The stop grant.** Smallest shape per codex: amend the existing
   `--allow-execution[=<ids>]` to include external-run stopping, check
   `SpawnPolicy.allows` before any inbox write, and advertise `run.stop` only
   when enabled; a separate, identically shaped `--allow-run-stop` only if an
   operator must grant stopping without granting execution. Note ADR 0007: a
   swarm peer id is a claimed label, so an id-list grant is the weak form; the
   paired control-plane id is the strong one. Keep owned-job stop/abort ungated.
2. **The first slice (C1, unresolved between the advisors).** Codex: read-only
   first (readers, `run.list`, mirror, honest panel, transcript resolution) and
   add stop the moment consent exists. grok-b: list + stop first, with stop as
   the safety valve. The council did not settle it; the parent leans read-only,
   because codex's argument (a stop whose result is an unobserved request,
   against an unsettled grant) is evidence-backed and grok-b's seat never
   answered.
3. **Findings and AGENTS.md.** Whether to amend the "stateless" wording to
   permit the volatile evaluator map, and whether findings land in M8 at all.
4. **Dependency shape.** Pin `pi-subagents` from the registry, or vendor it for
   CI and image determinism. CI is ubuntu with no `pi` binary; the Docker image
   is control-plane-only, so a new agent dependency changes the lockfile and the
   image, and `packages/pi-overseer` would need Pi types in CI.

## Evidence

- Pass 1: `council-grok-b` run `9203c734-80d8-46be-8383-a992468ad817` (14 turns,
  71 tool calls, $0.51, structured output produced).
- Pass 1: `council-codex` run `b059cd0a-960d-434d-b170-bcf5d89a0a29`.
- Pass 2: `council-codex` run `d915664d-bdc2-44bf-b2ad-dbcbbd2434cc`.
- Failed seats: `council-grok-a` runs `5ba0f589` (harness), `50784ca1` (harness),
  `de707c39` (429); `council-grok-b` pass 2 run `8dad1c4d` (429).
- Parent-verified upstream facts: `pi-subagents/package.json` exports map,
  `src/runs/background/control-channel.js`,
  `src/runs/background/stale-run-reconciler.js:312-336,403-420`,
  `packages/agent/src/sessions.ts:206-236`.

## Confidence and what would change it

High that decision 1 is false (child transcript addressability), that liveness
must be tri-state, and that stop must not report an unobserved outcome: all four
are verified in installed code, not argued. Medium on slicing, and low on
anything gated by the owner decisions above.

What would change the recommendation, per codex: real-run tests showing request
consumption and closure races; Mac/Linux/container fixtures that reject false
liveness; and a deployed read-only slice that distinguishes healthy, stale and
unobserved agents. Per the parent: a working cross-exam from the adversarial
seat that read the repo (its first two attempts did not).

## Harness lesson worth keeping

A subagent report is indistinguishable from a real one by its tone. Both failed
adversary reports read as confident reviews of documents their child could not
open. Background children inherit ambient extensions, and Pi Fabric full-code
mode replaces the model's whole tool surface with `fabric_exec`, which is
unregistered in a detached runner; foreground children never load ambient
extensions, so a foreground control passes while every async child fails. Two
guards, both cheap: set `extensions: []` on read-only advisors, and check the
child transcript's tool-call counts before believing its report.
