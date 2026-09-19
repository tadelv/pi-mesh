# Research: Process spawning for pi-mesh milestone 2

> Research note, not a decision. It gathers primary-source evidence so the spawn
> policy (see the ADR this feeds) can be argued from facts rather than habit.
> Nothing here is normative: `docs/PROTOCOL.md`, `docs/SECURITY.md` and the ADRs
> are. Produced by a research subagent against primary sources; the claims marked
> *verified* below were independently re-checked against the same primary sources
> by the reviewer, and the two gaps the researcher flagged as unverifiable were
> closed (`pi` 0.85.1 was confirmed locally, and macOS behaviour is now stated).

## Summary
Use direct, asynchronous `child_process.spawn()`/`execFile()` with an argv array, never an interpolated shell command. Track the complete process tree, enforce admission limits and output/time bounds, and make stop/shutdown a staged operation (graceful request, signal, then hard kill) followed by a definitive close/reap observation. Node alone does not provide tree-wide cleanup or meaningful host isolation; on Linux, cgroup/systemd supervision is the stronger option, while containers remain the right boundary for untrusted work.

**Report path:** `docs/research/process-spawning.md`  
**Primary-source count:** 12 kept (8 web/standards sources plus 4 repository/local Pi sources; versioned below). The installed Pi package is **0.85.1** (confirmed: `pi --version`, and `version` in the installed `package.json`).  
**Three key findings:** (1) killing a Node child does not kill its descendants; (2) cgroups/systemd contain a process tree and resources, unlike per-process limits; (3) Pi runs with invoking-user permissions, so RPC launch is not a sandbox.

## Findings

