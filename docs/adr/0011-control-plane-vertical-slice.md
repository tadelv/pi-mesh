# ADR 0011 — The control-plane vertical slice: pair, cache, render

Status: accepted

## Context

M3-2 asks for **one** end-to-end path rather than three layers built side by
side: dashboard, SQLite and pairing arriving together, with the loopback
listener arriving as the first real consumer of ADR 0006 decision 3. Nothing
about the shape was frozen, and this ADR is that freeze.

The constraint that bites is in `AGENTS.md`: the mesh must keep working with
the control plane absent (constraint 1), and nothing may depend on outbound
internet (constraint 4). So the slice is an *addition*, never a dependency: an
agent that has never seen a control plane behaves exactly as it does today.

Two documents disagree about what the control plane is, and this ADR has to
choose:

- `ARCHITECTURE.md`: "The control plane connects to agents the same way any
  peer does — there is no privileged channel."
- `SECURITY.md`: "The control plane does not share the swarm key. It pairs with
  each agent separately."

Both can hold if the *channel* is the ordinary authenticated A2A listener and
the *principal* is a paired credential rather than the swarm key. That is the
decision below. It is also what M3-2's loopback-listener sentence is actually
about: the dashboard is the first consumer that is a separate process on a
separate socket path, so the agent's listener gains its second authenticated
principal here.

## Decision

### 1. One listener, two authenticated principals

The agent's existing LAN listener is unchanged on the wire. A request's proof
(ADR 0007) already names the signer in `X-Pi-Mesh-Peer` and covers the
recipient, nonce, timestamp and body hash. What changes is which key the server
verifies with:

- the **swarm key**, as today, for a mesh peer; or
- a **paired control credential**, for a control plane that has completed
  pairing.

The agent selects the key by the claimed signer id: if `X-Pi-Mesh-Peer` names a
stored control plane, that control plane's credential is the **only** key tried.
There is no fallback to the swarm key. Falling back would let any swarm member
claim a control plane's id and be authenticated by the swarm key under an
identity that is supposed to be credential-bound; the mesh grants that member no
extra authority today, but the binding is the point and it is free to keep.

This is the one place where a pi-mesh principal is authenticated rather than
merely claimed. ADR 0007 is explicit that a swarm peer's id is a routing label;
a paired control plane's id is not, because the credential is per control plane
and is the proof. `SECURITY.md` should say so.

### 2. No second listener: ADR 0006 decision 3 is superseded

ADR 0006 deferred a loopback listener to "M2 with the dashboard". This ADR does
**not** add one, and records why, because M3-2 named it:

- The LAN listener already answers on loopback. A separate socket bound to
  127.0.0.1 gives a local dashboard nothing the existing socket lacks.
- A second bind means a second lifecycle, a second set of bounded state
  (replay cache, pending handshakes) or a shared one that must be reasoned
  about, and a second place for the two-route unauthenticated surface. The
  gain is zero and the surface is larger.
- The dashboard is not reliably co-located. The control plane is a separate
  package that may run on another host, and the credential path is the same
  either way; special-casing localhost would test a path production does not
  use.

The enforceable property ADR 0006 was protecting — a local control surface must
still be authenticated — is kept: the control credential authenticates every
control-plane request whether it arrived over loopback or the LAN. What is
dropped is the second socket, not the authentication.

### 3. Pairing: a token-authorised HMAC exchange, token never on the wire

The control plane mints a single-use pairing token (32 random bytes, base64,
10-minute TTL, bounded pending table). The user runs it on the target device:

    pi-mesh-agent pair <token> [--control-host host:port]

The agent resolves the control plane (mDNS `_pi-mesh-control._tcp`, or the
explicit host) and performs two POSTs:

1. `POST /pair/hello` with `{ agent_id, agent_name, token_id, nonce }`. `token_id` is a
   non-secret SHA-256 handle for the token (`pairTokenId`), so a control plane
   holding several outstanding tokens finds the right one without the token
   crossing the wire. The control plane replies `{ control_id, control_name,
   nonce: <server nonce>, hmac }`, where the transcript is the **handshake
   transcript verbatim** (`encoder` reused, not reinvented): `clientPeerId =
   agent_id`, `clientNonce`, `serverPeerId = control_id`, `serverNonce`, and
   `hmac = HMAC-SHA256(token, "pi-mesh-pair-hello" || 0x00 || transcript)`.
2. `POST /pair/verify` with `{ agent_id, nonce: <server nonce>, hmac: <agent's
   HMAC> }`, where the agent's proof is
   `HMAC-SHA256(token, "pi-mesh-pair-verify" || 0x00 || transcript)`. On success the
   control plane consumes the token and replies `{ ok: true, control_id }`.

**The two proofs are direction-separated, and that is load-bearing.** Without
it the hello response and the verify proof are the same bytes, and the hello
response is observable on the wire: an observer could submit it to
`/pair/verify` first, consume the single-use token, and have the control plane
record the observer's address as the agent's. Prefixing the direction makes each
proof useless in the other slot. (The agent handshake in ADR 0007 shares one
proof in both directions; that is safe there only because it issues nothing and
has nothing to consume. Pairing added a consumable, so it cannot copy that
shape.)

Both sides then derive the same **per-agent credential**:

    credential = HMAC-SHA256(token, "pi-mesh-control-credential" || 0x00 || transcript)

Domain-separated from the pairing proofs so a captured pairing proof can never
be replayed as a credential, or the reverse.

