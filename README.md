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

> **Not yet released.** `@pi-mesh/agent` is `private` in this repository and is
> not published to npm, so the commands below describe the intended install
> once a release exists. Until then, run it from a checkout:
>
> ```sh
> git clone https://github.com/tadelv/pi-mesh && cd pi-mesh
> pnpm install && pnpm -r build
> node packages/agent/dist/cli.js doctor
> ```

On each device that runs Pi:

    npm install -g @pi-mesh/agent
    pi-mesh-agent keygen > ~/.pi-mesh/swarm.key
    chmod 600 ~/.pi-mesh/swarm.key
    pi-mesh-agent start

Peers are found over mDNS. On a network that blocks multicast — corporate
Wi-Fi, guest networks, most cloud VMs — dial one directly instead:

    pi-mesh-agent sessions --peer-host other-box:7330

The peer's identity is learned from the authenticated handshake, so the direct
path is exactly as trustworthy as discovery and works with no multicast at
all. See [docs/SECURITY.md](docs/SECURITY.md).

### Status of the control plane

The `packages/control-plane` package currently does discovery only: it
publishes a service record and has no dashboard, no database and no pairing
flow yet. Those are milestone 3. `docker compose -f

examples/docker-compose.yml up -d` starts the placeholder, and there is
nothing to open at `http://localhost:7331` — it does not serve HTTP yet.

The agent alone (read, stream, and gated execution of sessions over the mesh)
is complete for what it claims.

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
(review-gated) executing Pi sessions across machines; milestone 1 is complete
and verified across two hosts, and milestone 2 adds controlled execution. The
**control plane** is a discovery placeholder with no UI, database or pairing
yet. See [tasks/milestone-2.md](tasks/milestone-2.md) for the current scope.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
