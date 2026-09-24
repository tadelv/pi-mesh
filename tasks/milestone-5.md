# Milestone 5 - Talking to the session you are reading

M4 made the dashboard an execution surface, but it is a surface with a job list
and a form on it. `README.md` says *"Steering - attach to any session from the
dashboard and redirect it"*, and that is only half true: you can steer a job you
happen to find in the jobs list, not the session you are looking at. Reading a
session and then being unable to say anything to it is the gap this milestone
closes. The start form is the other half: it asks for a project name typed from
memory and confirms with a blocking `window.confirm()`.

The risk this milestone names: **a prompt box is a lie generator.** A chat-shaped
input promises that something is listening. When no process is live for that
session, when the agent never opted in, or when the jobs mirror is stale, the
honest answer is a refusal that says which of those it is - not a message that
disappears into a queue nobody reads. The failure mode is an operator believing
they steered a session that never received the text.

Nothing here is a new grant. `session.steer` is already served by the agent,
already gated (ADR 0008, ADR 0013), and already reachable through `callAgent`.
What is missing is identity, honesty, a UI, and the test infrastructure that
makes either of them verifiable.

## In

1. An ADR that fixes the identity and refusal model before any code (M5-1).
2. The browser-test decision the final review named, plus the regression test
   the ownership guard currently lacks (M5-2, before the UI issues - see below).
3. Prompting the selected session from the transcript, through `session.steer`
   and the gate that already exists (M5-3).
4. A start form that needs neither a blocking dialog nor a memorised project
   name (M5-4).
5. Docs and a hardware transcript (M5-5).

## Out

- **Streaming a session into the dashboard.** Unchanged deferral (ADR 0009,
  ADR 0011). A steer is confirmed by re-reading the session, not by a live feed.
- **A chat client.** No message history, no multi-turn composition, no editing
  past entries. The transcript is a log; the prompt box appends to it by asking
  the agent, and that is all it claims.
- **Incremental `session.read`.** Every page request still reads the whole
  session from the agent before serving the cached page. The cost is now
  documented in `PRODUCT.md`; reducing it is its own change, not a rider here.
- **Multiple operators, roles, per-action tokens, credential rotation UI.** One
  token, one operator; the ADR 0011 gap is unchanged.
- **Job history or metrics.** The agent's job table stays the truth (ADR 0015).
- **Executing on an agent the control plane has not paired with.**

## Issues

### M5-1 - the identity and refusal model for a prompt (ADR 0016)

No code. `session.steer` takes `{ job_id, message }`; the dashboard holds
*sessions*. Something has to fix how one becomes the other, and the ADR must
settle it rather than letting the route decide by accident.

**DoD:** `docs/adr/0016-*.md` is accepted and settles, explicitly:

