# Milestone 2 — Controlled execution over Pi RPC

Goal: an authenticated peer can **start, steer, and stop a Pi session on
another machine**, and a machine that has not opted in refuses to start
anything at all.

This is deliberately narrower than "milestone 2" as first sketched. The
control plane (SQLite, web dashboard, pairing flow, loopback listener) is a
different kind of work — a UI and a database, with its own decisions about
pairing and token storage — and mixing it into the increment that first
introduces **remote code execution** makes neither one reviewable. It moves to
milestone 3. What remains here is one coherent theme: execution, its gate, and
its supervision.

## Scope

In:

- The ADR 0008 gate: per-machine opt-in, default deny, `-32102`.
- A Pi RPC client: launch `pi --mode rpc`, JSONL framing, correlation,
  lifecycle.
- The extension-UI problem (below), which is a hang waiting to happen.
- A job table with staged stop, bounded output, and reaping on shutdown.
- `process.spawn`, `process.stop`, `session.steer`, `session.abort`.
- Capability honesty: an un-opted-in machine does not advertise what it refuses.

Out (milestone 3), in priority order:

1. **`mesh.handoff`** - deliberately first, and deliberately bounded. It is the
   literal "agents pass tasks" promise of `init.md`'s Why, and leaving it in an
   open-ended deferral is how a mesh becomes a remote-administration tool. It is
   execution-increasing (a peer starts work on your behalf), so it meets the
   ADR 0008 gate rather than a second mechanism. If it slips twice, the honest
   move is to relabel the product as fleet observability and control rather than
   keep promising collaboration.
2. A thin, **user-visible control-plane vertical slice**: dashboard, SQLite and
   pairing as one narrow end-to-end path rather than three layers. The loopback
   listener arrives here, as its first real consumer (ADR 0006 §3).
3. Packaging: `@pi-mesh/agent` is `"private": true` and unpublished while
   `README.md` gives install instructions. Publish, or keep the README honest -
   milestone 2 did the latter.
4. `docs/DEPLOYMENT.md`, still a placeholder.

Swap (1) and (2) only if user-visible value is judged more urgent than the
collaboration promise. Both are legitimate. What is not legitimate is spending
a third milestone on substrate while both remain placeholders.

Also out, and unchanged: **encryption**. `SECURITY.md` still says this is
plaintext HTTP on a LAN and the swarm key is the only boundary.

## Facts this plan is built on

Verified against the installed Pi 0.85.1 docs and the research note in
`docs/research/process-spawning.md`:

- RPC commands exist for what we need: `prompt`, `steer`, `abort`, `bash`,
  `abort_bash`, plus `get_entries`/`get_messages` for state. The mesh skills
  map onto real commands; nothing is invented.
- RPC framing is JSONL with LF as the only delimiter. Node's `readline` is
  **not** compliant (it splits U+2028/U+2029, valid inside JSON strings). M1
  already hit this with session files and the fix is in `jsonl.ts`.
- **Dialog methods block.** `select`/`confirm`/`input`/`editor` emit
  `extension_ui_request` and block until the client sends
  `extension_ui_response`. A `timeout` field auto-resolves, but it is
  **optional**, so a request without one waits forever. `ctx.hasUI` is `true`
  in RPC mode, so extensions believe a UI exists rather than skipping prompts.
- Killing a child does not kill its descendants, and macOS has no
  `PR_SET_PDEATHSIG`.

## Decisions taken before coding

1. **The gate is checked before any side effect.** A denied `process.spawn`
   must not create a directory, read a file, or fork. The check runs on the
   peer identity already verified by the request proof (ADR 0007), and a
   denial is `-32102` with `PI_MESH_SPAWN_DENIED`.
2. **`extension_ui_request` is answered, always, and never allowed to block.**
   This is the sharp edge of RPC mode. With no human present the safe answer
   is "no": dialog methods are answered `cancelled: true` unless policy says
   otherwise. The agent must not silently ignore a dialog, because ignoring it
   is indistinguishable from a hang. Fire-and-forget methods are logged and
   dropped.
3. **A spawned Pi is not sandboxed and must never be described as such.**
   ADR 0008's limits are surfaced in `SECURITY.md` and in the skill
   description, not buried here.
4. **Reads stay file-backed.** `session.list`/`session.read` keep reading
   session files, which is already verified durable. If a live session's file
   is ever found to lag, that becomes its own issue with evidence — it is not
   a licence to add a second, RPC-backed read path now.
5. **`argv` is ours, `cwd` is theirs and constrained.** ADR 0008 decisions 7
   and 8.
6. **Job identity is a mesh job id, not a PID.** ADR 0008 decision 6. PIDs are
   a record field, never an accepted input.
