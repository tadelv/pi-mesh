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

On each device that runs Pi:

    npm install -g @pi-mesh/agent
    (umask 077 && pi-mesh-agent keygen > ~/.pi-mesh/swarm.key)
    pi-mesh-agent start

Deploy the control plane (optional but recommended):

    docker compose -f examples/docker-compose.yml up -d

Open http://localhost:7331 and pair your agents with a token.

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

Pre-alpha. See [tasks/milestone-0.md](tasks/milestone-0.md) for the
current scope.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
