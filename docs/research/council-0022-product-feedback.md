# Council memo - operator product feedback (R1-R5)

**Run:** workflow `650da6a4` (mission 1097500f). Brief:
`docs/research/council-0022-product-feedback-brief.md`.
**Passes:** Pass 1 only (2 reports). Pass 2 (cross-exam) held until the owner
answers Q1-Q4, because the challenge packet needs those decisions.
**Roster:** `council-codex` (fresh, full structured report) and
`council-grok-a` (fresh, **degenerate output**: a single sentence, no evidence
table). `council-grok-b` failed at launch - `opencode-go/grok-4.6` is not in the
model registry (only `grok-4.7` is). This is a **degraded 2-advisor pass**, one of
them unquotable.

## Claims checked by the parent (not taken on trust)

| Claim | Verdict | Evidence |
| --- | --- | --- |
| "Dark mode already follows the OS" (both advisors) | **true** | `dashboard.html:7` `<meta name="color-scheme" content="light dark">`, `dashboard.html:37` `@media (prefers-color-scheme: dark)` |
| "The session list is a non-deleting cache" (grok-a) | **true, and it is a defect** | `db.ts:182-201` `listSessions`/`upsertSessions`; no `DELETE FROM sessions` anywhere (`db.ts:96,178,238,252` prune only `jobs`); unpair drops the agent row and leaves its sessions |
| "Neither intercom nor a node push can honestly do what was asked" (both) | accepted | intercom is a per-machine local IPC broker for Pi sessions that loaded the extension (`pi-intercom` README v0.18.1); it is same-machine only and has no delivery proof for steering. ADR 0004 (inverted discovery) + ADR 0007 (per-request HMAC) leave no authenticated agent→control-plane push surface today |

## Recommendation (codex, with the parent's corrections)

Ship **R1 and R5 now**; **verify, do not implement, R3**; make **R2's no-sync
button** an automatic reconciler inside M8-7 and defer **true push** to a
post-M8 ADR; defer **R4** to a post-M8 ADR. Keep SQLite: changing refresh
delivery does not make the mirror authoritative, it only removes the manual
click.

The node "observer" belongs in the **existing agent**, not a second Pi process:
the agent already holds the credential, the skills and the lifecycle. A separate
vetoing process would be a second principal, which ADR 0021 forbids.

## Per request

### R1 Setup (phobos) - ship now, no new mechanism
`packages/agent/src/cli.ts:240-303`, `packages/agent/src/pair.ts:42-117`,
`docs/DEPLOYMENT.md:88-138`. Install, deliver the swarm key, launchd supervision,
pair against `apollo.local:7331`, verify session reads, then decide the
execution grant separately (ADR 0013 two grants; ADR 0014 confidentiality for a
non-loopback dashboard). Add nothing: no Portainer integration, no new route,
no new principal. Session read is a read (ADR 0007 signs it, no grant needed);
execution is the separate opt-in.
**Trap:** a peer id in `~/.pi-mesh/credentials.json` with no swarm key starts
nothing - which is exactly phobos's current state.

### R2 Push instead of sync - split into two things
- **Ship in M8-7:** extract the `/api/sync` body (`server.ts:422-535`) into a
  reconciler - bounded concurrency, single-flight, backoff, refresh without
  losing the selected session or a draft in the composer
  (`dashboard.html:1716-1730`), freshness surfaced per agent. The button goes
  away. **This is what "the sync button should not be required" means.** It is
  polling, and it is honest: a node's files cannot tell you what is *running*.
- **Defer:** a true push stream (agent → control plane subscription) needs an
  authenticated subscription on the existing listener (ADR 0007), a definition
  of loss/reconciliation, and an ADR 0004 answer for *which* control plane an
  agent may call back. Today discovery is inverted on purpose; the agent
  advertising only when a swarm key exists is what keeps a mesh-first topology.
- **Cost trap:** `session.list` reparses transcripts
  (`packages/agent/src/sessions.ts:261-315`). Poll every 30-60s, not every 5s,
  and measure with three agents before shortening.

### R3 Dark mode - verify first, then at most an override
Already shipped for the OS preference. If it looks light in the browser, the
deployed Portainer image predates it, or the OS is in light mode. Check the
deployed tag before writing CSS. If an explicit System/Light/Dark control is
wanted, it is `dashboard.html:6-60` and `dashboard.ts:5-17`, no backend.

### R4 Intercom - refuse as a steering transport, keep it as a local convenience
Intercom reaches **Pi sessions on the same machine that have the extension
loaded**, through a per-machine broker. The control plane cannot speak it from
apollo, and a send is not proof of a steered turn. Steering a session the mesh
owns already works, gated, over A2A (`session.steer`, ADR 0013); a transcript the
mesh only *discovered* is not a supported root (M8-2).
**Trap:** an observer that auto-spawns on its own is a second execution path
around ADR 0008's one gate, and a broker identity must not become a principal
(ADR 0021). Honest version, if it is ever built: a node-side adapter that maps a
deliberate intercom request onto the **same** gated dispatch, refuses sessions
without an inbox, and reports the recipient's outcome - a post-M8 ADR, three
grants deep.

### R5 Session list - ship now, and fix the real bug
Two changes, one file plus a small one:
1. `dashboard.html:376-403`: group by **full project path** (the key), display
   the **basename**, `<details>` collapsible, children show the session name or
   its age plus a short id. Keep UUID addressing for the click, keep search over
   the full path, drop the per-agent header repetition inside a path group.
2. `db.ts`: prune sessions the agent no longer lists, and delete a peer's
   sessions on unpair. Without this the list keeps growing UUIDs forever; the
   advisor's "non-deleting cache" is why it reads as soup, not just formatting.
**Trap:** basename collisions (two `pi-mesh` checkouts) - group on the full path
and show the basename, never the reverse.

## Order

R1 (unblocks everything, needs the owner) -> R5 + fix (hours) -> R3 verify
(minutes) -> M8-6 -> M8-7 with the reconciler -> M8-8, M8-9, M8-10. R2-push and
R4 become ADRs 0022/0023, written after M8-10.

## Cut nothing

The one scoping question the council raised is M8-9 (findings across the
fleet): if time is fixed, rescope its *auto-actions* explicitly rather than
silently dropping the read-only coverage or the M8-10 three-machine transcript.

## Owner decisions still open

1. R2 shape: polling reconciler (cheap, honest) or a real push subscription
   (new authenticated surface, needs an ADR)?
2. R4 reach: relay through the node's observer, or replace `session.steer` - and
   is the observer ever allowed to spawn on its own, or propose only?
3. phobos: execution rights or read-only?
4. Order: UI before M8-6, as recommended?

## Confidence

Medium. Two advisors, one of them unquotable; the code-level claims were
re-verified by the parent and two advisor assertions were wrong-adjacent (dark
mode exists; the mirror's staleness is a real defect, not a display nit).
Pass 2 will settle: whether the mirror needs pruning semantics vs full deletion,
and whether an intercom adapter can ever be non-destructive.