7. **Nothing in this milestone runs `pi` through a shell.** Exec the binary
   directly with an argv array. Both development machines use `fish` as their
   login shell, so `shell: true` would change semantics underneath us, and it
   is an injection hazard regardless.
8. **The argv literal is fixed, and it includes `--no-approve`.**
   Non-interactive modes do not show a trust prompt (`security.md:29` in the
   installed 0.85.1), so a peer-spawned session silently inherits whatever the
   project-trust default is. Trusting a project loads its `.pi/extensions`, and
   extension code is TypeScript running with the user's permissions. A peer
   must not be able to cause project-local code to execute by asking for a
   spawn, so the agent passes `--no-approve` explicitly rather than relying on
   a default. The peer contributes `project` and `cwd`; every flag is ours.
9. **A spawned session becomes visible to the file-backed reader only after it
   persists something.** Measured, not assumed: `get_state` reports
   `sessionId` and `sessionFile` immediately, the file name embeds the
   `sessionId`, and the header `id` equals it — but **no file exists until the
   first turn writes one**. So `session.list` cannot show an idle spawned
   session, and any DoD that reads a spawned session's entries must first have
   produced a turn. This is why reads stay file-backed (decision 4) without a
   second read path: the seam is real and is pinned by test instead.

## Issues

### M2-1 — The spawn gate
- `start --allow-execution`: alone means any member may execute; with
  `=peer-id,peer-id` it names the allowed peers. Unset means nothing executes.
  `PI_MESH_ALLOW_SPAWN` remains the lower-precedence fallback for service
  managers such as systemd.
- Authorization runs before any side effect. Denial is `-32102`, reported as
  `PI_MESH_SPAWN_DENIED`, and names the reason.
- Applies to `process.spawn` and `session.steer`. Does **not** apply to
  `session.abort` or `process.stop` (ADR 0008 decision 5).
- Malformed configuration fails closed, with a clear message — never "parse
  error, therefore allow".
- **DoD:** tests for default deny, wildcard, per-peer allow and per-peer deny,
  malformed config (a wildcard mixed with IDs; a token that is not a peer ID),
  and a denied spawn that provably starts no process and touches no file.
  The last clause is only satisfiable against a **registered stub handler** at
  M2-1, because no execution skill exists yet; it is repeated for real in M2-5,
  which is where an actual process could be started.

### M2-2 — Pi RPC client: framing and lifecycle
- Launch `pi --mode rpc` (binary resolved explicitly, argv array, no shell).
- LF-only record parsing, trailing `\r` stripped, maximum record size, and
  request/response correlation by `id`.
- stdout is protocol-only; diagnostics go to stderr, drained separately so a
  full pipe cannot block the child.
- Handle EOF, malformed records, and child death as distinct, reportable
  states.
- **DoD:** tests for a U+2028 inside a JSON string (which `readline` would
  split), a record split across chunk boundaries, an over-size record refused,
  and mid-stream child death surfacing as an error rather than a hang.

### M2-3 — Extension UI policy (the hang)
- Answer every dialog method with `extension_ui_response` without blocking the
  event loop, defaulting to `cancelled: true`.
- Log fire-and-forget requests; never surface them as protocol errors.
- Enforce our own timeout even when the request carries none, so a dialog can
  never hold a session open indefinitely.
- **The fire-and-forget flood is the common case, measured:** a spawned
  `pi --mode rpc` emitted 27 events on a trivial prompt, the first six of them
  `extension_ui_request` (`setStatus` ×7, `setWidget` ×4, `notify` ×2 in one
  window). No dialog appeared for that extension, but the protocol permits one
  with no timeout, so the handler must exist regardless.
- **DoD:** a test that a dialog request with no `timeout` field is answered and
  the session continues; a test that a fire-and-forget request does not
  produce a response or an error; and a real spawned session that answers a
  trivial prompt to completion with UI traffic present.

### M2-4 — Job table, staged stop, and reaping
- One authoritative record per job: mesh job id, owning peer, pid, start time,
  project, cwd, session id, state.
- Staged stop: request graceful shutdown, then `SIGTERM`, then a bounded wait,
  then `SIGKILL`. Observe `close`; never infer termination from `kill()`
  returning true. Stop is idempotent.
- **A job whose spawner vanished is still our job.** The job id only ever
  exists in the `process.spawn` response, so a peer that disconnects mid-spawn
  leaves a live `pi` nobody can name, stop, or enumerate. Socket closure alone
  is not enough to detect it (the peer may have received the response and then
  died), so unacknowledged jobs also carry a wall-clock deadline and are reaped
  on expiry.

  *Measured correction (2026-02):* this section used to claim the unary path
  "writes that response unconditionally without watching for a closed socket"
  and that the agent therefore dies. It does not. Node silently discards
  `writeHead`/`end` on a destroyed `ServerResponse` — no throw, no `error`
  event, verified both after a clean `close` and after an RST. The agent
  survives a peer disconnect on its own, so there is no guard to add; the harm
  is the orphaned job, not a crash. The survival assertion stays in the tests
  because it is cheap to lock in, not because anything defends it.
