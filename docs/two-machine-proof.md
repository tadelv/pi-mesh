# Two-machine proof (M1 exit criteria, and M2-9)

Transcripted evidence from the actual machines, not from a fixture. Everything
below was run by hand on 2026-09-22 and is pasted verbatim; nothing here is a
summary of a test that passed.

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