- how a selected session resolves to a job (the job whose `session_id` matches,
  taken from the agent's `process.list` mirror), and what wins if two jobs claim
  one session;
- what the operator sees and what the route does for each of: no job for that
  session, a job that is not running, a mirror that has never synced, an agent
  whose `controls.steer` is false, and an agent that is unreachable;
- that this is **not** a new grant - the same token, the same per-agent
  `--allow-execution`, the same gated skill - and that the UI must not imply
  otherwise;
- the honesty rule: the control exists only when the agent advertises steer
  *and* a live job for that session is known; otherwise it is absent with a
  stated reason (the M4-3 pattern);
- a maximum message size, and whose error it is when a message exceeds it.

M5-2 onward cite it.

### M5-2 - the browser-test decision, and the debt it unblocks

Not UI work, and deliberately before the UI issues: their Definition of Done
cannot be honest without it. This repo's `AGENTS.md` claims "playwright for the
control plane UI" and no Playwright, jsdom, happy-dom or linkedom is installed.
So today the ownership guard in the transcript path - the fix for the one
blocking defect review pass 1 found - has no test that fails when it is removed.
Pass 2 accepted that with the gap named; this issue closes it or re-states it
deliberately.

**DoD:**

- A recorded decision on the harness: a DOM in vitest, Playwright as documented,
  or neither with the gap restated and the reason. If a harness is added, it is
  one dependency and the reason is written down.
- A regression test for the ownership guard that **fails when the guard is
  removed**, with the failure naming the clause (AGENTS.md: a test that cannot
  fail for its own reason is worse than no test). The mutation is the one the
  final review could not run.
- The focus and `aria-live` behaviour that review pass 1 named is either covered
  by a test or listed explicitly as still uncovered. It must not be quietly
  assumed to work.
- The latent fragility at `packages/control-plane/src/dashboard.ts:367` is
  closed: `renderTranscript`'s heading fallback reads the mutable `selected`
  where every other read in that function uses the captured owner. Pass 2 judged
  it safe because all callers guard; make the invariant unconditional so it
  stays safe.

### M5-3 - prompt the selected session

The transcript panel gains a prompt control, gated exactly as ADR 0016 says.
Submitting calls the existing `POST /api/agents/:peerId/steer { job_id, message }`
route - no new route, no process machinery in the control plane, and the ADR 0013
guard test that scans `packages/control-plane/src` for process machinery must
still pass unchanged.

**DoD:**

- With a live job for the selected session and `controls.steer` advertised, a
  message reaches that session and **the transcript grows a turn**. The clause is
  the transcript growing, not the request returning 200: pi's `steer` command
  queues and is dropped when nothing is in flight (fixed in `41fac23` for the
  agent path), so "accepted" and "acted on" are different claims and only the
  second is a feature.
- Where the control is absent - no live job, never synced, steer not advertised,
  agent unreachable - the page says which of those it is. A silent or absent
  control with no reason is a failure of this issue.
- A refusal is rendered as the agent's refusal with its code; `-32102` must not
  look like a crash, and a `502` transport failure must not look like a refusal.
- The submitted text is cleared on success and **kept on refusal or failure**:
  losing what the operator typed on a refusal is a second failure stacked on the
  first.
- The control is offered only for the selected session, and switching sessions
  while a steer is in flight cannot attach the message to the other session (the
  same ownership rule the transcript renderer now follows).
- **Evidence:** each clause broken and shown to fail by the clause it names.

### M5-4 - starting a session without a modal or a memory test

Today the start form is a free-text project field, a blocking `window.confirm()`,
no in-flight state, and silent success. Concretely:

- replace the modal with an inline, non-blocking confirmation - the deliberate
  friction against an accidental spawn stays, the OS dialog goes;
- offer the projects the control plane has already seen for that agent (cached
  sessions and jobs carry `project`), so the operator is not asked to remember a
  name; when the agent has never reported one, the field stays free-text and says
  so;
- disable the submit while a start is in flight, so a second click cannot start
  a second session;
- on success show what was started (`{ job_id, session_id, pid }`) and offer to
  open it; on refusal keep the form content and show the reason inline.

**DoD:** the double-submit guard has a test that fails when it is removed; the
project suggestions come from real cached data and degrade honestly when there is
none; a refused start leaves the form usable with its content intact; and none of
this introduces a framework or an external resource (ADR 0011 constraints).

### M5-5 - docs and hardware proof

- `README.md`: the "Steering" bullet becomes true in its own words, or is
  narrowed to what the dashboard does.
- `SECURITY.md`: state explicitly that prompting a session grants nothing new -
  a chat box *looks* like a new authority, and the trust model should say why it
  is not.
- `PRODUCT.md` and `DESIGN.md`: the new controls, and the honesty rule they obey.
- `docs/two-machine-proof.md`: a transcript of prompting a session on a second
  machine, showing the turn appear in the transcript, and the refusal when the
  agent has not opted in.

**DoD:** the transcript is in the repo, and names what it does and does not show.

## Risks

- **The prompt box promises more than the mesh can deliver.** The whole reason
  M5-1 exists. An operator who believes a queued message was delivered will wait
  for a reply that is not coming.
- **Session-to-job ambiguity decided in code.** If the route picks a job by
  accident - the first one found, the newest, whichever was cached - then
  prompting becomes a second, ungated execution path in the shape the M4 risk
  warned about.
- **A stale mirror hiding a live session, or offering a dead one.** ADR 0015 made
  the jobs cache non-authoritative on purpose; the UI must not launder it into
  authority by filtering on it silently.
- **Test infrastructure that cannot fail.** This repo's own scar (GOTCHAS): a
  DOM harness more permissive than a browser hides exactly the defects it was
  added to find. A harness that answers any request shape is worse than the
  documented absence it replaces.

## Decisions

Settled by `docs/adr/0016-*.md` (M5-1): the session-to-job resolution, the
refusal for each absent case, and the statement that prompting grants nothing
new. Until that ADR is accepted, M5-3 and M5-4 have no landed shape and should
not be started.

## Exit criteria

- An operator can read a session and prompt it, and the transcript shows the turn
  begin.
- Where a prompt cannot be delivered, the control is absent and the reason is
  stated; a refusal is never rendered as a crash and never as success.
- Starting a session never depends on a blocking dialog or on the operator
  remembering a project name.
- The ownership guard in the transcript path has a test that fails when it is
  removed, and the focus and announcement behaviour is either covered or
  explicitly listed as uncovered.
