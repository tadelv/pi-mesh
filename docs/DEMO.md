# Verifying pi-mesh discovery

`tasks/milestone-0.md` calls for two-device mDNS discovery to be *verified*.
It does not call for a recorded terminal session: an asciinema/GIF cannot be
re-run, cannot be reviewed, goes stale the moment CLI output changes, and the
run that produced it was too short to reach the TTL window where a
peer-registry defect was hiding. The durable artifact is the procedure.

Run this on two machines on the same LAN. It takes about two minutes and is
the only check that exercises real mDNS rather than a fake in a unit test.

## Prerequisites

- Two POSIX machines on the same L2 network (same subnet, no client isolation).
- git and Node.js >= 22 on both. Nothing else; `corepack` supplies pnpm.

## 1. Install on both machines

`@pi-mesh/agent` is `private: true` and unpublished, so the `npm install -g`
in the README does not work yet. Clone and build instead:

```sh
git clone https://github.com/tadelv/pi-mesh.git
cd pi-mesh
corepack enable
pnpm install --frozen-lockfile
pnpm -r build

node packages/agent/dist/cli.js help   # sanity: prints usage
```

## 2. Share one swarm key

Agents advertise **only** when a swarm key is loaded (ADR 0004), so a
one-sided setup shows nothing. Generate once, then copy the key out-of-band —
the mesh itself is not the transport for it.

On machine A:

```sh
mkdir -p ~/.pi-mesh
(umask 077 && node packages/agent/dist/cli.js keygen > ~/.pi-mesh/swarm.key)
scp ~/.pi-mesh/swarm.key B:~/.pi-mesh/swarm.key
```

On machine B:

```sh
chmod 600 ~/.pi-mesh/swarm.key     # scp may not preserve the mode
stat -f '%Lp' ~/.pi-mesh/swarm.key # macOS: expect 600
stat -c '%a'  ~/.pi-mesh/swarm.key # Linux: expect 600
```

The `umask 077` matters: a bare `>` creates the file `0644`, and the loader
refuses anything with group or other access. That refusal is the feature
working, not a bug:

```
Swarm key at /home/you/.pi-mesh/swarm.key has insecure permissions: mode 0644, expected 0600
```

## 3. Start an agent on each machine

Machine A:

```sh
PI_MESH_NAME=agent-a node packages/agent/dist/cli.js start
```

Machine B:

```sh
PI_MESH_NAME=agent-b node packages/agent/dist/cli.js start
```

`start` advertises this agent and prints each newly discovered peer as one
JSON line. Leave both running.

Prefer distinct `PI_MESH_NAME` values: the default is the hostname, and two
machines can share one.

## 4. Verify discovery

On machine A, in a second terminal:

```sh
node packages/agent/dist/cli.js peers --timeout 6
```

Expect both agents within 5 seconds, `agent-a` (self) and `agent-b`:

```json
[{"id":"phobos.local","name":"agent-a","serviceType":"mesh","host":"phobos.local","port":7330,
  "txt":{"id":"phobos.local","name":"agent-a","version":"0.0.0","agent_version":"0.0.0",
  "port":"7330","fp":"unpaired"},"lastSeen":1789659594836},
 {"id":"artemis","name":"agent-b","serviceType":"mesh","host":"artemis","port":7330,
  "txt":{"id":"artemis","name":"agent-b","version":"0.0.0","agent_version":"0.0.0",
  "port":"7330","fp":"unpaired"},"lastSeen":1789659594876}]
```

`peers` exits 0 and writes JSON to stdout only; the logger writes to stderr,
so `peers | jq` works.

## 5. Verify an authenticated cross-machine call and stream

This step needs a real Pi session on machine B. The agent does not start Pi in
milestone 1, so create or continue a session with the Pi install on B and let
it append at least one event while the commands below are running.

On machine B, list sessions and copy the `id` of a session that is active:

```sh
node packages/agent/dist/cli.js sessions | jq .sessions
```

On machine A, use B's mDNS `id` from step 4 (not its display name):

```sh
PEER_B=artemis
node packages/agent/dist/cli.js sessions --peer "$PEER_B" | jq .sessions
node packages/agent/dist/cli.js call "$PEER_B" session.read \
  '{"id":"SESSION_ID_FROM_MACHINE_B"}' | jq .entries
```

The second command is an authenticated A2A call: its result must contain the
session summary and entries belonging to machine B, not A. To observe a live
event, start the stream on A, then send a message in the selected Pi session
on B:

```sh
node packages/agent/dist/cli.js stream SESSION_ID_FROM_MACHINE_B \
  --peer "$PEER_B" > stream.sse
# send a message in the live Pi session on machine B, then press Ctrl-C on A
cat stream.sse | jq -R 'select(startswith("data: ")) | sub("^data: "; "") | fromjson'
```

The stream is authenticated and emits SSE `data:` records on stdout only;
Ctrl-C ends the client cleanly. The runbook can prove discovery, handshake,
remote session data, and a live event only when two machines share a LAN and
machine B has a real Pi session. It cannot prove those network or Pi
conditions from one machine.

## 6. Verify TTL pruning

```sh
node packages/agent/dist/cli.js peers --watch
```

It reprints the registry every 5s. Now stop `agent-b` — ideally with `SIGKILL`
(`kill -9`) so no mDNS goodbye packet is sent and the record genuinely has to
age out:

- it disappears from the list within the 30s TTL
- `agent-a` stays, because a live peer keeps refreshing its own entry

That asymmetry is the point of this step. A responder does not re-announce an
unchanged record, so a peer that is merely *quiet between announcements* must
not be pruned; only one that stops answering the periodic re-query should be.
An earlier implementation pruned on `lastSeen` alone and dropped live peers at
30s.

## When discovery fails

An empty registry on both machines means mDNS is not reaching them, not that
the code is broken — see the "mDNS blocked" row in `docs/ARCHITECTURE.md`.
Confirm with a tool that does not involve pi-mesh:

```sh
dns-sd -B _pi-mesh._tcp         # macOS; expect an Add line per agent
avahi-browse -rt _pi-mesh._tcp  # Linux
```

That separates "mDNS is not arriving" from "our browser is broken". Usual
causes, in order:

1. The machines are on different VLANs or subnets.
2. Guest or corporate Wi-Fi client isolation.
3. A VPN capturing or dropping multicast.

Note that `dns-sd` buffers its output when stdout is not a terminal, so when
redirecting to a file, wrap it in `script -q /dev/null` or it will look empty.
