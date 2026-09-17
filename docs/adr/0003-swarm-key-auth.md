# ADR 0003 — Swarm key for mesh authentication

## Context

Agents must authenticate each other on an untrusted LAN without a PKI.
Options considered: per-peer tokens, Tailscale identity, shared PSK.

## Decision

Use a shared 256-bit **swarm key**, distributed out-of-band, mode 0600
on disk. The key gates mDNS advertisement and drives an HMAC
challenge-response for peer authentication.

## Consequences

- Simple to set up: one file copied to each device.
- No central authority to run or trust.
- Revocation requires redistributing a new key to all peers.
- Traffic is not encrypted in v1; key is auth-only.
