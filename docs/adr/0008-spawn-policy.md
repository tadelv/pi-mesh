# ADR 0008 — Spawn policy: membership grants read, not execution

## Context

Milestone 1 grants every swarm member the ability to read every session on
every machine (ADR 0006 §5). Milestone 2 adds `process.spawn`,
`process.stop`, `session.steer` and `session.abort`. Those are not more of the
same capability: they **execute**.

`tasks/milestone-1.md` and ADR 0006 §2 deliberately withheld them pending "a
policy". This is that policy.

Four facts constrain it.

1. **Pi is not a sandbox.** From the installed 0.85.1 `docs/security.md`: *"Pi
   does not include a built-in sandbox. Built-in tools can read files, write
   files, edit files, and run shell commands with the permissions of the pi
   process"*, and project trust *"is not a sandbox and it does not restrict
   what the model can ask tools to do"*. A spawned Pi therefore inherits the
   full authority of the user who started the agent. `process.spawn` is not
   "start a chat elsewhere"; it is arbitrary code execution as that user.
2. **The swarm key is a file, and the weakest machine holds a copy.** The key
   lives on every member. Compromise of any one device yields the key. If the
   key alone authorised execution, compromising the least-maintained device —
   typically an always-on Raspberry Pi — would yield code execution on the
   most valuable one. The same key would carry two very different blast radii.
3. **The caller is often an agent, not a person.** An LLM with tool access
   decides to spawn things on its own initiative and can loop. A bound is
   protection from that as much as from an attacker.
4. **Spawning costs real resources.** Model tokens are billed, files are
   mutated, and a 2 GB machine can be exhausted. `session.list` cannot do any
   of that. Some of this is not a trust question at all.

The research behind this is in `docs/research/process-spawning.md`.

## Decision

1. **Swarm membership authorises reading. It does not authorise execution.**
   Both are grants against the same trust root; they are not the same grant.
   The key still proves *who* a peer is. What a machine permits is a local
   decision about that identity.
2. **Execution-increasing operations are denied by default.** `process.spawn`
   and `session.steer` are refused unless the machine has explicitly opted in.
   Refusal is `-32102`, already reserved, reported as `PI_MESH_SPAWN_DENIED`,
   before any process is started and before any filesystem work is done.
3. **The opt-in is per-machine and optionally per-peer.** `PI_MESH_ALLOW_SPAWN`
   is unset (nothing may execute), `*` (any member may), or a comma-separated
   list of peer IDs (only those). Per-peer is the same parsing cost as a
   boolean, and it is the difference between trusting your laptop and trusting
   everything on the network.

   **The peer-ID list is a convenience, not an authorisation boundary.** A
   claimed `peer_id` is a routing label rather than an authenticated identity
   (ADR 0007), and every member holds the same swarm key, so a malicious
   member can claim the ID of an allowed peer and inherit its permission. It
   narrows *which of your own agents* may execute — protection against a
   misconfigured or over-eager peer, not against an adversary. What actually
   protects the machine is the machine-wide opt-in. Making the list a real
   boundary needs per-peer keys, which v1 deliberately does not have.
4. **`session.steer` is gated with spawn, not with read.** Steering injects a
   prompt into a live session whose tools then run. It is execution by another
   name.
5. **Execution-reducing operations are never gated.** `session.abort`, and
   `process.stop` for a job the agent started, are allowed to any member even
   when spawn is denied. Stopping something can only reduce activity, and a
   safety valve that fails closed is worse than useless.
6. **`process.stop` targets the agent's own job table, never a peer-supplied
   PID.** A peer may name a mesh job ID (or a PID the agent itself started and
   still tracks). Anything else is refused. Accepting an arbitrary PID would
   hand every member the ability to signal any process on the machine,
   including the agent itself.
7. **The server constructs the argv. A peer never supplies one.** The input
   shape is `{ project, cwd? }`, not the `{ project, cwd, argv? }` sketched in
   `init.md`. Peer-chosen argv can change the provider, the session directory,
   or which extensions load, and it hands a remote caller direct control of a
   command line. The command line is ours; the project is theirs.
8. **`cwd` must resolve inside a configured workspace root.** The path is
   resolved with `realpath` (so symlinks cannot escape) and rejected unless it
   is the root or beneath it. This is the highest-risk input in the whole
   protocol: it selects what the agent may read and write.