- Reap children when the agent shuts down. M1 already learned this the hard
  way: `server.stop()` hung on an open SSE stream.
- Bound retained output, concurrent jobs, and per-peer start rate.
- **DoD:** a child that ignores `SIGTERM` is escalated to `SIGKILL`; stopping
  twice is safe; a stop for an unknown job id is refused; a spawn whose
  requester disconnects before the response is written leaves no child alive
  **once its deadline plus grace has elapsed** (checked against the real
  process table, not a mock, and naming the deadline - "does not leave a
  running child" is unfalsifiable while the mechanism deliberately keeps the
  child alive until that deadline); the agent itself survives the disconnect
  (it already does - see the measured correction above, so this is a
  regression lock, not a fix); and after agent shutdown no child survives.

### M2-5 — `process.spawn`
- Input `{ project, cwd? }`. `cwd` is resolved with `realpath` and must be the
  workspace root or beneath it. The optional workspace defaults to the user's
  home directory; this is an accident guard, not a sandbox.
- argv constructed by the agent, and the literal recorded so it can be checked:
  `[<resolved pi binary>, "--mode", "rpc", "--session-dir", <dir>,
  "--no-approve", "--name", <job name>]`. The peer contributes `project` and
  `cwd`; every flag is ours, and `--no-approve` is what stops a peer-spawned
  session from loading project-local extension code.
- Environment inherits the parent except for every `PI_MESH_*` variable, so
  the swarm key and mesh credentials are **not** inherited while normal local
  tooling remains available. Asserted positively, not by absence.
- Readiness: do not report success until the child answers, or report the
  failure.
- **DoD:** a `cwd` escaping via `..` and via a symlink is refused; the child
  environment provably lacks the swarm key; a spawn that cannot start reports
  an error rather than a phantom job; **the `session_id` returned is accepted
  by file-backed `session.read` and appears in `session.list` once the session
  has produced a turn** (this cross-path assertion is what M2-9 depends on, and
  it is the one seam the two read paths share).

- **Wiring M2-4 handed forward.** Reaping on shutdown is a property of
  `JobManager`, not of the agent: nothing constructs a `JobManager` yet, and
  `cli.ts`'s `cleanup()` does not call `jobs.shutdown()`. Until M2-5 does both,
  M2-4's "after agent shutdown no child survives" holds only in tests, and the
  delivery deadline never fires against a real `pi`.
- **The child goes in its own process group** (`detached: true`) and stop
  signals the GROUP, not the pid - measured, and see ADR 0008 decision 11. This
  is what makes a session's own descendants reachable at all. It also means the
  `cleanup()` wiring above stops being optional: with the child in its own
  session, nothing else will ever kill it.
- **The `pi` binary is resolved to an absolute path** and that literal is
  recorded, because a systemd/launchd daemon has a minimal `PATH` and a
  `PATH`-relative spawn that works in a terminal fails there.

### M2-6 — `process.stop` and `session.abort`
- Both ungated, both allowed to any member.
- `process.stop` takes a job id and refuses anything not in the table.
- `session.abort` maps to the RPC `abort` command.
- **DoD:** stop refuses an unknown job id and never signals an arbitrary PID;
  abort on a live session ends it and is observable **as the absence of any
  further event for that session plus a terminal RPC event, not merely as a
  successful response** - the observation has to be named or the criterion
  cannot fail.

### M2-7 — `session.steer`
- Maps to the RPC `steer` command. Gated exactly like spawn.
- **DoD:** a steered session receives the message; steering is refused with
  `-32102` when the gate is closed.

### M2-8 — Capability honesty for gated skills
- The agent card and the mDNS `caps` TXT value advertise `process.spawn` and
  `session.steer` only when the gate is open.
- **DoD:** with spawn disabled, neither the card nor `caps` mentions them; with
  it enabled, both do.
- **Careful: `servedSkills()` is already the single source for the card, the
  `caps` value and the tests**, so an assertion that all three agree is
  circular and can never fail. The DoD must assert the *gate's* effect on the
  list (disabled ⇒ the names are absent, enabled ⇒ present) from a
  fixed point outside that shared function, or it tests nothing.

- **Outcome (done): the premise was wrong, and no production code changed.** The
  gate was already wired into both surfaces by M2-5/M2-6, so the deliverable is
  `packages/agent/test/capability-honesty.test.ts` - five tests that drive the
  real CLI, fetch the real card over loopback HTTP, and capture `txt.caps` at the
  DNS-SD boundary - plus this correction. Verified by mutation: making the shared
  source ignore the gate fails 3 clauses, making the CARD alone unconditional
  fails 3, making `caps` alone unconditional fails 3, and never advertising the
  gated skills fails 2.
