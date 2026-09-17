# ADR 0001 — Mesh topology over hub-and-spoke

## Context

The control plane could either mediate all agent communication (hub-and-
spoke) or allow agents to talk directly (mesh). Mediated communication
simplifies auth and observation but adds a hop and makes the control
plane a hard dependency.

## Decision

Adopt a mesh topology. Every agent is a peer. The control plane is a
peer with extra skills (UI, persistence, aggregation).

## Consequences

- Agents must discover each other without a broker. mDNS is used.
- Session state is eventually consistent across the mesh.
- The control plane can be offline without breaking the mesh.
- Gossip and shared memory become natural future extensions.
