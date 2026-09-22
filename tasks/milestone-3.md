# Milestone 3 - Collaboration, not remote administration

Ordered by value, not by size. M2's closing note fixes the sequence and the
reason for it: `mesh.handoff` is first because it is the product's actual claim,
and it is bounded on purpose. If it slips twice, the honest move is to relabel
the product as fleet observability and control rather than keep promising
collaboration.

## In

1. `mesh.handoff` - a peer accepts a task, starts work, and hands back the
   handles to watch it (ADR 0010).
2. A thin, user-visible **control-plane vertical slice**: dashboard, SQLite and
   pairing as one narrow end-to-end path rather than three layers. The loopback
   listener arrives here as its first real consumer (ADR 0006 decision 3).
3. **Packaging**: `@pi-mesh/agent` is `"private": true` while `README.md` gives
   install instructions. Publish it, or keep the README honest.
4. `docs/DEPLOYMENT.md`, still a placeholder. It must carry the systemd scope with
   `KillMode=control-group`, because a hard-killed agent leaves tool commands
   behind on Linux as well as macOS (measured: ADR 0008 amendment).

## Issues

### M3-1 - `mesh.handoff`

- Input is the frozen `HandoffPayload`: `task`, `project`, `context`,
  `preferred_agent`, `deadline_ms`. No new envelope (ADR 0010 decision 1).
- It is an **execution skill**: registered unconditionally, gated by the same
  `gateExecution` path as `process.spawn`, refused with `-32102` when execution is
  disabled, and advertised only when it is enabled.
- Success returns `{ task_id, session_id, job_id }` - the handles that let the
  caller actually watch the work (ADR 0010 decision 3).
- `preferred_agent` naming another peer settles the task as `TASK_STATE_REJECTED`,
  which is **not** a JSON-RPC error and is not escalated (ADR 0010 decision 4).
- `task` becomes the child's initial prompt through the existing path; a non-empty
  `context` is rendered into that same prompt (ADR 0010 decision 7). `project`
  resolves under the workspace root with the usual containment check - it is not a
  free `cwd` (ADR 0010 decision 8).
- `deadline_ms` bounds **acceptance**, not execution (ADR 0010 decision 5).
- **DoD:**
  - A handoff to a peer with execution enabled starts exactly one session, whose
    prompt is the task (plus context when present), and returns all three ids.
  - A handoff with `preferred_agent` set to a different peer is rejected without
    starting anything - **no process, no session, no file** - and returns a
    rejected task rather than an error.
  - A handoff to a peer with execution disabled is `-32102`, and the capability
    surfaces agree (`process.spawn` and `mesh.handoff` appear together, or not at
    all) - ADR 0006 honesty, checked at the card and the DNS-SD `caps` boundary.
  - `deadline_ms` expiring before acceptance is a clean failure with nothing left
    running (`ps` shows no new `pi`, and the job table has no accepted entry).
  - A `project` that escapes the workspace root is refused by the same containment
    check as `process.spawn`; a symlink out of the root is refused too.
  - Rejection is distinguishable from denial: one is a settled rejected task, the
    other is `-32102`, and the test asserts the two differ rather than accepting
    either.
- **Evidence:** every clause must be broken and shown to fail by the clause it
  names. Two clauses deserve naming in advance, because they are the ones that
  cannot fail by accident: "rejection is not an error" passes trivially if the
  implementation never rejects, and "nothing was started" passes trivially if the
  process never started. Both need a positive observation (a settled rejected
  task; a process table before and after that is genuinely non-empty before).

## Exit criteria

- A member can hand a bounded task to a peer that opted in, watch it work, and
  stop it - without a control plane and without the caller holding any credential
  but the swarm key.
- A member that did not opt in advertises no execution skill and refuses handoff
  with `-32102`.
- Nothing in this milestone requires outbound internet.

## Risks

- **The product claim and the feature can drift apart.** If handoff lands but
  nobody can route to a suitable peer, the mesh is still a remote-administration
  tool with extra words. M3-2's slice is what makes the claim usable; if it slips,
  say so in `README.md` rather than describing a capability nobody exercises.
- **Two spawn paths.** `mesh.handoff` must reuse the spawn path rather than growing
  a second one; the moment there are two, the gate has two places to be forgotten.
- **The workspace guard is an accident guard.** It is not isolation, and
  `DEPLOYMENT.md` must not imply otherwise (ADR 0008 amendment).
