# ADR 0010: `mesh.handoff` transfers a task, and rejection is not an error

Status: accepted

## Context

`mesh.handoff` is the literal "agents pass tasks" promise of `init.md`, and M2
ordered it first in milestone 3 for that reason: leaving it in an open-ended
deferral is how a mesh becomes a remote-administration tool wearing the word
collaboration. `PROTOCOL.md` already freezes the payload and the extension URI
(`https://pi-mesh.dev/extensions/handoff/v1`), and `ARCHITECTURE.md` already says
the receiving agent either accepts or settles the task as `TASK_STATE_REJECTED`.
What they do not settle is the boundary between a rejection and a policy denial,
what the caller receives, and what a handoff deliberately does not do. Those are
the decisions below.

## Decision

### 1. The wire is the frozen payload on a normal `message/send`

No new envelope, no new transport. The skill takes the documented
`HandoffPayload` exactly as written, and the extension URI stays as published.

### 2. It is an execution skill, so it meets the ADR 0008 gate

A handoff starts work on the receiving machine, so it belongs in
`EXECUTION_SKILLS`: refused with `-32102` when the gate is closed, advertised in
the card and `txt.caps` only when execution is enabled. This is the first skill
where *another member's* request starts work here, which is exactly what ADR 0008
decision 1 ("membership grants read") was written to govern. It gets no second
mechanism, and no separate opt-in.

### 3. The caller receives the handles it needs to watch the work

    { "task_id": "…", "session_id": "…", "job_id": "…" }

`task_id` is the A2A task the server already creates for the call. It is not
enough on its own: naming the work is not the same as being able to see it, and
the handles that exist are the session id (`session.stream --follow`,
`session.read`) and the job id (`process.stop`). Handing back only a task id
would satisfy `PROTOCOL.md`'s table and leave the caller blind, which is the
failure mode M2-11 was spent fixing.

### 4. Rejection and denial are different answers, on purpose

- **Rejected** - `preferred_agent` names some other peer, or this machine cannot
  take the work - settles the task as `TASK_STATE_REJECTED`. Not a JSON-RPC error
  (ADR 0005), and not escalated to anything. A peer declining a task is ordinary
  in a mesh; it is not an exception and there is no orchestrator to tell.
- **Denied** - the local spawn policy refuses execution - is `-32102`.

The distinction is load-bearing for the caller's next move. "They said no to this
task" means try another peer. "They do not run work for me" means stop asking, and
retrying across the mesh is pointless. Collapsing both into a rejection would make
a policy refusal look like a preference, and collapsing both into an error would
make a normal decline look like a failure.

### 5. `deadline_ms` bounds acceptance, not execution

It is the time allowed for the handoff to be *accepted* - the session started and
the ids returned. It is not a work budget and not a kill switch. Work ends through
`process.stop` or `session.abort`, which ADR 0008 decision 5 deliberately leaves
ungated, because reducing activity is never the more dangerous operation. A
deadline that killed running work would be a second, weaker shutdown path.

### 6. Accepting is the whole protocol: no queue, no retry, no orchestrator

A rejected handoff is settled, never requeued or escalated. Routing is the
caller's problem, and in M3-2 it becomes the control plane's. Accepting does not
enrol the receiver in a follow-up: results come back because the caller reads the
session or streams it, which is a capability M2 already ships. This keeps the
feature bounded, and bounded is the point - an open-ended version of this is the
thing that would make the product something other than what it claims.

### 7. `task` is the prompt, `context` is part of the prompt

The `task` string becomes the child's initial prompt through the existing
required-prompt path, so there is one way to start a session and not two. A
non-empty `context` is rendered into that same prompt under a heading rather than
through a side channel: Pi's interface is text, the prompt is already the trusted
channel, and inventing a file or environment convention would be a second thing
to keep secure for no gain.

### 8. `project` names a directory under the workspace root

It is not a free `cwd`. The receiver resolves it under its configured workspace
root and applies the same containment check as any other spawn, so a caller
cannot hand a peer a path to run in. The guard remains an accident guard and not
a boundary (ADR 0008 amendment), and this decision does not change that - it just
declines to add a second, looser way to choose a directory.

## Consequences

- `PROTOCOL.md`'s skills table row for `mesh.handoff` changes from "not served in
  M1" to served, with its result shape and its rejection semantics, and the
  extension section gains the task/session/job result.
- `mesh.handoff` on a machine with execution disabled must be refused exactly like
  the other execution skills, and `servedSkills(true)` must include it, so
  capability honesty (ADR 0006) holds without anyone remembering to update a list.
- The `-32004` for `mesh.handoff` that `docs/two-machine-proof.md` recorded on a
  gate-closed Pi becomes `-32102` once it is registered; that transcript is
  historical and stays as written.

## Response shapes, pinned

Writing the M3-1 tests from this ADR forced three choices the decisions above
left implicit. They are pinned here rather than left to whoever implements it,
because a test that fails on a formatting coin-flip teaches nobody anything - and
a test that quietly conforms to whatever the code happens to do is worse.

- **Accepted**: the message result is
  `{ "task_id": "…", "session_id": "…", "job_id": "…" }` (decision 3).
- **Rejected**: the message result is `{ "task": <A2A Task> }` whose
  `status.state` is `TASK_STATE_REJECTED`, and `tasks/get` for that id returns the
  same task. The rejection therefore travels as a task rather than as an error
  (decision 4), and a caller that kept the id can always re-read the answer instead
  of holding the first response.
- **Deadline expiry is a rejection, not an error.** A handoff that does not start
  within `deadline_ms` settles `TASK_STATE_REJECTED` like any other decline. It is
  the same fact - no work started here - and giving it a second shape would make
  the caller handle one condition twice.
- **Context rendering**: a non-empty `context` is appended to the prompt under the
  exact heading `Context:`. This is pinned because nothing else in the protocol
  fixes it, and an implementation that picked its own wording would fail a test
  that was right about the requirement and wrong about the spelling.