9. **The child environment is an explicit allowlist.** The swarm key, mesh
   credentials and unrelated `PI_*` and provider secrets are **not** inherited.
   The parent environment is never passed wholesale.
10. **Capability honesty extends to the gate** (ADR 0006 §4). A machine that
    has not opted in does not advertise `process.spawn` or `session.steer` in
    its agent card or in the mDNS `caps` TXT value. Advertising a capability
    that is refused is worse than omitting it — and here the advertisement
    itself is information.
11. **Supervision is part of the grant.** Killing a child does not kill its
    descendants (documented by Node, and verified). Measured 2026-02:

    ```
    { detached: false, childAlive: false, grandchildAlive: true  }   orphan survives
    { detached: true,  childAlive: false, grandchildAlive: false }   whole group dies
    ```

    So the child is started in its **own process group** (`detached: true`, i.e.
    `setsid()`) and the GROUP is signalled, never the pid alone. Decided
    2026-02: always on, not configurable, because a per-run choice would mean the
    leak depends on which path was taken.

    The group is swept **unconditionally at the end of `close()`**, including
    after the graceful stage. That is not belt-and-braces: stdin EOF ends the
    SESSION, not its descendants, so a session that shuts down politely leaves
    its own children running - and once it is gone they cannot be found. A test
    caught exactly that gap in the first implementation, which signalled the
    group only when the session had failed to close. This amends
    this decision's earlier blanket "never `detached`", which was right about the
    danger and wrong about the remedy: a separate group is exactly what makes the
    descendants reachable, and without it they cannot be signalled at all without
    signalling the agent itself.

    The cost is real and must be stated: a child in its own session outlives a
    `SIGKILL`ed agent, and a terminal Ctrl-C no longer reaches it, because it is
    no longer in the foreground group. This is accepted because the agent's own
    shutdown path is what reaps the group - so **that wiring is load-bearing, not
    a nicety**, and a deployment that kills the agent outright will leak the
    tree. Where a cgroup or systemd scope is available it is preferred, because
    it contains the whole tree even when the agent is killed outright.

    Never `unref` (it would stop us observing the exit). Never signal a bare pid
    (decision 6). Stop is staged (graceful shutdown, then `SIGTERM`, then a
    bounded wait, then `SIGKILL`); stop is idempotent; and termination is
    observed via `close`, never inferred from `kill()` returning true.
12. **Bounded everything.** Inbound record size, retained output, concurrent
    jobs and per-peer rate are all capped; stdout is drained continuously lest
    a full pipe block the child (documented by Node, and verified).

## Consequences

- A stolen or leaked swarm key yields **read access, not code execution**,
  unless the victim machine opted in. That is the entire point.
- A partially-opted-in swarm is normal and supported: the workstation may
  allow execution while the Pi only allows reading.
- Failure is loud. A denied spawn is a clear `-32102` naming the reason; the
  alternative default (allow) fails silently and is discovered afterwards.
- **Irreducible asymmetry:** an approved peer on an opted-in machine still gets
  full user authority. This policy bounds *who* may execute and *where*, not
  *what the code does once running*. Nothing here is a sandbox; obtaining one
  means a container or a service boundary, which is out of scope for M2.
- **Not uniform across POSIX.** Linux can enforce parent-death cleanup through
  cgroups or a systemd scope. macOS has no `prctl(2)` and therefore no
  kernel-enforced parent-death signal, so a hard-killed agent can leave a
  spawned Pi behind. The guarantee is "never outlives the agent" on Linux and
  "best effort" on macOS, and must be documented as such rather than smoothed
  over - both development machines are macOS *and* Linux.
- The deny path is new state and needs its own tests: denied by default,
  denied for a non-listed peer, allowed for a listed one, and never
  half-applied (no process started, no file touched).
- **The gate is enforced once**, at the request dispatch point, and only for
  skills the agent actually serves. Both halves of that matter: one point (so
  a new execution skill cannot be added without meeting it), and only-if-served
  (so an unimplemented skill is reported as `-32004 UnsupportedOperation`
  rather than `-32102`, which would claim the agent can do a thing it cannot).
  `EXECUTION_SKILLS` in `skills.ts` is read by the gate, so the list cannot
  drift from the check. Two residual obligations follow from that shape:
  a skill that executes must be **registered** (a transport-owned skill is the
  exception that proves it: `session.stream` registers a throwing placeholder
  so it is not silently absent from the registered set - not because the gate
  applies to it, since it does not execute, but because the guard's correctness
  rests on every dispatched skill being present in the registry).
  `SkillRegistry.register` refuses execution skills outright and
  `registerExecution` refuses non-execution ones, so both directions of the
  drift are a startup error rather than a silent hole.
