# ADR 0007 — Per-request HMAC instead of a post-handshake bearer token

## Context

`docs/PROTOCOL.md` specifies a swarm-key challenge-response and then says that
on success "the connection is authenticated. All subsequent A2A messages are
accepted without per-message signing."

That is coherent for a connection-oriented transport, where a passive observer
cannot inject into an established session. pi-mesh does not use one: the
transport is HTTP, which is stateless. "The connection" therefore has to be
materialised as *something* the client presents on the next request.

The obvious something is a bearer token. It was the first choice here, and it
is wrong:

> `docs/SECURITY.md` lists "passive observers forging A2A messages" among what
> the swarm key **protects against**. A bearer token sent over plaintext HTTP
> can be captured by any passive observer on the LAN and replayed for its whole
> TTL. That is exactly the forgery the document promises to prevent.

There was also no decision on peer identity. M0 defaulted identity to
`hostname()` and fingerprint to `"unpaired"`, so a peer's claimed identity was
neither stable nor verifiable.

## Decision

1. **No token, no cookie, no session.** Every request after the handshake is
   independently authenticated. There is nothing to steal and nothing to
   expire mid-stream.
2. **Handshake is two POSTs** — `POST /handshake` (client hello) and
   `POST /handshake/verify` (client proof), preserving the mutual
   challenge-response in `docs/PROTOCOL.md`. Not `GET /handshake`: a GET with
   a JSON body is a genuine interop hazard, and intermediaries are entitled to
   drop it.
3. **Requests carry their proof in headers:**
   - `X-Pi-Mesh-Peer` — the sender's peer ID
   - `X-Pi-Mesh-Nonce` — unique per request, base64
   - `X-Pi-Mesh-Timestamp` — ISO 8601 UTC
   - `X-Pi-Mesh-Signature` — base64 HMAC-SHA256 over
     `method \n path \n sha256(body) \n peer \n nonce \n timestamp`

   The key is the raw swarm key bytes, reusing the existing
   `computeHandshakeHmac`/`verifyHandshake` primitives.
4. **Replay protection is server-side and bounded.** A nonce seen within the
   acceptance window is rejected. Requests outside a ±60 s timestamp skew are
   rejected. The window and the skew tolerance are constants, documented.
5. **The handshake is outside the JSON-RPC endpoint**, so its failures are
   HTTP status codes with a small JSON body (`401`, with a reason), not a
   JSON-RPC error code. `-32100` therefore does not appear on the handshake
   route.
6. **Identity is persistent and random.** A peer ID is generated once into
   `~/.pi-mesh/credentials.json`; the display name stays separate. The mDNS
   TXT `id`, the handshake `peer_id`, and the agent card identity must all
   agree, and the listener verifies that agreement rather than trusting one of
   them.
7. **`fp` is dropped** from TXT records until it has verification semantics
   (see ADR 0006).

## Consequences

- The threat model in `docs/SECURITY.md` remains true as written: passive
  observers cannot forge messages. They can still read everything, because
  there is still no encryption.
- No token means no expiry semantics: a stream is authorised when it is
  established and may run to completion. Reconnect requires a fresh, signed
  request. This removes an entire class of state-and-expiry questions.
- Every request costs one HMAC and one body hash. The server holds a bounded
  replay cache, which is the only new state.
- Authentication now depends on clock agreement within the skew tolerance.
  That is a real operational constraint and is documented rather than assumed.
- A peer whose credentials file is lost gets a new identity. That is
  intentional: identity is not a secret, and nothing is derived from it.
