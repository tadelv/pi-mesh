# ADR 0014 — Dashboard execution requires a confidential request

Status: accepted

## Context

ADR 0013 made the dashboard token a **conditional execution grant**: the token
plus an agent that opted in is enough to start or steer work on that machine.
Issue #1 then pointed out what that grant travels over.

The v1 control plane is plaintext HTTP. `SECURITY.md` has always said so, and it
has always accepted the consequence for *reading*: an observer sees session
content. Execution is different in kind. `createControlServer` binds `0.0.0.0`
by default, `dashboardUrl()` embeds the token in a URL, `serve` prints that URL,
and `/api/*` accepts the token as a bearer, an `X-Pi-Mesh-Ui` header, a query
parameter or a cookie. A passive observer who captures one dashboard request
therefore holds a **reusable** credential and can originate new `spawn` and
`steer` requests against every opted-in agent. An observed session is data
disclosure; an observed execution bearer is remote code execution as the agent
user.

The mesh itself does not have this problem, and the reason matters here: A2A
requests are individually authenticated (ADR 0007), so the secret never crosses
the wire and a captured request is not reusable. The obvious fix is to give the
dashboard the same property. It cannot have it: proof-of-possession in the
browser means `crypto.subtle`, and WebCrypto is only exposed on a secure origin.
`http://192.168.x.y:7331` is not one, so the dashboard cannot produce an HMAC
over plaintext LAN HTTP at all. (The mesh's own signing is Node-side, which is
why ADR 0007 could do it.)

So the choice is not "sign the request or not". It is: keep a plaintext path to
execution, or do not have one.

## Decision

### 1. Execution requires a confidential request

The four execution routes (`spawn`, `steer`, `stop`, `abort`) are served only to
a request that arrived confidentially: a TLS-terminated connection
(`socket.encrypted`), or a loopback peer. Anything else is refused with
`403 {"error": "confidential_transport_required"}` and **no agent request is
made**. A captured request is refused by the same rule, which is the property
issue #1 asked for.

Loopback counts because nothing crossed the network. It is not a boundary
against other local processes - ADR 0006 and `AGENTS.md` both say so - and it is
not claimed to be one; it is a boundary against a LAN observer, which is what is
being closed.

### 2. The long-lived token leaves the URL and the normal log

`dashboardUrl()` no longer carries the token, `serve` no longer prints it, and
the dashboard no longer reads it from `?token=` or from a cookie. The token is
obtained by an explicit act - `pi-mesh-control-plane token`, or
`serve --print-token` - and pasted into the dashboard once, where it is kept in
`localStorage` and sent as the `X-Pi-Mesh-Ui` header. The token is never in a
URL, so it is never in browser history, a referrer, or a server log line.

This subsumes the "one-time bootstrap URL" option: a one-time URL is still a
plaintext credential handed to anyone watching, and it buys nothing over asking
the operator to read their own database.

### 3. There is a deliberate, documented override

`serve --allow-insecure-execution` (equivalently
`PI_MESH_ALLOW_INSECURE_EXECUTION=1`) restores the old behaviour on a LAN the
operator has decided to trust. It is off by default and it warns on startup.
This is the same shape as every other grant in this project: the safe thing is
the default, and the unsafe thing has to be asked for out loud.

### 4. Reading is unchanged

Read routes keep every credential form they had, and the documented
plaintext-disclosure caveat stands. The split is deliberate: reading over a
plaintext LAN is a **known, accepted** cost of v1; execution over one is not a
cost, it is a different feature. Only execution requires confidentiality.

### 5. The machine gate is still the machine gate

This constrains the *operator* credential's transport. It does not touch
ADR 0008 or ADR 0013: an agent still refuses execution unless it opted in to
this control id, and `gateExecution` remains the only machine execution gate.
`stop` and `abort` stay ungated on the agent (ADR 0008 §5), so this ADR is what
now protects them on the control plane - they are execution routes here.

### 6. `/api/state` says which transport the page is on

The page receives `execution_transport`, one of `confidential`,
`insecure_override` or `refused`, computed from the request that fetched it. A
refused button that explains itself is a bug report that did not happen.

## Consequences

- **This is a behaviour change for the deployments that exist.** The three
  machines verified for M4 reached the dashboard over plaintext LAN HTTP, so
  dashboard execution stops working there until either the override is set or
  the control plane is put behind TLS or a VPN. `docs/DEPLOYMENT.md` carries
  both, and the warning is explicit rather than buried.
- `SECURITY.md` gains the transport requirement and loses the sentence that
  described the token as appearing in the URL.
- A TLS-terminating proxy on the same host works without configuration: the
  proxy dials the control plane over loopback, which is confidential. A proxy on
  another host does not, and needs the override.
- The residual risk from ADR 0013 narrows: a stolen token is still code
  execution, but it must now be stolen from a confidential channel, and a
  captured plaintext request grants nothing.

## Alternatives considered

- **Proof-of-possession on the dashboard (ADR 0007's mechanism).** Rejected
  above: no WebCrypto on an insecure origin. It would need hand-rolled SHA-256
  in the page - new cryptographic code, in the browser, to protect a channel
  that has no confidentiality anyway.
- **A one-time bootstrap URL.** Still a plaintext credential on the wire, and it
  keeps the token in history.
- **A second loopback-only listener for execution.** Rejected: ADR 0006 decided
  one listener, `AGENTS.md` repeats it, and the execution routes would still need
  the agent's own gate. The transport check gets the same guarantee without a
  second surface to authenticate.
- **Require TLS inside the control plane.** More machinery (certificates,
  rotation, trust) for a property a reverse proxy already provides, and it would
  not help the LAN-only deployment it is meant for.
