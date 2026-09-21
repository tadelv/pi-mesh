# Gotchas

Failure modes this project has actually hit, each with the evidence that
established it. This is not a style guide and not a substitute for the ADRs:
it is the list of things that cost someone an afternoon, so the next person
loses ten minutes instead.

**Rule for adding to this file:** an entry needs a measurement, a command, or
a commit. "This seemed flaky" is not an entry. If you cannot say how you know,
you do not know yet.

## Verification

- **A green local run is not evidence.** CI failed three times on changes whose
  every local gate passed: a `readline` difference between Node 22 and 26, a
  race that resolved differently on Linux than on macOS (`f807590`), and a
  dangling reference to a dropped edit. Run the gates, then read CI.
- **A test that cannot fail is worse than no test**, because it is counted as
  coverage. Prove a test discriminates by deleting the code it protects and
  watching it fail. This has caught a defect in four consecutive rounds here:
  an idempotence test comparing an object to itself, an "agent survived"
  assertion calling `process.kill(process.pid, 0)` from inside that same
  process, a both-paths gate test that survived deleting the gate, and a chunk
  decoder test that split at an ASCII byte so a naive implementation passed.
- **A test double more capable than the thing it stands in for cannot fail.**
  The RPC fixture implemented a `shutdown` command that real Pi answers with
  `{"success":false,"error":"Unknown command: shutdown"}` — so eight passing
  tests exercised a protocol Pi does not speak, and hid a dead code path.
  Check the direction of the gap: a stub may be *less* capable (that is what an
  escalation test needs) but never quietly *more*.
- **Watch for a bound that sits above the harness timeout.** A 10s timeout in a
  vitest test with the default 5s `testTimeout` is dead code: the harness fails
  first and the message never appears.
- **A test may never have triggered the code it names.** `JobManager`'s
  `holdfd` regression test called `close()` without ever sending a command, but
  the fixture only enters that mode on a command — so nothing held the pipe and
  the hazard never materialised. Restoring the bug left the test green.
- **Assert the property, not the race winner.** A dying child emits two reports
  Node does not order — `exit` and stdout EOF — and the winner differs between
  macOS and Linux. Assert "a death report, never a timeout", then check it still
  fails when the report is removed (`f807590`).
- **Run a race-sensitive test more than once.** One green run says nothing.
  Twelve is a reasonable floor before believing it.

## Node / runtime

- **`response.writeHead`/`end` on a destroyed socket does not throw and does not
  emit `error`.** Verified after a clean `close` and after an RST. So "the agent
  dies writing to a dropped socket" is false, and a guard for it is dead code.
  The real damage is a silently discarded payload.
- **`finish` never fires for a response whose socket was destroyed; only `close`
  does.** On a healthy response both fire, `finish` first. This makes
  `once("finish")` the correct place to confirm delivery — a pre-write
  `destroyed` check also passes when the socket dies *during* the write.
  `finish` means "flushed to the kernel", not "received", so the residual window
  is not closable from the application.
- **A process's children are unidentifiable once it dies.** Measured: the
  grandchild's `ppid` was the child's pid while the child lived, and `1` four
  hundred milliseconds after the child was killed — the kernel reparents orphans
  to init (launchd on macOS), erasing the link. So "find and kill the children
  of that dead session" is not a thing you can do afterwards: parentage is gone,
  and the remaining options are matching on command line (which is how you kill
  somebody else's process) or having recorded the pids *before* the kill, which
  is a snapshot of a tree that can grow after it. Label the tree at spawn time
  instead — see the process-group entry below. On Linux,
  `PR_SET_CHILD_SUBREAPER` or a cgroup is the deterministic version of "be the
  reaper for my orphaned descendants"; neither exists on macOS.
- **Killing a child does not kill its descendants.** Measured:

  ```
  { detached: false, childAlive: false, grandchildAlive: true  }
  { detached: true,  childAlive: false, grandchildAlive: false }
  ```

  Only a separate process group (`detached: true`, i.e. `setsid()`) plus a
  negative-pid signal (`process.kill(-pid, ...)`) reaps the tree. POSIX only.
- **`readline` splits on `U+2028` on Node 26 but not on Node 22.** Never assert
  a dependency's version-specific behaviour; the JSONL decoder frames bytes and
  does not use `readline`.
- **`process.kill(undefined, 0)` throws a `TypeError`**, so `expect(() =>
  process.kill(pid, 0)).toThrow()` passes when the pid is missing — reporting a
  dead process that never existed. Assert the pid is a real number first.
- **Writing to a destroyed stdin emits an asynchronous stream error**, which
  without a listener is an uncaught exception that kills the whole agent.

## Environment / tooling

- **A global `~/.gitignore` containing `/Packages` case-insensitively ignores
  `packages/` in every repo on macOS.** Workaround: `!packages/` and
  `!packages/**` in `.git/info/exclude`.
- **`git status` is not enough to catch a stray artifact.** `.review-diff.patch`
  sat untracked next to a `git add -A`; exclude such files in
  `.git/info/exclude` rather than trusting yourself to remember.
- **A rejected multi-edit batch is a TOTAL failure, not a partial one.** A
  dropped `edits[N]` silently loses the whole call; only a rebuilt binary
  revealed it (via a stale warning string in `doctor`).
- **The agent package imports `@pi-mesh/protocol` from its built `dist`**, so
  editing `packages/protocol/src` has no effect on agent tests until protocol is
  rebuilt.
- **`pnpm -r lint` catches unused imports that `tsc` does not.**
- **`(cmd)` in fish is command substitution, not a subshell.** Every
  `(umask 077 && ...)` instruction in the docs was silently wrong on both dev
  machines, whose login shell is `fish`.
- **Always `ssh host bash -s <<'EOF'` for remote scripts.** A POSIX loop dies
  with `fish: Expected end of the statement` under a fish login shell.
- **`timeout` is not present on macOS by default.**
- **`cd X && node ... &` backgrounds the whole chain**; `cd` on its own line.

## Process / delegation

- **A worker's report is a log line about intent, not evidence.** Read the diff
  and run the thing. Every round here has needed repair after a "green" report.
- **A worker may revert files outside its task.** One reverted a plan
  correction it judged unrelated, silently restoring a false premise that the
  commit had just fixed. Check `git status` against your own edits after any
  delegated run.
- **A subagent's artifacts are not where you asked for them.** They land under
  `~/.pi/agent/sessions/--<cwd-as-dashes>--/subagent-artifacts/outputs/<runId>/`.
  An empty requested path is not evidence of fabrication.
- **A reviewer with no shell produces static analysis, not measurements.** Ask,
  and it will say so. Treat "this test cannot fail" as a hypothesis to falsify.
- **An `ignoreterm`-style child survives `pkill`** (it ignores `SIGTERM`), so a
  leaked one needs `kill -9`. Counting leaked processes with `pgrep -f <script>`
  also matches your own shell command line; use `ps -eo command | grep -c
  '[s]cript'`.
- **Break-testing leaks processes when the break removes the only mechanism that
  could kill them.** Count the process table after a break run, not just after
  the suite.
