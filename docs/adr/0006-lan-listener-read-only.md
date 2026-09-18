# ADR 0006 — One LAN listener, read-only skill exposure

## Context

Two documents described the agent's HTTP listener in ways that cannot both be
true of one socket:

- `docs/ARCHITECTURE.md` says each agent runs an HTTP server on a port
  "assigned dynamically, advertised via mDNS TXT" — that is a port peers are
  expected to reach.
- `AGENTS.md` says the local A2A server "runs on localhost" and needs no
  authentication because it "is only reachable in-process".

A loopback-only socket is not reachable by LAN peers, so these describe
different listeners. There was also no decision about what a swarm peer is
actually allowed to invoke. That gap mattered: `process.spawn` accepts `cwd`
and `argv`, Pi runs with host permissions by default, and `PI_MESH_SPAWN_DENIED`
existed as an error code with no policy behind it. "Any swarm member may spawn
arbitrary processes on this machine" is a far larger grant than any document
discussed.

## Decision

1. **One listener, LAN-facing.** It binds the LAN interface on a configurable
   port (`PI_MESH_PORT`, default 7330) and advertises that port via mDNS TXT.
   Two routes are reachable unauthenticated: the handshake (`POST /handshake`,
   `POST /handshake/verify`) and the agent card
   (`GET /.well-known/agent-card.json`). Every other route requires a verified
   request (ADR 0007). The card has to be public, because a peer cannot sign a
   request for an agent whose identity and transport it has not yet discovered.
2. **Read-only exposure in M1.** The listener serves `mesh.peers`,
   `session.list`, `session.read` and `session.stream`. `process.spawn`,
   `process.stop`, `session.steer` and `session.abort` are **not served at
   all** until milestone 2, where they gain a policy, a loopback listener and
   a UI consumer.
3. **No loopback listener in M1.** Nothing in M1 consumes one: the CLI runs
   in-process and can call functions directly. It arrives in M2 with the
   dashboard, which is the first real consumer.
4. **Capability honesty.** The agent card and the mDNS `caps` TXT value
   advertise only skills that are implemented *and* served on that listener.
   Advertising a capability that is refused is worse than omitting it.
5. **Swarm membership grants session read access.** That is the deliberate
   consequence of 2, and `docs/SECURITY.md` states it plainly.
6. **`fp` is removed** from the advertised TXT records until it has
   verification semantics. M0 shipped a constant `"unpaired"`, which looks
   like data and verifies nothing.

Where behaviour and documentation disagreed, this ADR corrects the
documentation:

- "Only reachable in-process" is false and is replaced by "bound to
  loopback". Any local process can reach a loopback port; that is the
  enforceable property, and it is the one to assert.
- "Assigned dynamically" is replaced by a configurable port with a default.
  A port that changes on restart adds a failure mode with no benefit, since
  the advertised TXT record is the actual discovery mechanism.

## Consequences

- Agents on a LAN are readable by every swarm member. This follows from the
  shared-key model in ADR 0003 rather than being a new exposure, but it is now
  written down instead of being discovered.
- The unauthenticated surface is exactly two routes, and both are disclosures
  rather than controls: the handshake issues nothing, and the card reveals the
  agent's name (the hostname, unless `PI_MESH_NAME` says otherwise), version
  and skill list to any host on the LAN. There is no second listener whose
  authentication story has to be reasoned about.
- M2 inherits the loopback listener *and* the obligation to define a spawn
  policy before exposing process control. That is the right order: the policy
  is the hard part, not the socket.
- Deferring control skills also removes CI's need for a real Pi binary and a
  model provider in M1, which would otherwise sit awkwardly against the
  no-cloud-dependency constraint in `AGENTS.md`.