- **The DoD as written was satisfiable by a degenerate solution.** Advertising
  *nothing* when the gate is closed satisfies "neither the card nor `caps`
  mentions them" while breaking the product. The tests therefore also assert the
  exact ungated set survives, which is what makes clause 5 load-bearing rather
  than decorative.
- **The card and `caps` cannot disagree today, and that is a coupling, not a
  guarantee.** The card derives the gate as `enabled && skills.has("process.spawn")`
  and `caps` as `enabled && jobs !== undefined` - different expressions that
  coincide only because `cli.ts` creates the job manager exactly when the gate is
  open and `skills.ts` registers `process.spawn` exactly when a job manager
  exists. The agreement depends on an invariant held in two other files, and the
  two are not equally honest: the card asks whether the skill is really
  registered, `caps` trusts a proxy for it. The card-vs-`caps` regression test
  fails when either surface alone drifts, so it guards the coupling - but it is
  not evidence of the gate's effect, and it should never be cited as such.

### M2-9 — Two-machine proof
- On the real Mac + Pi setup: with the gate open, spawn a session on the Pi,
  steer it, read its entries, abort it; with the gate closed, prove the same
  command is refused and that no Pi process exists afterwards.
- **DoD:** transcripted evidence from the actual machines, including the
  process table on the Pi before and after.

### M2-10 — The gate holds on every dispatch path
- `message/send` and `message/stream` are separate routes; the gate must be
  reached from both. Today `streamMessage` rejects everything but
  `session.stream`, so nothing is bypassable *yet* — the hole would appear the
  day a gated skill becomes streamable, silently.
- **DoD:** a test that iterates `EXECUTION_SKILLS` and asserts each is refused
  for a denied peer over **both** request methods; and the gate itself lives in
  one method that both routes call.

- **Outcome (M2-9, INCOMPLETE): evidence recorded, one clause unreachable.**
  Transcripts are in `docs/two-machine-proof.md`. The proof found a REAL DEFECT
  the fixture never could: with the gate closed, `process.spawn` answered
  `-32004` while `session.steer` answered `-32102` on the same machine at the
  same moment, against the exit criterion below. Fixed in `fb5c338` and
  re-verified on the Pi.
  The unmet clause is "read its entries" for the SPAWNED session. It is not
  reachable: `process.spawn` starts Pi with no prompt and `session.steer` only
  affects a turn already running, so the session never produces a turn, never
  gets a session file, and `session.read` on the returned `session_id` has
  nothing to read. That also means the M2-5 cross-path clause and the M2-7
  clause "a steered session receives the message" are unverifiable against real
  Pi - M2-7 passed against a stub. **Decision pending:** give `process.spawn` an
  optional initial prompt (smallest change, and it makes `session.steer` usable
  at all), add `session.prompt` (new protocol scope, M3), or weaken the DoD.
- **Outcome (M2-10, already satisfied): the DoD held, but the test was passing
  on a state production never reached.** The gate is one private method called
  from both `call()` and `streamMessage()`, and the meta-test iterates
  `EXECUTION_SKILLS` over `message/send` and `message/stream` asserting `-32102`
  for each. But it passed only because the TEST server registered
  `process.spawn` explicitly; production registered it only when a job manager
  existed, i.e. only when the gate was already open. So the meta-test asserted
  an answer that a real gate-closed machine does not give - the exact
  green-for-the-wrong-reason shape. `fb5c338` registers it unconditionally, so
  the test now describes production. Mutation evidence: making the gate no-op
  for one skill fails 3 tests.

## Exit criteria

- CI green on `main`.
- The two-machine proof above, recorded in the repository.
- A machine with no opt-in refuses execution with `-32102`, starts nothing,
  and does not advertise the capability.
- `docs/PROTOCOL.md`, `docs/SECURITY.md` and the agent card agree with the
  implementation.
- No open `TODO`s in `packages/`.

## Risks

- **The gate is the security property of this milestone.** If it is checked
  after any side effect, or if a new code path forgets it, the whole argument
  in ADR 0008 collapses. It should be enforced in one place that every
  execution entry point routes through, not repeated per skill.
- **Extension dialogs are the likeliest production hang**, because they come
  from third-party extension code we do not control, and the failure mode is a
  session that simply never finishes.
- **Orphaned children on macOS** cannot be prevented by the kernel. The
  guarantee is weaker there and must be documented, not assumed away.
- **Resource exhaustion on a 2 GB Pi** is one runaway session away. The
  concurrency cap is not decoration.
- **Steering is execution by another name**: an injected prompt runs tools.
  Treating it as harmless because it "only sends a message" would be the same
  mistake ADR 0008 exists to prevent.
