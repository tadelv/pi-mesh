# pi-mesh

A self-hosted mesh network for Pi coding agents across your local network.

Peers discover each other over mDNS, exchange work directly via the
[A2A protocol](https://a2a-protocol.org), and can be observed and steered
from an optional web control plane — no cloud, no central server required.

## Why

Running Pi on multiple devices (workstation, laptop, Raspberry Pis) means
losing visibility into what each instance is doing. pi-mesh gives you:

- **Peer discovery** — find other Pi instances on your LAN automatically.
- **Direct handoff** — agents pass tasks and context to each other.
- **Fleet overview** — a web dashboard for sessions, projects and the jobs the
  agents are actually running.
- **Steering** — prompt the selected session when its agent confirms a running job and has opted in; an accepted request is checked against a new transcript turn, whose origin cannot be proven.
- **Process control** — start and stop Pi sessions on remote devices.

## Install

**There is no npm release yet.** `@pi-mesh/agent` is `private: true` and is not
published, and it depends on two other unpublished workspace packages
(`@pi-mesh/protocol`, `@pi-mesh/shared`), so `npm install -g @pi-mesh/agent` does
not work today. Run it from a checkout on each device that runs Pi, and alias
the built CLI so the rest of this document reads normally:

```sh
git clone https://github.com/tadelv/pi-mesh && cd pi-mesh
pnpm install && pnpm -r build
alias pi-mesh-agent="node $PWD/packages/agent/dist/cli.js"
pi-mesh-agent doctor
```

Then, on each device:

    pi-mesh-agent keygen > ~/.pi-mesh/swarm.key
    chmod 600 ~/.pi-mesh/swarm.key
    pi-mesh-agent start

Starting keeps remote execution disabled. To deliberately grant execution to
all swarm members, use:

    pi-mesh-agent start --allow-execution

Use `--allow-execution=<peer-id,peer-id>` for a local convenience restriction,
or set `PI_MESH_ALLOW_SPAWN` as the lower-precedence systemd/service fallback.
`PI_MESH_WORKSPACE` is optional; it defaults to the user's home directory and
only guards against accidental outside paths.

Peers are found over mDNS. On a network that blocks multicast — corporate
Wi-Fi, guest networks, most cloud VMs — dial one directly instead:

    pi-mesh-agent sessions --peer-host other-box:7330

The peer's identity is learned from the authenticated handshake, so the direct
path is exactly as trustworthy as discovery and works with no multicast at
all. See [docs/SECURITY.md](docs/SECURITY.md).

### The control plane

`packages/control-plane` now serves a dashboard (ADR 0011). Run it on the
machine that should hold the fleet view:

    node packages/control-plane/dist/cli.js serve

It prints a dashboard URL and a one-time pairing token. The URL carries no
dashboard token (ADR 0014) - read that with
`node packages/control-plane/dist/cli.js token` and paste it into the page once.
On each device you want it to see:

    pi-mesh-agent pair <pairing-token>

The agent pairs once, stores its credential, and from then on the dashboard can
list that device's sessions and cache them for offline viewing. Jobs are mirrored
from each agent's `process.list` during sync; the dashboard marks cached jobs as
last known whenever that agent has not synced during this control-plane process.
The control plane never holds the swarm key, and the mesh works with it absent.

`docker compose -f examples/docker-compose.yml up -d` runs the control plane and
serves the dashboard on `http://localhost:7331`; `docker logs` prints the URL and
the pairing token. The dashboard token is deliberately not printed or put in the
URL - read it with `node packages/control-plane/dist/cli.js token` and paste it
into the page. No control-plane feature needs outbound internet.

## Security model

- Agents only advertise on the LAN when a **swarm key** is present.
- Peer connections are authenticated with an HMAC challenge-response
  derived from the swarm key.
- The control plane uses token-based pairing for UI access.
- No mDNS record is published without a swarm key — safe on untrusted nets.

See [docs/SECURITY.md](docs/SECURITY.md).

## Packages

| Package | Purpose |
|---|---|
| `@pi-mesh/protocol` | Shared types, agent card schema, A2A message definitions |
| `@pi-mesh/agent` | The CLI daemon that runs on each device |
| `@pi-mesh/control-plane` | Web dashboard, registry, session cache |
| `@pi-mesh/shared` | Logging, error types, small utilities |

## Status

Pre-alpha. The **agent** is a working LAN mesh for reading, streaming and
(review-gated) executing Pi sessions across machines. The **control plane**
serves a dashboard that pairs with agents, caches sessions and mirrors agent jobs in SQLite, and can
start, steer, stop and abort sessions on agents that have opted in; it depends
on no agent to start. Milestone 4 is
implemented and verified across three machines (a Portainer-managed control
plane on one host, agents on two others). The clause still unproven on hardware
is the offline cache against a device that goes away, which is exercised
in-process only. See [tasks/milestone-4.md](tasks/milestone-4.md) and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Someday

Things the documents describe or the ADRs decided, but that the code does not
do. Listed so a design is not read as a capability.

- **`public` network profile** — a laptop on a hostile network (coffee shop,
  hotel, conference) participating without advertising or accepting inbound,
  finding peers through a trusted control plane (ADR 0004). Not implemented:
  `start --profile public` refuses. It needs an authenticated
  agent→control-plane directory lookup (today the credential only flows
  control→agent) and an outbound-only `start`, about a day of work. Deferred
  because the hostile-network case still requires the control plane to be
  reachable from that network, and this project's real deployments are three
owned machines on one trusted LAN.
- **GitHub PR overview** — the dashboard shows sessions and projects, not pull
  requests. There is no GitHub client, credential model, sync path or API field
  for PRs anywhere in the repository, so the README no longer advertises them
  (issue #4). Adding it means an optional integration with a defined offline
  behaviour, its own state shape and its own tests - not a dashboard tweak.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
