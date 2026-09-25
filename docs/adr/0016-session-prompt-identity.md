# ADR 0016 — Prompting a selected session names a live job

Status: accepted (council review: oracle `514534ea`, reviewer `8b441b45`; cross-exam `6b9f362e`, `7b0e6da3`)

## Context

The dashboard selects a cached **session** by agent ID and session ID, but the existing gated `session.steer` skill accepts a **job ID**. `process.list` is the agent's job table; the control plane mirrors it, and that mirror is non-authoritative (ADR 0015). A text box must not imply someone is listening when there is no known live job, the agent has not opted in, or the agent cannot be reached. It also must not mistake an acknowledgement for an observed turn.

## Decision

### Identity and ambiguity

For the selected `(agent_id, session_id)`, consider only jobs from **that agent** with the matching `session_id` and `state === "running"`. A project name, PID, session name, position in the job list or newest timestamp is never a substitute for that match. If there is exactly one running match, its `job_id` is the steer target; stopped/exited rows do not beat a running one. If there are several running matches, **none wins automatically**: show their job IDs, PIDs, projects and start times and require the operator to explicitly choose one job and confirm the target before Send is available. If the operator cannot distinguish them, they cannot send. Describe this as **choosing a job**, not proving which of the conflicting session claims is correct. Never preselect a candidate; never use a cached job as evidence of its current identity. In all cases, the agent's job table and gate decide whether the request actually succeeds.

A selection belongs to the session and the particular job: if the selected session changes, the job choice is cleared. Re-evaluate on submit; if a sync changes the candidates, do not silently keep an obsolete choice. A prompt already in flight retains its original `(agent_id, session_id, job_id)` owner and cannot be displayed as if it belonged to the next selected session. The agent may still change after the mirror was read; `-32103` remains an honest refusal, not an automatic retry on a different job.

### Preconditions and visible reasons

The session prompt control is offered only when the agent advertises `controls.steer`, the execution transport allows dashboard control (ADR 0014), and this control-plane process has successfully synced `process.list` for that agent. A persisted job row after restart, a spawn write that invalidated freshness, or an unsuccessful job sync is **not** a live-job observation. The operator may explicitly Sync again; no cached row silently authorises a prompt. A successful sync is a snapshot, not a guarantee that the agent remains reachable: route failure is still possible.

The page states the applicable reason in the transcript panel rather than presenting a silent absent control:

| Condition | Operator-facing meaning | Behaviour |
|---|---|---|
| No successful jobs sync in this control-plane run, or last sync failed | “Jobs have not been confirmed with this agent. Sync to check before prompting.” | No Send; no request. A `200` from `/api/sync` does not establish a successful `process.list`: its result describes `session.list` only. |
| Transcript read returns `stale: true` | “This transcript could not be verified with the agent; showing cached entries.” | No Send until a subsequent read succeeds **and** jobs are confirmed; keep draft. `stale` can also mean a skill error, not just an offline agent. |
| Agent does not advertise steer (`controls.steer === false`) | “This agent has not enabled steering for this control plane.” If skills are unknown, say capability is unknown instead. | No Send. Pairing does not enable execution. |
| No job for this session after a successful listing | “No job is running for this session.” | No Send. |
| Only matching job(s) are stopped or exited | “The job for this session is no longer running.” | No Send. |
| Several matching running jobs | “More than one job claims this session. Choose which job to prompt.” | No default; explicit job selection and confirmation required. |
| Execution transport refused | “Prompting requires TLS or loopback on this connection.” | No Send; ADR 0014 also permits an explicitly configured `--allow-insecure-execution` override, off by default and warned about elsewhere on the page. |

Show the most specific **knowable** reason: a failed transcript read takes precedence over an old jobs-freshness timestamp; an unconfirmed jobs listing takes precedence over any cached row; a current capability opt-out and a refused execution transport can always be stated from `/api/state`. Do not infer unreachability from `stale: true`, a failed sync, or the age of a timestamp. A request can fail between checking and sending: `200 {ok:false,code,message}` is the **agent's refusal** with its actual code (`-32102` is policy denial, not a crash), while `502 {error:"agent_unreachable"}` means **the agent call failed**, not necessarily that the machine is offline: transport, HTTP status, malformed reply and protocol errors all map to it. `403 confidential_transport_required` is the control plane's transport refusal. These responses remain distinct and retain the draft. If eligibility changes, an already typed draft is not discarded.

### Sending and observing

Send uses the existing `POST /api/agents/:peerId/steer` with `{job_id,message}`. The control plane does not implement a session-addressed execution route or manage a Pi process. A `200 {ok:true}` says **accepted by the agent**, not “the session responded.” Note the last known entry ID before sending; after acceptance, make bounded re-reads of **the same selected session** for up to 15 seconds, looking for a newly appended user turn containing the submitted message. Show “Accepted; checking transcript” in the interim. When one appears, show “Matching turn observed in this session; origin not verified,” refresh the transcript and clear the submitted draft. Entries have no originating request or job ID, so even an exact match **cannot prove this send caused that turn**, especially when two jobs claim one session or another operator sends identical text. A browser test must exercise that competing-writer ambiguity; the real-Pi hardware proof separately checks a turn was acted on. If no turn is observed within 15 seconds, say “Accepted, but no new turn was observed. Delivery is unconfirmed”; keep the draft and do not automatically resend.

The default transcript page shows only the newest 200 entries. Under heavy churn, a real new turn can leave that window before a check sees it. A bounded backward page check is permitted within the 15-second budget, but exhaustive `all=1` scanning or a new incremental-read route is **not** required: every dashboard page request currently re-reads the whole agent session (see `PRODUCT.md`). A missed turn yields **unconfirmed**, never “not delivered.” This is a bounded read, not dashboard streaming. On M5-3 remove the old jobs-list Steer form, which currently offers a prompt from a cached running row without the selected-session ownership/freshness checks; keep Stop and Abort. There is one honest prompting surface.

### Message size and authority

A steer message may contain at most **4096 UTF-8 bytes**. The UI reports the size and prevents an oversized submission without losing the text. The **agent** enforces the same bound on direct `session.steer` calls and answers an oversized message with existing invalid-params error `-32602`, before sending it to Pi; the control plane does not add a second skill-validation rule. Blank messages remain invalid. M5-3 records this protocol-visible bound in `docs/PROTOCOL.md`.

### Trust boundary

This is **not a new execution grant**. The dashboard token lets the operator ask, the paired control identity and per-agent `--allow-execution=<control-id>` opt-in let the agent allow, and the existing `gateExecution` remains the only machine execution gate (ADRs 0008, 0011, 0013). The transport requirement from ADR 0014 remains in force. Neither choosing a job nor seeing a chat-shaped control bypasses any of these checks.

## Consequences

- Choosing between conflicting jobs makes operator intent explicit without pretending the mirror can authenticate a session-to-process association. A person who cannot distinguish the listed jobs must stop rather than gamble.
- Prompting immediately after a spawn may require Sync before the button is offered: spawn invalidates the jobs freshness mark. This is deliberate until the agent confirms its job table.
- An accepted prompt that never yields a durable user entry remains *unconfirmed* and is not recorded as delivered. A real Pi/hardware check, not a successful HTTP stub, proves the acted-on clause in M5-5.
