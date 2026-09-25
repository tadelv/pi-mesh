# Two-machine proof (M1 exit criteria, and M2-9)

Transcripted evidence from actual machines, not from a fixture. The original
M1 run below was performed by hand on 2026-09-22 and pasted verbatim. Later
sections cover subsequent milestones and quote bounded excerpts of recorded
requests and responses; they are not verbatim full logs.

- **A** — macOS, `en0` `192.168.12.100`
- **B** — Raspberry Pi, `devpi.local` = `192.168.12.108`, aarch64, Raspberry Pi OS
  (Debian 13 trixie), `node v22.23.2`, `pnpm 12.4.2`, Pi `0.85.1` at
  `/home/vid/.local/share/pi-node/node-v22.23.2-linux-arm64/bin/pi`

Both hosts trust the same swarm key (`sha256 c8424311617d0e85…`, mode 0600) and
the repo on B is at the same commit as A.

**This proof is INCOMPLETE, and the gap is named at the end.** The DoD clause
that cannot be satisfied yet is reading the *spawned* session's entries, and the
reason is a product gap rather than a test failure.

## Discovery (A sees B over real mDNS)

```
$ pi-mesh-agent peers
[{"id":"bf55e82f-8ac9-4dd9-8b4b-65282a3d0bab","name":"devpi",...,
  "host":"192.168.12.108","port":7330,
  "txt":{..."caps":"mesh.peers,session.list,session.read,session.stream,process.stop,session.abort,process.spawn,session.steer"}}]
```

The `caps` TXT record above is the value B actually published to DNS-SD with the
gate open — captured from the wire, not from the function that builds it.

## Gate OPEN on B

Advertised set agrees on both surfaces, and includes the gated pair:

```
$ curl -s http://127.0.0.1:7330/.well-known/agent-card.json   # on B
skills: mesh.peers,process.spawn,process.stop,session.abort,session.list,session.read,session.steer,session.stream
```

Process table before anything is spawned — the baseline the DoD asks for:

```
pi procs: 0
```

## Spawn across machines

```
$ pi-mesh-agent call process.spawn '{"project":"m2-9-demo"}' --peer-host 192.168.12.108:7330
{"job_id":"cfe35c56-e12b-4594-9b6f-595c64942aab","pid":18805,"session_id":"01a0c7e9-9106-739f-b994-2c4e85adf967"}
```

The child really is running, in **its own process group** (ADR 0008 decision 11 —
`PGID` equals `PID`, and `PPID` is the agent). Note that `ps args` shows only
`pi`: Pi sets its process *title*, so grepping a spawned Pi's argv finds nothing.

```
    PID    PPID    PGID STAT ELAPSED COMMAND
  18805   18713   18805 Ssl        8 pi
```

## The gap: a spawned session cannot be made to do work

`session.steer` is accepted by Pi — but the session is idle, so nothing happens:

```
$ pi-mesh-agent call session.steer '{"job_id":"cfe35c56…","message":"Reply with exactly: M2-9 STEERING RECEIVED"}' --peer-host 192.168.12.108:7330
{"id":"pi-mesh-2","type":"response","command":"steer","success":true}

# 30 seconds later, on B:
$ find /home/vid -name '*01a0c7e9*'          # nothing
$ find /home/vid -name '*.jsonl' -mmin -10   # nothing
    PID    PPID    PGID STAT ELAPSED WCHAN
  18805   18713   18805 Ssl       60 do_epoll_wait   # alive, idle, blocked on stdin
$ ls -l /proc/18805/fd | grep -c jsonl
0                                                 # holds no session file
```

