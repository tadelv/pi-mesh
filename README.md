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
- **Fleet overview** — a web dashboard for sessions, projects, and PRs.
- **Steering** — attach to any session from the dashboard and redirect it.
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

It prints a dashboard URL (with its access token) and a one-time pairing token.
On each device you want it to see:

    pi-mesh-agent pair <pairing-token>

The agent pairs once, stores its credential, and from then on the dashboard can
list that device's sessions and cache them for offline viewing. The control
plane never holds the swarm key, and the mesh works with it absent.

`docker compose -f examples/docker-compose.yml up -d` runs the control plane and
serves the dashboard on `http://localhost:7331`; `docker logs` prints the URL and
token. The dashboard's command bar can route plain-language requests to
dashboard actions using TypeSafe's Jev — an **optional** integration, enabled
only when `TYPESAFE_API_KEY` is set (ADR 0012). With it unset the command bar is
hidden and no request leaves the machine.

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
serves a dashboard with token pairing, an SQLite session cache and an optional
Jev command bar, and depends on no agent to start. Milestone 3 is complete and
was verified across three machines (a Portainer-managed control plane on one
host, agents on two others); the one clause still unproven on hardware is the
offline cache against a device that goes away, which is exercised in-process
only. See [tasks/milestone-3.md](tasks/milestone-3.md) and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