The agent's address is recorded when the **hello** arrives, not when the verify
POST does: verify is the forgeable half (above), so its source address is not
trustworthy.

Why HMAC over a bearer token:

- The token is never transmitted, so a passive LAN observer learns nothing that
  can be replayed. A plain `POST {token}` would hand the credential to anyone
  sniffing plaintext HTTP.
- The agent verifies the control plane's HMAC **before** storing anything, so a
  rogue host that answered first cannot enrol the agent into a pairing it does
  not control.
- The control-plane id is bound into the transcript the credential is derived
  from, so a credential cannot be moved to a different control plane.

**Limit, stated rather than implied.** This defends against a *passive*
observer and against an impostor that does not hold the token. It does not
defend against an **on-path** attacker, because v1 is plaintext HTTP on a
trusted LAN (`docs/SECURITY.md`): such an attacker can drop or reorder any
packet, which already denies a pairing. Replaying the verify POST to consume the
token early is the same denial, and it yields no credential (the success body
carries none) and no membership. The pairing therefore adds no capability an
on-path attacker did not already have; closing that class needs a protected
channel (Noise/TLS), which is deferred, not forgotten.

The token is single-use and TTL-bounded. Consuming it at `/pair/verify` (not at
`/pair/hello`) means a failed verify does not burn the token and the user can
retry within the window.

### 4. Storage

- **Agent:** `~/.pi-mesh/control-credentials.json`, mode `0600`, directory
  `0700`, holding `{ "credentials": [ { controlId, credential, pairedAt } ] }`.
  A separate file from `credentials.json`, whose strict peer-id parse is
  load-bearing for identity and must not be widened to carry secrets. A
  malformed file is a startup error, not a silent reset: silently forgetting a
  pairing looks like working software and is not.
- **Control plane:** SQLite, per decision 6. The credential is stored as issued,
  protected by file permissions; encryption at rest is not in this slice and is
  called out in `SECURITY.md` rather than implied.
- **Dashboard access token:** generated on first run and stored in the control
  plane's own store (the SQLite `meta` table, protected by the database file's
  `0600` mode). A sibling `<db dir>/dashboard.token` file was considered and
  rejected as a second artifact to back up and lose. Every `/api/*` route
  requires the token
  (bearer header, `X-Pi-Mesh-Ui`, or `?token=`); `serve` prints the URL with the
  token once. Without it the LAN listener would let anyone mint a pairing token
  and read every paired agent's sessions — an unauthenticated control surface,
  which `AGENTS.md` forbids.

### 5. The slice is the read path

The dashboard lists paired agents and their sessions, and opens one session's
cached entries. It does **not** spawn, steer, stop or hand off in this slice.
Those are execution skills behind the ADR 0008 gate, and the slice's job is to
prove the pairing + credential + cache path, not to widen the gate. The control
plane is a principal like any other for policy purposes: if its id is added to
`--allow-execution`, the existing gate grants it, unchanged.

### 6. SQLite, via `node:sqlite`

No dependency: `node:sqlite` ships with Node. This raises the floor from
`>=22.0.0` to `>=22.13.0`, the version where it is available without
`--experimental-sqlite` (the module is still flagged experimental by Node and
may print a warning; that is accepted over a native build dependency for a
first slice).

Tables:

| Table | Columns |
|---|---|
| `agents` | `peer_id` PK, `name`, `host`, `port`, `credential`, `paired_at` |
| `sessions` | `agent_id`, `session_id`, `project`, `name`, `started_at`, `updated_at`, `synced_at`; PK `(agent_id, session_id)` |
| `events` | `agent_id`, `session_id`, `entry_id`, `type`, `timestamp`, `data`; PK `(agent_id, session_id, entry_id)` |

`session.list` results are upserted; a failed sync keeps the previous rows, which
is exactly the "offline viewing" `ARCHITECTURE.md` promises. A sync never
deletes a session row on the strength of one empty answer — an agent that is
temporarily unreadable must not look like a fleet that lost its work.

### 7. The wire surface is documented where it already lives

`docs/PROTOCOL.md` gains the pairing routes and the credential principal;
`docs/SECURITY.md` gains the pairing detail and the credential-at-rest note.
No new A2A message is invented — pairing is an HTTP handshake like
`/handshake`, not an A2A skill, because it happens before either side can sign
an A2A request.

## Consequences

- `packages/control-plane` stops being discovery-only: it gets an HTTP server,
  a store and a dashboard. `README.md`'s "there is nothing to open at
  http://localhost:7331" becomes false and is corrected in the same change.
- `packages/agent` gains a second way to be authenticated and a `pair` command.
  The swarm path is untouched; a paired control plane is purely additive.
- The engine floor moves to Node `>=22.13.0`. `Dockerfile` and CI already track
  `node:22`, which is at or above that.
- A control plane credential is a **long-lived secret on two machines**. The
  slice has no revocation UI; re-pairing overwrites, and deleting the row on the
  control plane invalidates it only after the agent's file is also removed. That
  gap is named here and in `SECURITY.md` rather than discovered later.
- Capability honesty is unaffected: a paired control plane does not change which
  skills the agent advertises.

## What this slice deliberately does not do

- No process control, steering, stopping or handoff from the dashboard.
- No live streaming in the dashboard; it reads cached and refreshed
  `session.list` / `session.read`.
- No credential revocation, rotation, or encryption at rest.
- No multi-user dashboard accounts: one token, one operator.
