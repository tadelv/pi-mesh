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

- The ADR 0008 gate: per-machine opt-in, default deny, `-32003`.
- A Pi RPC client: launch `pi --mode rpc`, JSONL framing, correlation,
  lifecycle.
- The extension-UI problem (below), which is a hang waiting to happen.
- A job table with staged stop, bounded output, and reaping on shutdown.
- `process.spawn`, `process.stop`, `session.steer`, `session.abort`.
- Capability honesty: an un-opted-in machine does not advertise what it refuses.

Out (milestone 3):

- Control plane: SQLite, web UI, pairing flow, loopback listener,
  `docs/DEPLOYMENT.md`.
- `mesh.handoff`.
- Encryption. `SECURITY.md` is unchanged: this is still plaintext HTTP on a
  LAN, and the swarm key is still the only boundary.

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
   denial is `-32003` with `PI_MESH_SPAWN_DENIED`.
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

## Issues

### M2-1 — The spawn gate
- `PI_MESH_ALLOW_SPAWN`: unset means nothing executes; `*` means any member;
  otherwise a comma-separated list of peer IDs.
- Authorization runs before any side effect. Denial is `-32003`, reported as
  `PI_MESH_SPAWN_DENIED`, and names the reason.
- Applies to `process.spawn` and `session.steer`. Does **not** apply to
  `session.abort` or `process.stop` (ADR 0008 decision 5).
- Malformed configuration fails closed, with a clear message — never "parse
  error, therefore allow".
- **DoD:** tests for default deny, wildcard, per-peer allow and per-peer deny,
  malformed config, and a denied spawn that provably starts no process and
  touches no file.

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
- **DoD:** a test that a dialog request with no `timeout` field is answered and
  the session continues; a test that a fire-and-forget request does not
  produce a response or an error.

### M2-4 — Job table, staged stop, and reaping
- One authoritative record per job: mesh job id, owning peer, pid, start time,
  project, cwd, session id, state.
- Staged stop: request graceful shutdown, then `SIGTERM`, then a bounded wait,
  then `SIGKILL`. Observe `close`; never infer termination from `kill()`
  returning true. Stop is idempotent.
- Reap children when the agent shuts down. M1 already learned this the hard
  way: `server.stop()` hung on an open SSE stream.
- Bound retained output, concurrent jobs, and per-peer start rate.
- **DoD:** a child that ignores `SIGTERM` is escalated to `SIGKILL`; stopping
  twice is safe; a stop for an unknown job id is refused; after agent shutdown
  no child survives (checked against the real process table, not a mock).

### M2-5 — `process.spawn`
- Input `{ project, cwd? }`. `cwd` is resolved with `realpath` and must be the
  workspace root or beneath it.
- argv constructed by the agent; the peer supplies no flags.
- Environment is an explicit allowlist; the swarm key and mesh credentials are
  **not** inherited. Asserted positively, not by absence.
- Readiness: do not report success until the child answers, or report the
  failure.
- **DoD:** a `cwd` escaping via `..` and via a symlink is refused; the child
  environment provably lacks the swarm key; a spawn that cannot start reports
  an error rather than a phantom job.

### M2-6 — `process.stop` and `session.abort`
- Both ungated, both allowed to any member.
- `process.stop` takes a job id and refuses anything not in the table.
- `session.abort` maps to the RPC `abort` command.
- **DoD:** stop refuses an unknown job id and never signals an arbitrary PID;
  abort on a live session ends it and is observable.

### M2-7 — `session.steer`
- Maps to the RPC `steer` command. Gated exactly like spawn.
- **DoD:** a steered session receives the message; steering is refused with
  `-32003` when the gate is closed.

### M2-8 — Capability honesty for gated skills
- The agent card and the mDNS `caps` TXT value advertise `process.spawn` and
  `session.steer` only when the gate is open.
- **DoD:** with spawn disabled, neither the card nor `caps` mentions them; with
  it enabled, both do; and `servedSkills()` agrees with both.

### M2-9 — Two-machine proof
- On the real Mac + Pi setup: with the gate open, spawn a session on the Pi,
  steer it, read its entries, abort it; with the gate closed, prove the same
  command is refused and that no Pi process exists afterwards.
- **DoD:** transcripted evidence from the actual machines, including the
  process table on the Pi before and after.

## Exit criteria

- CI green on `main`.
- The two-machine proof above, recorded in the repository.
- A machine with no opt-in refuses execution with `-32003`, starts nothing,
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