So: **`process.spawn` starts Pi with no prompt, and `session.steer` only affects
a turn that is already running.** The mesh therefore has no way to make a
spawned session produce a turn, so a spawned session never gets a session file,
so `session.read` on the returned `session_id` has nothing to read. The M2-5 DoD
clause ("the `session_id` returned is accepted by file-backed `session.read` …
once the session has produced a turn") and the M2-7 DoD clause ("a steered
session receives the message") are both **unverifiable against real Pi** in this
state. M2-7 was verified with a stub, which is how this survived to the
two-machine proof.

## Abort, stop, reaping

```
$ pi-mesh-agent call session.abort '{"job_id":"cfe35c56…"}' --peer-host … 
{"id":"pi-mesh-3","type":"response","command":"abort","success":true}

$ pi-mesh-agent call process.stop '{"job_id":"cfe35c56…"}' --peer-host …
{"job_id":"cfe35c56-e12b-4594-9b6f-595c64942aab","state":"exited","pid":18805}

$ ps -eo args | grep -cE '^pi$'      # on B, AFTER the stop
0

$ pi-mesh-agent call process.stop '{"job_id":"cfe35c56…"}' --peer-host …   # again
{"job_id":"cfe35c56-e12b-4594-9b6f-595c64942aab","state":"exited","pid":18805}   # idempotent

$ pi-mesh-agent call process.stop '{"job_id":"11111111-1111-4111-8111-111111111111"}' --peer-host …
Application error (-32103): Unknown job: 11111111-1111-4111-8111-111111111111
```

## Gate CLOSED on B

Both surfaces drop the gated pair and keep the ungated set — the "advertise
nothing" degenerate solution is excluded on real hardware:

```
caps:      mesh.peers,session.list,session.read,session.stream,process.stop,session.abort
card:      mesh.peers,process.stop,session.abort,session.list,session.read,session.stream
```

Refusals, and the read path still working (neither starts anything):

```
$ call process.spawn '{"project":"m2-9-demo"}' --peer-host …
Application error (-32102): Execution is disabled on this machine (start with --allow-execution or set PI_MESH_ALLOW_SPAWN for a service manager): process.spawn

$ call session.steer '{"job_id":"x","message":"y"}' --peer-host …
Application error (-32102): Execution is disabled on this machine (start with --allow-execution or set PI_MESH_ALLOW_SPAWN for a service manager): session.steer

$ call mesh.handoff '{}' --peer-host …
Application error (-32004): Skill is not supported: mesh.handoff

$ call session.list '{}' --peer-host …
{"sessions":[{"id":"01a0152b-c893-7c81-96da-23bcef772941","project":"/home/vid",...}]}

$ ps -eo args | grep -cE '^pi$'      # on B, after every refusal attempt
0
```

`process.spawn` answered **`-32004`** here before `fb5c338`, while `session.steer`
answered `-32102` — the same machine, the same moment, two different answers for
the same condition. That was a real defect against the M2 exit criteria, found
only because this proof ran against real hardware, and it is fixed.

## Environment notes that cost time

- `ssh devpi` does **not** resolve; `devpi.local` and the IP do. Neither `dns-sd`
  nor the SSH config supplies a search domain for the bare name.
- Resolving `devpi.local` takes **5012 ms** on host A — an mDNS timeout, not a
  failure — which exceeds the client's handshake timeout. `--peer-host
  devpi.local:7330` therefore fails with "unreachable" while
  `--peer-host 192.168.12.108:7330` works. Prefer the address the peer
  advertised; that is exactly what `connectHost()` prefers, and dialling by
  hostname is the one path that bypasses it.
- Both machines' login shells are `fish`, so remote commands go through
  `ssh … bash -s`.

## M3-1 - `mesh.handoff`, Mac to devpi (2026-09-22)

Command from the Mac, to the Pi over the LAN:

    call mesh.handoff '{"task":"In this repository, run git log --oneline -3 and
    report the three commit subjects, then on a new line write DONE",
    "project":"pi-mesh","context":{"ticket":"M3-1","note":"handoff from the Mac"},
    "preferred_agent":null,"deadline_ms":60000}' --peer-host 192.168.12.108:7330

The response is an A2A task in `TASK_STATE_WORKING` whose status message carries
the three handles at `status.message.parts[0].data.result`:

    task_id    6e287705-bb3e-4309-a135-13433fe38d30
    session_id 01a0caab-4e89-7788-a8c7-c53eec8ae724
    job_id     7b235bb6-274a-4f97-ba37-32a101532440

`stream <session_id> --follow` then showed the peer doing the work. Its report is
verifiable rather than merely plausible, because the commits it listed are the ones
pushed from the Mac minutes earlier:

    1. `3081d31` - fix(test): T6 stopped racing the pipe that carries its own evidence
    2. `9703bb5` - feat(m3-1): mesh.handoff transfers a task, and rejection is not an error
    3. `fbeb6c5` - docs(adr-0010): pin the three response shapes the tests had to assume
    DONE

The prompt Pi actually received, read back with `session.read`:

    In this repository, run git log --oneline -3 and report the three commit
    subjects, then on a new line write DONE

    Context:
    {
      "ticket": "M3-1",
      "note": "handoff from the Mac"
    }

So the task and the context both survive the hop, under the exact heading ADR 0010
pins, on the real session rather than in a fixture.

**Rejection.** With `preferred_agent` naming another peer, the call returns a task
in `TASK_STATE_REJECTED` with no JSON-RPC error, and the `pi` process count is 0
before and after: a peer declining starts nothing.

**Denial.** An agent restarted with the gate closed advertises the six ungated
skills and drops `mesh.handoff` and `process.spawn` together, and both answer
`-32102`:

    Application error (-32102): Execution is disabled on this machine (start with
    --allow-execution or set PI_MESH_ALLOW_SPAWN for a service manager): mesh.handoff

Restarting with `--allow-execution` restores all nine skills. `process.stop` with
the returned `job_id` answers `{"state":"exited"}` and leaves 0 `pi` processes.

**Not proven on hardware:** `deadline_ms` expiry and the containment refusal for an
escaping `project`. Both are covered by tests with mutation evidence (removing the
project cwd fails the containment clause; the deadline test engineers a 10 ms
deadline against a 150 ms readiness delay), but neither has been seen on a real
machine, and this section does not claim otherwise.

## M4 - dashboard control, three machines (2026-09-23)

The control plane runs as a Portainer stack on apollo (`192.168.12.164`); the Mac
(`artemis`, `192.168.12.100`) and the Pi (`devpi`, `192.168.12.108`) are paired to
it. For this run, **devpi was started with the control plane's id explicitly** and
the Mac with no opt-in at all:

    devpi:  node packages/agent/dist/cli.js start --allow-execution=4903a35d-815f-4a2c-9eaf-f5af5593e394
    artemis: node packages/agent/dist/cli.js start

After `POST /api/sync`, `/api/state` reported each agent's advertised capability -
the public agent card, which is the one source of truth:

    artemis  process.spawn=false session.steer=false   (6 skills)
    devpi    process.spawn=true  session.steer=true    (9 skills)

Spawn through the same route the page uses:

    POST /api/agents/bf55e82f…/spawn
    {"project":"m4-proof","cwd":"pi-mesh",
     "prompt":"In this repository, run git log --oneline -1 and report the commit
               subject, then on a new line write M4-DASHBOARD-DONE"}
    -> {"ok":true,"result":{"job_id":"ea3ef197…","pid":25583,
                             "session_id":"01a0cdf7…"}}

Reading that session back through the control plane (`GET /api/sessions/…`,
`stale:false`) shows the work: the session's own assistant reported

    78adfde feat(m3-2): the control-plane vertical slice, wired to one authenticated path
    M4-DASHBOARD-DONE

`78adfde` is devpi's HEAD, so the report is verifiable rather than plausible.

Steering was accepted by the agent (`{"ok":true,…}`), and stop returned the
agent's answer:

    {"ok":true,"result":{"job_id":"ea3ef197…","state":"exited","pid":25583}}

    $ ps -eo args | grep -cE '^pi$'          # on devpi, after the stop
    0

The denial clause, on the machine that never opted in:

    POST /api/agents/3e13895e…/spawn         # artemis
    -> {"ok":false,"code":-32102,"message":"Execution is disabled on this machine
        (start with --allow-execution or set PI_MESH_ALLOW_SPAWN for a service
        manager): process.spawn"}

    $ ps -eo args | grep -cE '^pi$'          # on the Mac, before and after
    0
    0

A refusal is a **result** carrying the agent's own code, not an HTTP error, and it
started nothing. The Mac was demonstrably reachable at that moment - the same sync
returned 423 sessions from it - so the `-32102` is the gate, not a transport
failure. The cross-machine comparison is the positive control: the identical
request to devpi started a session and returned a pid; to the Mac it returned
`-32102` and no session.

The control-plane job cache held exactly the one job it started and moved it to
`exited`; the denied spawn left no row.

**Not shown here:** the spawn confirmation and the inline refusal rendering are DOM
behaviour. They were exercised by hand in a browser and are **not** covered by an
automated UI test; the milestone deliberately did not add a browser test.

## ADR 0015 — the jobs list is the agent's, not the control plane's

Verified on the same three machines after deploying the control-plane image built
from `9056cb9` and restarting both agents onto that commit.

**The advertisement split, visible in the mDNS records.** The gate-closed Mac now
advertises four skills and the opted-in Pi ten:

    artemis  caps=mesh.peers,session.list,session.read,session.stream
    devpi    caps=mesh.peers,session.list,session.read,session.stream,
                    process.list,process.stop,session.abort,
                    process.spawn,session.steer,mesh.handoff

Before this change the Mac advertised `process.stop` and `session.abort` and
answered both with `-32004 ... requires a job manager`. It no longer claims what
it cannot serve, and `/api/state` reports `controls` all false for it, so the
dashboard offers it no Stop or Abort button.

**The stale row disappeared, which is the whole point.** The control plane's cache
held one row from the M4 proof — `ea3ef197`, `exited` — long after the agent that
reported it had been restarted and no longer knew the job. One `/api/sync` later:

    before   cached rows: [('ea3ef197', 'exited')]
    after    mirrored rows: []

The agent said it had no jobs, so the mirror holds none. The dashboard had been
presenting that row as a job that existed with only a "(last known)" qualifier.

**A real job, mirrored from the agent.** Spawned through the dashboard route on
the opted-in machine, then synced:

    POST /api/agents/bf55e82f…/spawn   -> {"ok":true,"result":{"job_id":"843b54da…",
                                          "pid":26498,"session_id":"01a0cfae…"}}
    POST /api/sync
    /api/state  -> devpi jobs_synced_at: 568ms ago
                   job 843b54da state=running pid=26498 project=m5-jobs-proof

`state`, `pid` and `project` come from the agent's own `process.list` — the rows
were replaced by its answer, not written by the control plane's spawn. With
freshness set, the dashboard labels this "from the agent" and omits "(last
known)".

**Stopping it.** The job did not finish on its own (an interactive Pi session
waits), so it was stopped through the dashboard route:

    POST /api/agents/bf55e82f…/stop    -> {"ok":true,"result":{"job_id":"843b54da…",
                                          "state":"exited","pid":26498}}
    POST /api/sync
    /api/state  -> job 843b54da state=exited pid=26498

`ps` on the Pi afterwards shows no `pi` session and only the agent process, so the
job really ended rather than merely being labelled so.

**Not shown here:** the browser rendering of the freshness label. It is asserted
at source level in `packages/control-plane/test/server.test.ts` because the project had no DOM
harness **at the time of M4**. The M5 Chromium harness covers later dashboard
behaviour; the M4 hand check was that the page read "Jobs — from the agent" with
an age for devpi and "Jobs — cached, not synced from this agent" for a machine
that had never listed.

## M5 — prompting the selected session on devpi (2026-09-25)

The Mac checkout and the agent on `devpi.local` ran **`c9786e6`**. Portainer
stack **43** on `apollo.local` (endpoint 2) was rebuilt from `git archive` of
that commit and redeployed onto image
`sha256:bcd2b838c6c23742ebaa9816806e7ea3004d555599d449afc5ac203ae6792034`.
The recreated container was running on that image and retained its existing
`/var/lib/pi-mesh` volume. The dashboard answered HTTP 200; its API answered
401 without the token. CI for this commit passed
([run 36078332699](https://github.com/tadelv/pi-mesh/actions/runs/36078332699)).

**Transport limitation:** this existing stack uses
`PI_MESH_ALLOW_INSECURE_EXECUTION=1`, so the dashboard execution requests below
travelled over plaintext LAN HTTP. This is the explicit ADR 0014 exception,
**not** evidence of TLS or a confidential operator connection. The dashboard
token was sent in a header, never in a URL or this transcript.

`devpi` was restarted with the control plane's id in its explicit local opt-in:

    node packages/agent/dist/cli.js start --allow-execution=4903a35d-815f-4a2c-9eaf-f5af5593e394

After a control-plane sync, `controls.spawn` and `controls.steer` were true. The
requests below went through the **existing dashboard routes**, not a new
session-addressed execution route. The first spawn supplied an initial prompt
so this was a real, active Pi session rather than an idle process that merely
accepted a queued steer:

    POST /api/agents/bf55e82f…/spawn
    {"project":"m5-dashboard-proof","cwd":"pi-mesh",
     "prompt":"Reply with exactly M5-START-READY on one line. Do not run tools."}
    -> HTTP 200 {"ok":true,"result":{"job_id":"586fc282-f5de-4b10-9ee3-e6491f96ac1a",
       "pid":28842,"session_id":"01a0d603-7715-7172-9c59-cfa1673b6638"}}

    GET /api/sessions/bf55e82f…/01a0d603…
    -> stale:false, total:5
       message user      Reply with exactly M5-START-READY on one line. Do not run tools.
       message assistant M5-START-READY

A second sync reported `jobs_synced_at` present and exactly one **running** job
claiming that `(agent_id, session_id)`, with the returned job id. The transcript
had five entries before sending:

    POST /api/agents/bf55e82f…/steer
    {"job_id":"586fc282-f5de-4b10-9ee3-e6491f96ac1a",
     "message":"Reply with exactly M5-DASHBOARD-STEER-RECEIVED on one line. Do not run tools."}
    -> HTTP 200 {"ok":true,"result":{"type":"response","command":"prompt","success":true}}

    GET /api/sessions/bf55e82f…/01a0d603…
    -> stale:false, total:7
       c8db9e8b message user      Reply with exactly M5-DASHBOARD-STEER-RECEIVED on one line. Do not run tools.
       9e506d8f message assistant M5-DASHBOARD-STEER-RECEIVED

The new user entry **and** assistant response are real Pi session-log entries
from the second machine. The agent's accepted HTTP response alone would not
have established either. A session entry has no originating request/job id, so
an identical prompt from another writer would remain indistinguishable; the
browser truthfully labels a matching entry “origin not verified.” This run
shows the turn was acted on, not cryptographic attribution to this request.
The requests were made through the API used by the dashboard, not by clicking
a browser button; the browser ownership/confirmation UI is covered separately
by Playwright, and actual screen-reader speech has not been checked.

The job was stopped through `/api/agents/bf55e82f…/stop`, which answered
`state:"exited",pid:28842`. For the denial control, `devpi` was restarted at
the **same commit without** `--allow-execution`. A sync then reported
`controls.steer:false` and no confirmed jobs listing, so the selected-session
composer would be unavailable. A direct request to the existing steer route
was refused by the agent's execution gate, not mistaken for a transport error:

    POST /api/agents/bf55e82f…/steer  (same job id and text as above)
    -> HTTP 200 {"ok":false,"code":-32102,
       "message":"Execution is disabled on this machine … : session.steer"}
    GET /api/sessions/bf55e82f…/01a0d603… -> stale:false, total:7 (unchanged)
    devpi: ps -eo args | grep -cE '^pi$' -> 0

Because the restart cleared the agent's in-memory job table, this proves the
local execution gate refused the request **before** a job lookup; it does not
show an active gate-closed job receiving a steer. Finally, `devpi` was
restarted with the explicit control id restored. The following sync reported
`controls.steer:true`, a confirmed empty job table, and no leaked Pi process.