- **`tasks/get` and `tasks/cancel` are a second, non-skill dispatch path.** They
  reach task state without naming a skill, so the gate does not cover them, and
  ADR 0008 should say so rather than let "enforced once" imply more than it
  does. Today that is safe: the methods only mutate an in-memory record, and the
  only task that exists is created by `session.stream`. If `tasks/cancel` ever
  becomes the cancellation path for a spawned job, that is a deliberate ungated
  stop - consistent with decision 5, and worth stating when it happens.
- `mesh.handoff` will need the same treatment when it lands, since it starts
  work on a peer's behalf; it is deliberately not decided here.

## Amendment — environment, workspace, and gate sources

## Amendment — what "the child's process group" does and does not contain

Decision 11 says every child runs in its own process group, the GROUP is
signalled, and that this "is what makes a session's own descendants reachable at
all". That is true of Pi's own children and **false of its tool commands**.

Measured on devpi (Linux, Pi 0.85.1): a spawned session is its own group
(`pgid == pid`), but a command started by the session's bash tool calls
`setsid()` and lands in its own group *and* its own session:

```
  23089   20230   23089   23089 pi          <- the session we signal
  23181   23169   23181   23181 sleep 300   <- the tool's command, escaped
```

Consequences, both measured:

- **Graceful stop is complete.** `process.stop` ends with 0 survivors, because Pi
  kills its own tool children while shutting down. The group signal reaches Pi,
  and Pi does the rest.
- **A hard kill is not.** After `kill -9` on the session the command survives as
  an orphan reparented to init, in a session nothing we send can reach. Our
  stage-3 `SIGKILL` escalation therefore leaks work: on a 2 GB Pi, one
  `pnpm -r test` left behind is the resource-exhaustion risk this milestone
  already names.

The fix is not a wider signal - there is no POSIX signal that reaches a process
which `setsid()`ed away. It is a **cgroup or a systemd scope with
`KillMode=control-group`**, which is inclusive regardless of session. That was
already the answer earmarked for macOS; it is now required on Linux too, and M3's
`DEPLOYMENT.md` must carry it as the deployment lever rather than a nicety.

This does not change the implementation: signalling the group is still the best
graft available from the parent side, and it is what makes the graceful path
work. It changes the CLAIM. "Never outlives the agent" is true only for a
graceful stop; a hard-killed agent leaves work behind on both platforms, and the
guarantee belongs to the supervisor (scope/cgroup), not to this process.


The original decisions above deliberately chose an environment allowlist, a
required workspace root, and an environment-only execution gate. They are
amended as follows:

- The child environment is now **inherit-except-mesh**: it inherits the parent
  environment except for every variable whose name starts with `PI_MESH_`.
  The allowlist made a spawned session behave unlike a locally launched one
  (`SSH_AUTH_SOCK`, toolchain variables, proxies) without providing security:
  a spawned Pi can read the same files from the filesystem with its own tools,
  and Pi is not a sandbox. An environment filter that a shell command walks
  around is not a boundary.
- `PI_MESH_WORKSPACE` is now optional and defaults to the user's home directory.
  The realpath containment check remains unchanged, including its refusal of
  `..` escapes and symlinks resolving outside the root. Its role is an
  accident guard and project selector, not a security boundary: a spawned Pi
  can leave that directory at will.
- The gate is now **flag-first**. `start --allow-execution` permits any member,
  while `start --allow-execution=<peer-id,peer-id>` permits only the listed
  peers. `PI_MESH_ALLOW_SPAWN` remains a lower-precedence fallback for service
  managers such as systemd. The flag wins when both are present; parsing and
  fail-closed validation remain those of `parseSpawnPolicy`.

This reversal is deliberate. The relaxed controls did not bind: the
allowlist was not a sandbox, the workspace was not a sandbox, and a hidden
environment variable made granting execution less explicit than the act
warrants. The symmetric-mesh argument still justifies the swarm key and
per-request HMAC as the door, and an explicit execution opt-in remains a
separate act from installing an agent. The accepted cost is that a spawned
session now inherits credentials and tooling from its parent environment, and
that workspace containment guards against accidents only. Real isolation
requires a systemd scope or a container; that is deferred to M3.
