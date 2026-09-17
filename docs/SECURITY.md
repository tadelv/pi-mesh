# Security model

## Threat model

We assume an adversary on the same LAN who can:

- Observe mDNS traffic.
- Connect to any listening TCP port.
- Send arbitrary A2A messages.

We do **not** assume the adversary can break HMAC-SHA256 or read the
swarm key file from disk.

## Network profiles

The agent supports two profiles, set via `--profile`:

| Profile | Behavior |
|---|---|
| `lan` (default) | Advertise via mDNS if swarm key is present. Accept inbound peer connections. |
| `public` | Do not advertise. Do not accept inbound. Only connect to peers discovered through a trusted control plane. |

Use `public` on untrusted networks (coffee shops, conferences, hotels).

## Swarm key

**Format:** base64-encoded 32 bytes (256 bits).

**Generation:** `pi-mesh-agent keygen > ~/.pi-mesh/swarm.key`

**Storage:** `~/.pi-mesh/swarm.key`, mode 0600.

**Distribution:** manual, out-of-band. Copy the file to each device.
Future: `pi-mesh-agent join <code>` for QR-based sharing.

**Usage:**

1. **Advertisement gate.** No swarm key → no mDNS advertisement.
2. **Peer authentication.** Challenge-response HMAC over a nonce
   transcript (see PROTOCOL.md).

The swarm key is **not** used for message encryption in v1. Traffic on
the LAN is plaintext HTTP. Confidentiality relies on the LAN being
trusted. Encryption is deferred to a future milestone that adds Noise
or TLS.

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
- Passive observers forging A2A messages.
- Agents accidentally advertising on untrusted networks (public profile).

## What it does not protect against

- Eavesdropping on session content (plaintext HTTP).
- Malicious peers who already possess the swarm key.
- Physical access to a device with the key on disk.

## Revocation

To revoke a compromised swarm key:

1. Generate a new key: `pi-mesh-agent keygen > ~/.pi-mesh/swarm.key`
2. Distribute to trusted devices.
3. Restart agents. Peers with the old key will fail the handshake and
   be removed from the registry.

There is no online revocation list in v1.