1. **Claim:** Node v22.23.2 recommends asynchronous `spawn`; `exec` launches a shell and buffers output, while `execFile` launches the executable directly by default. Shell-enabled APIs must not receive unsanitized input. `timeout`, `AbortSignal`, `killSignal`, `stdio`, `cwd`, `env`, and `maxBuffer` are available, but `maxBuffer` is for buffered stdout/stderr and terminates the child when exceeded. **Sources:** [Node.js v22.23.2 child_process](https://nodejs.org/docs/latest-v22.x/api/child_process.html). **Support:** direct evidence. **Confidence:** high.

2. **Claim:** Node's `ChildProcess.kill()` targets only the child PID; Node explicitly documents that on Linux grandchildren remain alive when the parent was a shell or used `shell`. `detached` creates a new process group/session on non-Windows and, with `unref()` plus disconnected stdio, intentionally permits survival after the parent exits. **Sources:** [Node.js v22.23.2 child_process](https://nodejs.org/docs/latest-v22.x/api/child_process.html#subprocesskillsignal). **Support:** direct evidence. **Confidence:** high. **Recommendation/inference:** do not use `detached` or `unref()` for ordinary mesh-managed jobs; if a process group is used, group signaling still needs race/error handling and is not equivalent to cgroup cleanup.

3. **Claim:** POSIX termination does not directly terminate children; surviving children are reparented to an implementation-defined system process, and a child becomes a zombie until its parent obtains its status via `wait()`/`waitpid()`/`waitid()`. POSIX `kill()` supports a negative PID for a process group, subject to permissions. **Sources:** [POSIX.1-2024 `_Exit`](https://pubs.opengroup.org/onlinepubs/9799919799.2024edition/functions/_Exit.html), [POSIX `kill`](https://pubs.opengroup.org/onlinepubs/9699919799/functions/kill.html), [POSIX `setpgid`](https://pubs.opengroup.org/onlinepubs/9699919799/functions/setpgid.html). **Support:** direct evidence. **Confidence:** high. **Recommendation/inference:** always observe Node's `close` (not only `exit`) and retain a supervisor record until stdio is closed; PID-only identity is unsafe after PID reuse.

4. **Claim:** `stdio` pipes have finite capacity; a child that writes without the parent consuming output can block. Node's `close` fires after stdio closes and follows `exit`/spawn `error`; `error` and `exit` can both occur, so handlers must be idempotent. **Sources:** [Node.js v22.23.2 child_process](https://nodejs.org/docs/latest-v22.x/api/child_process.html#event-close), [Node.js v22.23.2 child_process](https://nodejs.org/docs/latest-v22.x/api/child_process.html#optionsstdio). **Support:** direct evidence. **Confidence:** high. **Recommendation/inference:** continuously drain stdout/stderr with bounded accounting or redirect to a bounded sink; cap inbound RPC size and rate to prevent memory/backpressure DoS.

5. **Claim:** Pi RPC is JSONL over stdin/stdout, launched as `pi --mode rpc [options]`; commands and events share the same stream. Local Pi docs specify LF as the record delimiter (CRLF may be accepted after stripping CR) and warn that generic Node `readline` is non-compliant because it splits on U+2028/U+2029, which are valid inside JSON strings. Pi documents `--no-session` and `--session-dir`. **Source:** installed Pi docs, `@earendil-works/pi-coding-agent` **0.85.1** `rpc.md` and `json.md`. **Support:** direct evidence. **Confidence:** high. **Recommendation/inference:** implement a byte/line parser honoring LF framing and a maximum record size; keep RPC stdout protocol-only and route diagnostics to stderr.

6. **Claim:** Pi's RPC protocol includes asynchronous events, including agent lifecycle/tool events, so a caller must correlate command responses/events and handle EOF, malformed records, and child termination. Pi documentation recommends using `AgentSession` directly for Node integrations when a subprocess boundary is unnecessary. **Sources:** installed Pi docs `rpc.md`, `extensions.md` (local; version unverified). **Support:** direct evidence plus interpretation. **Confidence:** medium. **Recommendation/inference:** use subprocess RPC only when an isolation/lifecycle boundary is required; otherwise direct integration avoids pipe framing and child supervision complexity.

7. **Claim:** Pi security documentation says it runs with the invoking user's permissions; project trust is not a sandbox. Containerization documentation describes Gondolin, Docker, OpenShell, and Docker Sandboxes; extensions can route tools, but host-side extensions remain host-side. **Sources:** installed Pi docs `security.md` and `containerization.md` (local; version unverified). **Support:** direct evidence. **Confidence:** high. **Recommendation/inference:** do not describe `pi --mode rpc` as containment. Spawned Pi inherits the host-user authority unless an external sandbox/container/service policy changes it.

8. **Claim:** Pi's documented environment includes process markers (`AI_AGENT=pi`, `PI_CODING_AGENT=true`) and session-related `PI_*` variables. The repository security constraint requires the swarm key not be inherited by spawned children. **Sources:** installed Pi docs `environment-variables.md` (local; version unverified); repository `docs/SECURITY.md` and `docs/adr/0007-per-request-hmac.md`. **Support:** direct evidence. **Confidence:** high. **Recommendation/inference:** construct a minimal explicit environment and remove swarm credentials, mesh listener credentials, and unrelated secrets; never pass the parent environment wholesale.

9. **Claim:** systemd resource-control v256 places service processes in cgroups and provides service-wide controls including `CPUQuota`, `MemoryHigh`/`MemoryMax`, `TasksMax`, I/O controls, and IP accounting/filtering. `MemoryHigh` is the primary throttling mechanism and `MemoryMax` the last line of defense; `TasksMax` maps to `pids.max`. **Source:** [systemd.resource-control v256](https://freedesktop.org/software/systemd/man/latest/systemd.resource-control.html) (page identifies systemd 256). **Support:** direct evidence. **Confidence:** high. **Recommendation/inference:** prefer a preconfigured user service/scope or equivalent cgroup supervisor where available; fail closed if required containment cannot be applied, rather than pretending Node options are equivalent.

10. **Claim:** systemd's `KillMode=control-group` is the relevant tree-wide kill mode, and `systemd.exec` documents `User`/`DynamicUser`, `NoNewPrivileges`, `ProtectHome`, `ProtectSystem`, `PrivateTmp`, `PrivateDevices`, `PrivateNetwork`, `RestrictAddressFamilies`, `RestrictNamespaces`, and syscall filtering. `LimitNPROC` is UID-wide and per-process limits can be escaped by forking; systemd says `TasksMax` is typically better. **Sources:** [systemd.kill](https://freedesktop.org/software/systemd/man/latest/systemd.kill.html), [systemd.exec](https://freedesktop.org/software/systemd/man/latest/systemd.exec.html). **Support:** direct evidence. **Confidence:** high. **Recommendation/inference:** use least-privilege user + `NoNewPrivileges` and filesystem/network restrictions as policy permits; do not rely on `LimitNPROC` or `LimitRSS` alone.

11. **Claim:** Linux cgroup v2 organizes processes hierarchically and exposes resource controllers; `pids.max`, `memory.max`, and `cpu.max` are group-level controls. Linux `PR_SET_PDEATHSIG` can deliver a parent-death signal but has fork/exec and credential caveats and is Linux-specific. **Sources:** [Linux kernel cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html), [Linux `PR_SET_PDEATHSIG`](https://www.man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html). **Support:** direct evidence. **Confidence:** high. **Recommendation/inference:** treat parent-death signal as a defense-in-depth fallback, not the primary orphan guarantee; cgroup membership is stronger for descendants.

12. **Claim:** MCP stdio and LSP lifecycle prior art both use a launched subprocess with explicit protocol framing and orderly shutdown; they do not by themselves provide resource isolation. **Sources:** [MCP stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) (spec URL is future-dated and therefore **stale/unverifiable as a current normative version**); [LSP specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/). **Support:** direct evidence for protocol/lifecycle patterns; inference for applicability. **Confidence:** medium. **Recommendation/inference:** model Pi job control on explicit startup/readiness, request correlation, graceful shutdown, timeout, and restart/backoff, but keep security containment outside the protocol.

## Concrete recommendations

- **Launch:** allow a policy-approved executable/argument vector only; use `spawn`/`execFile` with `shell:false` and an explicit `cwd` constrained to an approved workspace. Reject arbitrary shell strings and unrestricted `cwd`.
- **Environment:** explicit allow-list; remove swarm key, HMAC secrets, credential paths, and unrelated `PI_*`/provider secrets unless individually required.
- **RPC:** dedicate stdout to Pi JSONL; parse LF records without U+2028/U+2029 splitting; cap line/record bytes; drain stderr separately; bound pending requests and event queues; enforce readiness and idle/overall deadlines.
- **Supervision:** maintain one authoritative job record keyed by mesh job ID plus PID/start metadata; use idempotent stop; send graceful Pi shutdown first, then SIGTERM, wait a bounded grace period, then SIGKILL. Observe `close` and record exit code/signal. Never infer termination from `kill()` returning true.
- **Tree/orphans:** do not detach. Prefer a cgroup/systemd scope/service with `KillMode=control-group`, `TasksMax`, `MemoryHigh`/`MemoryMax`, CPU quota, I/O and network policy. If unavailable, process groups and parent-death signaling are only partial fallbacks and must be clearly reported as such.
- **Abuse/DoS:** authenticate every control request (repository ADR 0007), authorize process operations by explicit local policy, rate-limit starts/stops, cap concurrent jobs and per-peer quota, bound output/storage, enforce wall-clock/idle timeouts, and avoid automatic unbounded restart loops. A LAN HMAC proves request authenticity, not that a trusted peer's requested workload is safe.
- **Isolation:** default to host-user permission only with an explicit warning; offer container/service sandbox profiles for untrusted jobs. Pi project trust, RPC mode, `cwd`, and `--no-session` do not constitute a sandbox.
- **Platform scope:** repository policy is POSIX-oriented. Treat systemd/cgroups as Linux capability detection, not a universal requirement; document weaker macOS behavior and do not claim equivalent containment.

## Contradictions
- Node's `detached` documentation says a detached process can outlive its parent, while common supervision goals require cleanup. This is not a source contradiction: it is an intentional option whose behavior is unsuitable for managed mesh jobs.
- systemd's current “latest” page is v256 while another search result reports v257 for the directives index. Version-sensitive recommendations above cite the exact v256 resource-control and exec pages; availability on a host must be detected.
- MCP search surfaced a future-dated 2026-07-28 specification URL. It is retained only as protocol prior art and not used for a current-version claim.

## Missing evidence
- ~~The installed Pi documentation did not expose a package/version identifier.~~ **Resolved:** the installed Pi is **0.85.1** (`pi --version` and the installed `package.json` agree). The Pi RPC and security claims above are therefore pinned to 0.85.1 rather than unversioned. Whether those details are stable across releases remains unverified.
- No primary source establishes a portable Node API for cgroup assignment or POSIX resource limits; Node's documented `uid`/`gid` and timeout/output controls are not a substitute for OS-level containment.
- macOS-specific descendant-kill/container behavior and Windows Job Object behavior were not researched because repository policy is POSIX-only.
- No benchmark evidence was found for Pi RPC throughput, startup latency, or resource overhead; choose limits by policy and measure in milestone testing.

## Sources

### Kept
- Node.js v22.23.2 `child_process` (https://nodejs.org/docs/latest-v22.x/api/child_process.html) — authoritative runtime API and lifecycle/security caveats.
- POSIX.1-2024 `_Exit` (https://pubs.opengroup.org/onlinepubs/9799919799.2024edition/functions/_Exit.html) — orphaning, zombie, reparenting semantics.
- POSIX `kill` (https://pubs.opengroup.org/onlinepubs/9699919799/functions/kill.html) — process-group signaling and permissions.
- POSIX `setpgid` (https://pubs.opengroup.org/onlinepubs/9699919799/functions/setpgid.html) — process-group formation constraints.
- systemd.resource-control v256 (https://freedesktop.org/software/systemd/man/latest/systemd.resource-control.html) — cgroup resource containment.
- systemd.kill v256 (https://freedesktop.org/software/systemd/man/latest/systemd.kill.html) — group kill policy.
- systemd.exec v256 (https://freedesktop.org/software/systemd/man/latest/systemd.exec.html) — sandbox, identity, limits, environment.
- Linux kernel cgroup v2 (https://docs.kernel.org/admin-guide/cgroup-v2.html) — controller semantics.
- Linux `PR_SET_PDEATHSIG` (https://www.man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html) — parent-death fallback caveats.
- Installed Pi `rpc.md`, `json.md`, `security.md`, `containerization.md`, `environment-variables.md`, `extensions.md` — directly relevant Pi behavior; version unverified.
- Repository `docs/SECURITY.md`, `docs/adr/0007-per-request-hmac.md`, `AGENTS.md` — project constraints and trust model.

### Rejected/deprioritized
- Node v26 child-process page — redundant after verifying the v22.23.2 page.
- Generic SEO/blog process-manager articles — no primary authority and no need after Node/POSIX/systemd sources.
- MCP 2026-07-28 page as normative current evidence — future-dated; retained only for clearly flagged prior art.

## macOS: no parent-death signal (gap in the brief, closed here)

The brief asked specifically why macOS has no `PR_SET_PDEATHSIG` equivalent.
`PR_SET_PDEATHSIG` is an operation of Linux's `prctl(2)`; macOS has no `prctl`
system call, so there is no kernel mechanism to ask "signal me when my parent
dies". The man page cited above is in the Linux man-pages project for that
reason. **Inference (not source-verified):** this leaves macOS with only
user-space cleanup, so the portable guarantee is *the supervisor cleans up*,
not *the kernel enforces cleanup*.

Consequences for pi-mesh:

- On macOS, if the agent is `SIGKILL`ed there is nothing to run the cleanup
  handler, and a spawned `pi` can survive it. A process-group kill on shutdown
  covers the ordinary case; the hard-kill case cannot be fully closed.
- This is a **POSIX-relevant gap, not a Windows-only one**: both development
  machines are macOS and Linux, so "POSIX-only" does not mean "uniform".
- Therefore any claim that a spawned `pi` "can never outlive the agent" is
  true on Linux via cgroup/`KillMode=control-group` and best-effort on macOS.
  The difference MUST be documented rather than smoothed over.

## Parent verification

Independently re-checked against the same primary sources, because a
subagent's summary is a claim about intent, not evidence:

- Killing a child does not kill its descendants - **verified**, from Node's own
  `child_process` text ("On Linux, child processes of child processes will not
  be terminated when attempting to kill their parent").
- `close` follows `exit` and stdio closure, and `error` and `exit` may both
  fire - **verified**, Node `child_process` ("always emit after `exit` was
  already emitted, or `error`"; pipes "have limited ... capacity", and an
  unread pipe blocks the child).
- `detached` forms a new process group/session and can outlive the parent -
  **verified**, Node `options.detached`.
- Pi RPC framing is LF-only and Node `readline` is non-compliant due to
  U+2028/U+2029 - **verified** by reading the installed 0.85.1 `rpc.md`
  directly.
- Pi is not a sandbox and runs with the invoking user's authority - **verified**
  from the installed 0.85.1 `security.md` ("No Built-in Sandbox"; project trust
  "is not a sandbox and it does not restrict what the model can ask tools to
  do").

Not re-verified here: the systemd, cgroup v2 and POSIX cites. They are quoted
with exact versioned URLs and none of them is load-bearing for the *policy*
decision, which turns on the Pi-is-not-a-sandbox and
-kill-does-not-kill-the-tree findings above.

## Next steps
1. Confirm the installed Pi package version and pin the report's Pi RPC/security claims to that version.
2. Decide the supported Linux supervisor path (systemd scope/service versus direct cgroup API) and test behavior when unavailable.
3. Add milestone tests for record-size/output limits, staged stop, orphan-descendant behavior, and admission/rate limits.

## Acceptance report
```acceptance-report
{
  "criteriaSatisfied": [
    {"id":"criterion-1","status":"satisfied","evidence":"Produced the requested research artifact only; no implementation files changed."},
    {"id":"criterion-2","status":"satisfied","evidence":"Report includes primary-source citations, direct-vs-inference labels, version caveats, concrete recommendations, contradictions, and missing evidence."}
  ],
  "changedFiles":["/Users/vid/.pi/agent/sessions/--Users-vid-development-repos-pi-mesh--/subagent-artifacts/outputs/4cc969ac-32ce-4f47-ab84-f1cf170dc7a7/research.md"],
  "testsAddedOrUpdated":[],
  "commandsRun":[],
  "validationOutput":["Artifact written at authoritative path; repository implementation files were not modified."],
  "residualRisks":["Installed Pi package version remains unverified; macOS/Windows containment was out of scope."],
  "noStagedFiles":true,
  "diffSummary":"Research-only artifact; no repository diff.",
  "reviewFindings":["no blockers"],
  "manualNotes":"Primary-source count is 12, including repository/local Pi primary materials. MCP future-dated source is explicitly caveated."
}
```