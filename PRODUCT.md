# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Operators pairing and monitoring their Pi Mesh agents. This dashboard's operator manages sessions, jobs, and agent controls from a browser. (Audience description inferred from the supplied feature brief.)

## Product Purpose

Pi Mesh is a peer-to-peer mesh for Pi coding agents. The optional control plane gives an operator a dashboard and an SQLite cache for paired agents, sessions, and mirrored jobs; the mesh remains usable without it.

## Capabilities and Constraints

The dashboard uses a pasted localStorage token sent in `X-Pi-Mesh-Ui`; it never puts the token in a URL. Session logs are cached in full for offline viewing, while session detail responses are bounded by the control plane. Paging a long session still reads the whole session from its agent before serving the cached page, so a page request costs the full transfer even though its response is bounded; if the agent is unreachable the cached page is served with `stale` set. Starting and steering remain gated by each agent's advertised controls and local execution opt-in. The selected-session prompt requires a confirmed jobs listing and a verifiable transcript; several running jobs claiming one session require an explicit choice and confirmation. An accepted steer is re-read for up to 15 seconds: a matching new user turn is observed, not attributed to this request, and a missing turn is unconfirmed. The Start form suggests previously seen projects for that agent, permits free text, requires inline confirmation, and shows the returned job/session/PID or the refusal. The dashboard is vanilla DOM with no external resources or build step. The model and command surface follows the same rule: the Start form can name an exact model from the agent's own catalog, a running session's model can be changed, the selected session shows the model and context window Pi reports, and the prompt box offers the commands Pi reports as advisory completion (never a promise that a command will run). A session that belongs to exactly one confirmed running job also opens a live view in the dashboard: live frames stream into a labelled live tail, a dedicated region announces entry boundaries only, and any close (`not-live`, `error` or `end`) states the reason, removes the live tail and falls back to the durable page without claiming the deltas it missed.

## Brand Commitments

For the dashboard, follow the Pi session-transcript visual language: monospace-first text, light and dark themes, transcript entries by type, and tool output collapsed by default.

## Evidence on Hand

Live agent data, SQLite-cached sessions and jobs, and the existing token-pairing flow. No customer, benchmark, or commercial claims supplied.

## Product Principles

- Mesh operation does not depend on the control plane.
- Pi remains the source of truth for session state.
- Cached session history stays available when an agent is offline.
- Dashboard execution controls never bypass the agent's own gate.
