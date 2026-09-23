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

The `lan` profile (the default) is the only one implemented: the agent
advertises via mDNS when a swarm key is present, and accepts inbound peer
connections.

`--profile public` is a **documented intent, not a feature** (ADR 0004). It is
refused today: `start` and the client commands fail with "trusted
control-plane discovery is not available yet". It is listed under
[Someday](../README.md#someday) rather than presented as a mode you can use.

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

**It does not grant execution.** Process control and steering are a separate,
larger grant that each machine makes locally (ADR 0008): `process.spawn` and
`session.steer` are denied by default and refused with `-32102` unless the
machine has explicitly allowed that peer to execute. Start with
`--allow-execution` (or use `PI_MESH_ALLOW_SPAWN` as the lower-precedence
service-manager fallback); the flag wins when both are present. A stolen swarm
key should therefore yield read access, not code execution.

That distinction is not conservatism about peers. Pi is not a sandbox - its
`security.md` says so directly: built-in tools read, write, edit and run shell
commands *"with the permissions of the pi process"*, and project trust *"is
not a sandbox and it does not restrict what the model can ask tools to do"*.
A spawned Pi is therefore arbitrary code execution as the agent's user. The
key is a file on every member, so treating membership as authority to execute
would mean compromising the least-maintained device yields code execution on
the most valuable one.

Stopping is deliberately ungated: `session.abort`, and `process.stop` for a
job the agent started, are allowed to any member. `process.stop` never accepts
a bare PID, so a peer cannot signal arbitrary processes.

**One limit to be clear about.** The optional peer list supplied to
`--allow-execution=<peer-id,peer-id>` (or its environment fallback) is a
convenience, not a security boundary: a claimed `peer_id` is not authenticated
(ADR 0007), and every member holds the same swarm key, so a malicious member
can claim an allowed peer's ID. It scopes *your own* agents, and it is the
machine-wide opt-in — not the list — that keeps a stolen key from becoming code
execution.

## Boundaries and accident guards

The swarm key and per-request HMAC are the mesh's authentication boundary:
anyone holding the key is a trusted member and can call the other members'
read skills. The execution gate is an explicit local grant, not a sandbox.
The child environment inherits the parent's credentials and tooling except for
`PI_MESH_*` mesh secrets; that exclusion prevents the swarm key from being
handed to a child, but is not isolation. `--no-approve` prevents project-local
extension CODE from loading; it does not restrict what the spawned session can
do.

`PI_MESH_WORKSPACE` is optional and defaults to the user's home directory. Its
realpath containment check is an accident guard and project selector: it
rejects accidental `..` and outside-resolving symlink paths, but a spawned Pi
can leave the directory at will. Neither the environment exclusion nor the
workspace check is a security boundary. Real process isolation requires a
systemd scope or a container, which is the M3 answer.

## Pairing with the control plane

The control plane does not share the swarm key. It pairs with each
agent separately and then holds a per-agent credential (ADR 0011):

1. Control plane mints a short-lived token (TTL 10 min, single use, base64 of 32
   random bytes) and prints it.
2. User runs `pi-mesh-agent pair <token>` on the target device.
3. The agent and control plane prove knowledge of the token with an HMAC
   challenge over the handshake transcript (see `docs/PROTOCOL.md`). **The token
   is never transmitted**, so a passive LAN observer learns nothing replayable; a
   plaintext bearer POST would have handed the credential to anyone sniffing
   HTTP.
4. Both sides derive the same credential, and subsequent requests are signed with
   it exactly as swarm requests are signed with the swarm key. The agent verifies
   a control plane's id against its credential and does not fall back to the swarm
   key.

Revoking an agent from the control plane invalidates its credential without
affecting mesh membership. Note the limit in this revision: there is no
revocation UI. Removing the pairing invalidates it only once the agent's
`~/.pi-mesh/control-credentials.json` entry is removed as well; the credential is
stored in the control plane's SQLite database and on the agent, **unencrypted**,
protected by file mode `0600`. Encryption at rest is deferred and stated here
rather than implied.

The pairing token is typed on the command line and can therefore land in shell
history on the target device. Redacting it from history is the operator's job in
this revision.

### Dashboard access

The control plane's HTTP listener is LAN-facing (it is advertised over mDNS), so
its `/api/*` routes require a **dashboard token** generated on first run and
stored in the control plane's database. Without it, anyone on the LAN could mint
a pairing token and read every paired agent's sessions. The token is accepted as
`Authorization: Bearer`, `X-Pi-Mesh-Ui`, or `?token=`; `serve` prints the URL that
carries it. It is compared in constant time. There is one token and one operator;
there is no account model.

## Optional third-party integration: Jev intent routing

When `TYPESAFE_API_KEY` is set, the dashboard's command bar sends the operator's
text, plus the names and ids of the paired agents and their sessions, to
TypeSafe's hosted `api.typesafe.ai` to route the request to a dashboard action.
This is **off by default**: with the variable unset the route answers `501` and
the command bar is hidden, and a Jev outage answers `503` without affecting any
other control-plane feature. Nothing in the mesh depends on it. Enabling it is a
deliberate disclosure and is the operator's choice.

## What the swarm key protects against

- Rogue peers joining the mesh.
- Passive observers forging A2A messages, and replaying an observed request
  against a *different* agent. (This is why requests are individually
  authenticated rather than carrying a bearer token: a captured token would be
  replayable, which would break exactly this guarantee. It is also why the
  signed transcript names the recipient as well as the sender - replay state is
  per process, so a request that did not name its addressee would be a fresh
  nonce at every other member.)
- Agents advertising by accident: a machine with no swarm key publishes nothing.
  (The `public` profile, which would also refuse inbound, is not implemented —
  see [Someday](../README.md#someday).)

## What it does not protect against

- Eavesdropping on session content (plaintext HTTP).
- **On-path denial of pairing.** The pairing exchange is plaintext HTTP like the
  rest of v1, so an attacker who can inject packets can drop or replay the
  pairing POSTs and deny a pairing. That is the same denial as dropping any
  packet; direction-separated proofs (ADR 0011) stop a *passive* observer from
  replaying the token, and the success response carries no credential either
  way. Closing this needs Noise or TLS, which is deferred.
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
