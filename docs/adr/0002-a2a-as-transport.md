# ADR 0002 — A2A as the wire protocol

## Context

We need a message format and RPC shape for peer communication. Options
considered: custom JSON-RPC, gRPC, A2A.

## Decision

Use the [A2A protocol](https://a2a-protocol.org) as the wire format.
Extend it via declared extensions where needed (handoff, control).

## Consequences

- Agent cards, task lifecycle, and streaming come for free.
- Interop with non-Pi A2A agents becomes possible.
- Some pi-mesh-specific behaviors (inverted discovery, server push)
  require extensions documented in `docs/PROTOCOL.md`.
