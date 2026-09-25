# Deployment

What runs where, and what keeps it running. The agent is the only required
component; the control plane is optional and the mesh works with it absent
(ADR 0011). Nothing here needs outbound internet.

There is no npm release yet, so the agent runs from a checkout (see
[Publishing](#publishing-m3-3)). `docs/SECURITY.md` is the threat model; this
document is the operational side of it.

## Agent

### Run it from a checkout

```sh
git clone https://github.com/tadelv/pi-mesh && cd pi-mesh
pnpm install && pnpm -r build
```

On each device, generate a swarm key, copy it to the other members out of band,
and start:

```sh
node packages/agent/dist/cli.js keygen > ~/.pi-mesh/swarm.key
chmod 600 ~/.pi-mesh/swarm.key
node packages/agent/dist/cli.js start
```

Use the absolute path to `packages/agent/dist/cli.js` in any unit file below.
`start` runs in the foreground and shuts down on `SIGINT`/`SIGTERM`, which is
what a service manager wants.

Execution is **off by default**. Enable it deliberately with
`--allow-execution` (any member) or `--allow-execution=<peer-id,…>` (a local
convenience list), or the lower-precedence `PI_MESH_ALLOW_SPAWN` for a service
manager. `PI_MESH_WORKSPACE` defaults to the user's home directory.

### systemd (Linux)

`/etc/systemd/system/pi-mesh-agent.service`:

```ini
[Unit]
Description=pi-mesh agent
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
User=pi
WorkingDirectory=/home/pi
# Execution is opt-in. Prefer the flag over the environment, and note that the
# peer-id list is a convenience, not a boundary (docs/SECURITY.md).
ExecStart=/usr/bin/node /home/pi/pi-mesh/packages/agent/dist/cli.js start
Restart=on-failure

# Signal the whole cgroup, not just the main process. This is the load-bearing
# line in this unit; see the measurement below.
KillMode=control-group
# Let the agent run its own graceful stop (which sweeps its process groups)
# before the cgroup sweep.
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

**Why `KillMode=control-group`.** Pi's bash tool calls `setsid()` for each command
it runs, so a tool's process tree is in **its own session** and no process-group
signal the agent can send will reach it. Measured on the Pi: after a hard kill of
a spawned session, a `sleep 300` started by its bash tool survived with `ppid 1`,
reparented to init, in a session no group sweep can address. A graceful
`process.stop` cleans up completely (Pi kills its own tool children), so this only
matters when the **agent** is killed outright. `KillMode=control-group` makes
systemd signal every process in the unit's cgroup, which is inclusive regardless
of `setsid`; a cgroup or a systemd scope is the only mechanism that is, because
parentage is gone by the time you look for the children.

This is not a reason to `kill -9` the agent by hand. Killing it outside systemd
still leaks the tool commands, because the sweep is systemd's.

### macOS (launchd)

A `LaunchAgent` is enough for a user-session agent. There is no cgroup
equivalent, so a hard kill of the agent leaves tool commands behind exactly as on
Linux; keep the process supervised rather than killing it outright.

`~/Library/LaunchAgents/net.tadel.pi-mesh-agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>net.tadel.pi-mesh-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/vid/development/repos/pi-mesh/packages/agent/dist/cli.js</string>
    <string>start</string>
    <!-- The explicit control id, NOT a bare --allow-execution: bare means "*"
         (any paired control plane). See ADR 0013 decision 3. -->
    <string>--allow-execution=4903a35d-815f-4a2c-9eaf-f5af5593e394</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/vid/development/repos/pi-mesh</string>
  <!-- Load-bearing. launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin, which has
       neither node nor pi. With --allow-execution a missing `pi` is a startup
       FAILURE, not a degraded mode: resolvePiBinary() runs before the listener,
       so the agent exits rather than refusing execution at request time. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/vid/.pi-mesh/agent.log</string>
  <key>StandardErrorPath</key><string>/Users/vid/.pi-mesh/agent.err.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/net.tadel.pi-mesh-agent.plist  # load and start
launchctl kickstart -k gui/$UID/net.tadel.pi-mesh-agent                           # restart
launchctl bootout gui/$UID/net.tadel.pi-mesh-agent                                # stop
```

`kickstart -k` is what makes a rebuild take effect: the file on disk is the code,
and the process is restarted onto it.

### Manually, without a supervisor

`start` runs in the foreground and shuts down on `SIGINT`/`SIGTERM`, and it writes
no pidfile - so nothing can find it for you, which is why there is no `stop`
command. The supervised paths above are the supported way; a pidfile would be a
second source of truth that can outlive the process it names. When you run it by
hand anyway:

```sh
pgrep -f 'agent/dist/cli[.]js start'        # find it
kill <pid>                                  # SIGTERM: stops mDNS and the listener
cd ~/development/repos/pi-mesh
nohup node packages/agent/dist/cli.js start \
  --allow-execution=4903a35d-815f-4a2c-9eaf-f5af5593e394 \
  > ~/.pi-mesh/agent.log 2>&1 &
```

Two traps, both observed while doing exactly this:

- **`--allow-execution` with no value means `*`** - any paired control plane, not
the one this machine is paired with. Pass the id. A bare flag looks harmless and
widens the grant to every control plane that has ever completed a pairing.
- **`pgrep -f` matches your own shell** when your command line contains the
pattern, which it does precisely while you are starting the agent, because the
start command *is* the pattern. It reports two pids; check with `ps` before
killing. The `[.]` above stops `pkill` from matching the pattern's own text, not
from matching a real command containing `cli.js start`.

### Windows

Not supported. The swarm-key permission model relies on POSIX file modes, which
Windows reports synthetically.

## The workspace root is an accident guard, not isolation

`PI_MESH_WORKSPACE` (default `$HOME`) bounds where a peer may ask a session to
start. The check is a `realpath` containment test: it rejects accidental `..` and
symlinks that resolve outside the root. It is **not a sandbox**. A spawned Pi
runs with the agent user's full permissions, and the model can leave that
directory at will. Real isolation means a container or a systemd scope, which is
out of scope here. Do not describe the workspace root as a security boundary.

## Control plane (optional)

The control plane is a dashboard, a SQLite cache and token pairing. It reaches
each agent over the agent's normal listener with a credential it earned by
pairing, and it does not hold the swarm key.

### docker compose

`examples/docker-compose.yml` builds and runs it. Two things about the stack
matter:

- **mDNS.** The control plane advertises `_pi-mesh-control._tcp` so an agent can
  find it for pairing. On Linux, run the container with `network_mode: host` so
  the advertisement reaches the LAN and `PI_MESH_PORT` binds the host; with the
  default bridge network the advertisement stays inside the container's network,
  and agents must pair with `--control-host <host>:7331` instead.
- **The data volume.** `PI_MESH_DB` holds the control id, the dashboard token,
  the per-agent credentials, session cache and mirrored jobs. Losing it loses the
  pairings (re-pair to recover) and rotates the dashboard token. Job freshness is
  intentionally in memory, so a restart displays the retained rows as cached
  until the next successful sync. Back it up:
  `/var/lib/pi-mesh` in the compose file.

`docker compose -f examples/docker-compose.yml up -d`, then read the dashboard
URL and the pairing token from the logs (`docker logs pi-mesh-control-plane`).
The URL carries no dashboard token; read that separately, because it is not
written to the log unless you ask for it:

```sh
docker exec pi-mesh-control-plane node packages/control-plane/dist/cli.js token
```

### Portainer

Create a stack from the same compose file (the build context is the repository
root). If the stack host has no build access to the source, build the image on
the host first (`docker compose build`) or through Portainer's Docker API proxy,
then reference `pi-mesh/control-plane:dev` as the stack's image and redeploy so
the recreated container picks up the new tag.

### Pairing

`serve` prints a dashboard URL and a one-time pairing token. The URL does not
carry the dashboard token (ADR 0014); get that with:

```sh
node packages/control-plane/dist/cli.js token
```

and paste it into the dashboard once. It is kept in the browser and sent as a
header, never in a URL.

On each device:

```sh
node packages/agent/dist/cli.js pair <pairing-token>
```

The agent discovers the control plane over mDNS; on a network that blocks
multicast, add `--control-host <host>:7331`. The pairing token is single-use,
expires after ten minutes, and is never transmitted; both sides prove knowledge
of it and derive a per-agent credential (ADR 0011). Pairing writes
`~/.pi-mesh/control-credentials.json` on the agent, mode `0600`.

### Enabling execution

Pairing grants reading, not execution (ADR 0008). To let the dashboard start, resume or
steer on a machine, restart its agent with the control plane's **id** in the allow
list:

```sh
node packages/agent/dist/cli.js start --allow-execution=<control-id>
```

The dashboard shows that id on every agent that cannot execute yet, with a copy
button, because it is the only thing the operator needs. It is two steps - pair,
 then enable - on purpose: pairing authenticates the control plane, and
authorising execution is a separate local decision. Stopping and aborting need no
opt-in.

A machine that has not opted in still appears in the dashboard and still refuses
with `-32102`, so a refusal is a normal state to display rather than a failure to
hide.

### Execution requires a confidential connection

A second, separate condition applies to the operator's side (ADR 0014). The five
control routes (start, resume, steer, stop and abort) are served only to a request that arrived over TLS or from
loopback, because the dashboard token is otherwise a reusable credential
crossing a plaintext LAN - and a browser on an insecure origin cannot sign its
requests, so there is no way to make that credential non-replayable. A refused
request is `403 confidential_transport_required` and never reaches an agent.

Two ways to satisfy it, in order of preference:

1. **Terminate TLS in front of it, on this host.** A reverse proxy on the same
   machine works with no configuration, because the proxy then dials the control
   plane over loopback.
2. **`--allow-insecure-execution`** (or `PI_MESH_ALLOW_INSECURE_EXECUTION=1`) on a
   LAN you trust. Off by default; it warns at startup. In the compose file or a
   Portainer stack this is an environment variable on the service.

What does **not** satisfy it, and this trips people up:

- **A VPN on its own.** The check reads the socket, and a tunnel endpoint is a
  non-loopback address like any other LAN caller, so execution is still refused.
- **A reverse proxy on another host.** TLS is terminated there, but the hop into
  this process is plaintext and non-loopback, and this process cannot tell that
  apart from an attacker. Trusting an `X-Forwarded-Proto` header instead would be
  spoofable by exactly the attacker the check exists to stop. If TLS terminates
  elsewhere, run the proxy here, or use option 2 on a trusted network.

Reading - the session list, session content, the pairing button - is unaffected
and keeps working over plaintext. Only execution needs the confidential channel.

### Backups and revoking

The only persistent control-plane state is the SQLite database at `PI_MESH_DB`.
Back up that one file (with the container stopped, or via `sqlite3 .backup`)
and you have the pairings and cache.

To revoke an agent: remove its row from the control plane (or delete the
database and re-pair) **and** delete its entry from
`~/.pi-mesh/control-credentials.json` on the agent. There is no revocation UI in
this revision, and removing only one side leaves a credential that still
verifies.

### Exposing it beyond the LAN

A dashboard token is the only authentication on `/api/*`, and the listener is
plaintext HTTP. Do not port-forward it to the internet. Reach it over a VPN, or
put an authenticating reverse proxy in front of it - which, per the section
above, is also what makes dashboard execution possible. A VPN alone is enough
for *reading* and not for execution: see the note above.

## Publishing (M3-3)

`@pi-mesh/agent` is deliberately **not published**, and `README.md` says so. The
three packages a release needs — `@pi-mesh/protocol`, `@pi-mesh/shared`,
`@pi-mesh/agent` — are all `private: true`, and the agent depends on the other
two, so publishing one without the others produces an install that cannot
resolve. A release therefore requires:

1. npm scope access for `@pi-mesh` and a version scheme (the packages are
   `0.0.0`).
2. Publishing all three in dependency order (`shared`, `protocol`, `agent`),
   with `publishConfig`/`files` reviewed and `private` removed or overridden.
3. A decision that pre-alpha code is ready to be public.

That is a release decision with external consequences, so it was **not** taken as
a side effect of another change (M3-3). Until then, the checkout install above is
the only supported path.
