# Security model

## Threat model

We assume an adversary on the same LAN who can:

- Observe mDNS traffic.
- Connect to any listening TCP port.
- Send arbitrary A2A messages.

We do **not** assume the adversary can break HMAC-SHA256 or read the
swarm key file from disk.

## Network profiles

pi-mesh is POSIX-only for now. Windows is not supported: the swarm key
permission model relies on POSIX file modes, which Windows reports
synthetically.

The agent supports two profiles, set via `--profile`:

| Profile | Behavior |
|---|---|
| `lan` (default) | Advertise via mDNS if swarm key is present. Accept inbound peer connections. |
| `public` | Do not advertise. Do not accept inbound. Only connect to peers discovered through a trusted control plane. |

Use `public` on untrusted networks (coffee shops, conferences, hotels).

## Swarm key

**Format:** base64-encoded 32 bytes (256 bits).

**Generation:** `pi-mesh-agent keygen > ~/.pi-mesh/swarm.key; chmod 600 ~/.pi-mesh/swarm.key`

The `chmod` matters: a bare `>` creates the file with the shell's umask
(commonly `0644`), and an agent refuses to load a key that any group or other
user can read. Use an explicit `chmod` rather than a `(umask 077 && ...)`
subshell, which is not portable to every login shell - in fish, `( ... )` is
command substitution rather than a subshell.

**Storage:** `~/.pi-mesh/swarm.key`, no group or other access (`0600`
recommended; the loader rejects anything with group or other permission bits).

**Distribution:** manual, out-of-band. Copy the file to each device.
Future: `pi-mesh-agent join <code>` for QR-based sharing.

**Usage:**

1. **Advertisement gate.** No swarm key → no mDNS advertisement.
2. **Peer authentication.** Challenge-response HMAC over a nonce
   transcript (see PROTOCOL.md).
3. **Request authentication.** The handshake proves the key but issues
   nothing. Every subsequent request carries its own nonce, timestamp and
   HMAC, so there is no token to capture and replay (ADR 0007).

The swarm key is **not** used for message encryption in v1. Traffic on
the LAN is plaintext HTTP. Confidentiality relies on the LAN being
trusted. Encryption is deferred to a future milestone that adds Noise
or TLS.

## What swarm membership grants

Joining the swarm is a real grant, not just a discovery shortcut: **any member
may read this agent's session list, session content, and live session
streams.** That follows from the shared-key model, and it is stated here
rather than left to be discovered.

Process control and steering are *not* part of that grant in v1. They are not
served to peers at all until a spawn policy exists (ADR 0006).

## Pairing with the control plane

The control plane does not share the swarm key. It pairs with each
agent separately:

1. Control plane generates a short-lived token (TTL 10 min, single use).
2. User runs `pi-mesh-agent pair <token>` on the target device.
3. Agent and control plane exchange fingerprints over an ephemeral
   channel, then persist a per-agent credential.
4. Subsequent connections use the credential, not the token.

Revoking an agent from the control plane UI invalidates the credential
without affecting mesh membership.

## What the swarm key protects against

- Rogue peers joining the mesh.
- Passive observers forging A2A messages, and replaying an observed request
  against a *different* agent. (This is why requests are individually
  authenticated rather than carrying a bearer token: a captured token would be
  replayable, which would break exactly this guarantee. It is also why the
  signed transcript names the recipient as well as the sender - replay state is
  per process, so a request that did not name its addressee would be a fresh
  nonce at every other member.)
- Agents accidentally advertising on untrusted networks (public profile).

## What it does not protect against

- Eavesdropping on session content (plaintext HTTP).
- Malicious peers who already possess the swarm key. Such a peer is fully
  trusted: it can claim any peer ID (a claimed ID is a routing label, not an
  authenticated identity - see ADR 0007), and it can replay a captured request
  against the agent that request was addressed to.
- Physical access to a device with the key on disk.

## Dialing a peer by address

Discovery is the ordinary way to resolve a peer, but some networks block
multicast entirely (corporate Wi-Fi, guest networks, most cloud VMs, and any
setup where the two devices are on different subnets). `--peer-host` dials an
address directly and skips discovery:

```
pi-mesh-agent sessions --peer-host box.local:7330
pi-mesh-agent call session.list --peer-host 10.0.0.7
```

This is **not** a weaker path. Every signed request binds the recipient peer
ID into its transcript, so the client must know that ID before it can sign
anything — and it learns it from the handshake, not from a flag. The server's
challenge is an HMAC over a transcript that names the server, so a peer that
produces a valid challenge has proven swarm membership for the ID it claims.
That is strictly stronger evidence than an mDNS TXT record, which carries no
proof at all.

An address is therefore never taken on trust: a host that holds a different
swarm key (or no key) fails the challenge check and the command exits `11`
without sending any request. Beware only that, as with discovery, `--peer-host`
proves *membership*, not that the peer is the machine you meant — on a network
where anyone can answer for an address, so can anyone holding the swarm key
(see "What it does not protect against").

## Revocation

To revoke a compromised swarm key:

1. Generate a new key: `pi-mesh-agent keygen > ~/.pi-mesh/swarm.key` then
   `chmod 600 ~/.pi-mesh/swarm.key` (the loader refuses group or other access,
   so the `chmod` is required — a `>` alone creates the file `0644`).
2. Distribute to trusted devices.
3. Restart agents. Peers with the old key will fail the handshake and
   be removed from the registry.

There is no online revocation list in v1.
