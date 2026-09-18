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
   - `X-Pi-Mesh-Signature` — base64 HMAC-SHA256 over the transcript
     `method`, `sha256(body)`, sender, recipient, nonce, timestamp — NUL
     separated, in that order, the same encoding the handshake uses.

   (This bullet previously wrote those fields with `\n` between them while
   `docs/PROTOCOL.md` specified one NUL byte. Two descriptions of the same
   bytes cannot both be right, and a client written from the wrong one fails
   every request with no diagnostic. NUL wins because `encodeTranscript`
   already encodes the handshake that way, and because the document forbids
   `U+0000` inside a field, which is what makes the separator unambiguous. The
   fixed vectors in `packages/protocol/test/fixtures/hmac-vectors.json` are
   NUL-joined: do not restate this transcript with a visible separator.)

   The key is the raw swarm key bytes, reusing the existing
   `computeHandshakeHmac`/`verifyHandshake` primitives.
4. **The transcript binds the recipient as well as the sender.** Replay state
   is per process, so a request that does not name its addressee is a *fresh*
   nonce at every other member: one request observed on the wire could be
   executed once per agent, which contradicts this ADR's own premise that
   there is nothing to capture and replay. It was demonstrated against two
   live servers before being fixed. Binding the recipient also mirrors the
   handshake, which already binds both peer IDs.
5. **Replay protection is server-side and bounded.** A nonce seen within the
   acceptance window is rejected. Requests outside a ±60 s timestamp skew are
   rejected, and a nonce is retained for the whole of its acceptance window,
   so a request dated in the future is not replayable after the window closes.
   The window and the skew tolerance are constants, documented. The cache is
   capped, and past the cap the **oldest inserted** entry is dropped — not the
   one nearest to expiring, because a request dated in the future is retained
   longer than one dated in the past, so insertion order and expiry order are
   not the same thing. Reaching the cap needs sustained authenticated traffic
   (i.e. a swarm key holder), and it is the only way the "seen within the
   window" rule can be exhausted.
6. **The handshake is outside the JSON-RPC endpoint**, so its failures are
   HTTP status codes with a small JSON body (`401`, with a reason; `503` when
   the bounded pending-handshake table is full), not a JSON-RPC error code.
   `-32100` therefore does not appear on the handshake route. The table is
   bounded by *refusing* a new hello rather than evicting a pending one, since
   that route carries no proof and an anonymous flood could otherwise displace
   the handshake a legitimate peer is about to verify. The trade is explicit:
   a sustained flood can instead *delay* new handshakes. That is acceptable
   because a handshake is not required to make requests — every request is
   authenticated on its own — so the worst case is a stalled mutual
   confirmation, not a denial of service.
7. **Identity is persistent and random.** A peer ID is generated once into
   `~/.pi-mesh/credentials.json` (directory `0700`, file `0600`, written by
   temp-file-plus-rename); the display name stays separate.

   **A claimed `peer_id` is currently a routing label, not an authenticated
   identity.** It is bound into the proof, so a third party cannot re-attribute
   an existing proof to a different claimed id, but any swarm key holder can
   mint a fresh proof for any id it likes, and nothing on the request path
   cross-checks the claim against the mDNS TXT `id` or the agent card. The
   agreement check this ADR originally specified therefore does not exist yet;
   it belongs with the registry lookup that M1-10 introduces. Until then,
   treat the sender's identity as "some member of the swarm".
8. **`fp` is dropped** from TXT records until it has verification semantics
   (see ADR 0006).

## Consequences

- The threat model in `docs/SECURITY.md` remains true as written: passive
  observers cannot forge messages, and - because the transcript names both
  peers - they cannot replay one against a different agent either. They can
  still read everything, because there is still no encryption.
- A swarm key holder is fully trusted. It can claim any peer ID, and it can
  replay a request it captured against the agent that request was addressed
  to. Neither is defended against, and neither is in scope: membership in the
  swarm *is* the trust boundary.
- No token means no expiry semantics: a stream is authorised when it is
  established and may run to completion. Reconnect requires a fresh, signed
  request. This removes an entire class of state-and-expiry questions.
- Every request costs one HMAC and one body hash. The server holds a bounded
  replay cache, which is the only new state.
- Authentication now depends on clock agreement within the skew tolerance.
  That is a real operational constraint and is documented rather than assumed.
- A peer whose credentials file is lost gets a new identity. That is
  intentional: identity is not a secret, and nothing is derived from it.
