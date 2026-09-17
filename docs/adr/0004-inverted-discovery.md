# ADR 0004 — Inverted discovery

## Context

In a hub-and-spoke design, agents advertise and the control plane
browses. In a mesh design, all peers advertise. But advertising from a
laptop on a hostile network leaks presence and capabilities.

## Decision

Invert discovery for agents: they advertise `_pi-mesh._tcp` **only**
when a swarm key is present **and** the profile is `lan`. Otherwise
they browse-only.

## Consequences

- A laptop in a coffee shop publishes nothing unless explicitly told to.
- Public-profile agents cannot be discovered by the mesh; they must
  find peers proactively.
- The swarm key doubles as an advertisement gate.
