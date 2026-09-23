# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Operators pairing and monitoring their Pi Mesh agents. This dashboard's operator manages sessions, jobs, and agent controls from a browser. (Audience description inferred from the supplied feature brief.)

## Product Purpose

Pi Mesh is a peer-to-peer mesh for Pi coding agents. The optional control plane gives an operator a dashboard and an SQLite cache for paired agents, sessions, and mirrored jobs; the mesh remains usable without it.

## Capabilities and Constraints

The dashboard uses a pasted localStorage token sent in `X-Pi-Mesh-Ui`; it never puts the token in a URL. Session logs are cached in full for offline viewing, while session detail responses are bounded by the control plane. Paging a long session still reads the whole session from its agent before serving the cached page, so a page request costs the full transfer even though its response is bounded; if the agent is unreachable the cached page is served with `stale` set. Starting and steering remain gated by each agent's advertised controls. The dashboard is vanilla DOM with no external resources or build step.

## Brand Commitments

For the dashboard, follow the Pi session-transcript visual language: monospace-first text, light and dark themes, transcript entries by type, and tool output collapsed by default.

## Evidence on Hand

Live agent data, SQLite-cached sessions and jobs, and the existing token-pairing flow. No customer, benchmark, or commercial claims supplied.

## Product Principles

- Mesh operation does not depend on the control plane.
- Pi remains the source of truth for session state.
- Cached session history stays available when an agent is offline.
- Dashboard execution controls never bypass the agent's own gate.
