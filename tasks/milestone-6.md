# Milestone 6 - Choosing the model, and speaking to Pi's command surface

M5 made the dashboard able to *talk* to a session it is reading. It still cannot
say which **model** answers, and the prompt box understands only prose. Both are
gaps in the same idea - the operator is steering work on another machine and
cannot see or choose the parts of it that Pi already exposes.

Pi's RPC surface already answers both:

- `get_available_models` lists the models this Pi can run, `set_model` changes
  the model of a *running* process, and `cycle_model` cycles it
  (`docs/rpc-commands.md:202-264`). None of these are reachable from the mesh.
- The mesh already sends `{type:"prompt"}` (`packages/agent/src/skills.ts`,
  `session.steer`). Pi **expands skill commands (`/skill:name`) and prompt
  templates** on `prompt`, and extension commands run immediately even while
  streaming. `get_commands` returns exactly the list Pi's own completion menu is
  built from: extension commands, prompt templates and skills, with names and
  descriptions (`docs/rpc-commands.md:780-828`). The dashboard calls none of it.

So this milestone is mostly *exposure*: three RPC commands the agent can already
forward, one argv flag the spawner can already place, and one list the dashboard
can already render. The work is deciding the authority those exposures carry,
and saying honestly what each one does not prove.

Two risks, named up front, that the ADR exists to settle.

**A model picker is a provider and a bill.** Letting a remote caller choose the
model changes which provider receives the operator's code and prompts, and who
pays for it. `docs/PROTOCOL.md` is explicit that `process.spawn` takes **no
`argv`**: *"The server constructs the command line; a remote caller chooses a
project, not a program. Peer-chosen argv could change the provider, the session
directory, or which extensions load."* A model field is a deliberate, bounded
exception to that sentence, and the milestone must show the bound is real - the
caller picks from the machine's own advertised catalog, never a free string and
never a fuzzy pattern.

**A command hint is not a grant.** Showing `/skill:deploy` in the box implies it
will run. If the skill is disabled, the name is stale, or the agent is not opted
in, the text is delivered to the model as prose and the operator may believe
something executed. A hint list is advisory: it says *this Pi process reports
these commands exist*, not *this command will act*.

## In

1. An ADR (M6-1) that fixes model control as a grant, the model's identity on
   the wire, how the list is obtained with no job running, and the advisory
   status of command hints - **before** any code.
2. `session.models` - enumerate the models the agent's Pi can use (M6-2).
3. `session.set_model` - change the model of a running job (M6-3).
4. A model choice in the Start form, resolved into `process.spawn` (M6-4).
5. Command and skill hints in the prompt box, from `get_commands` (M6-5).
6. A read-only session status - the current model and the context window - from
   `get_state` and `get_session_stats` (M6-6).
7. Docs and a hardware transcript (M6-7).

## Out

- **Persisting a per-agent default model.** ADR 0008 and `AGENTS.md`: the agent
  is stateless except for its credentials file and process map. A remembered
  default is the control plane's, not the agent's.
- **Emulating TUI-only built-ins.** `/model`, `/settings`, `/hotkeys`, `/new`
  and friends are handled only in interactive mode and would not execute if sent
  via `prompt` (`docs/slash-commands.md:3`). The dashboard does not fake them;
  where an RPC command is the real equivalent the ADR says whether it is in
  scope.
- **Thinking level, `/scoped-models`, cycling UI.** `set_thinking_level` and
  `cycle_model` have the same shape as `set_model`; they are a separate change,
  not riders here.
- **A chat client, streaming, multi-turn composition, editing past entries.**
  Unchanged M5 deferrals. The prompt box appends by asking the agent.
- **Free-text model patterns for remote callers.** The ADR may allow a
  *local*-operator escape hatch; a peer never types a pattern.
- **Multiple operators, roles, per-action tokens.** Unchanged ADR 0011 gap.

## Evidence for the installed-Pi claims

Several claims in this milestone are about Pi, not this repository, and Pi's docs
are not vendored here: `get_available_models`, `set_model`, `cycle_model`
(`docs/rpc-commands.md:202-264`), `get_commands` (`:780-828`), expansion of skill
commands and prompt templates on `prompt` (`:31-35`), and TUI-only built-ins
(`docs/slash-commands.md:3`). They were read from the Pi installation at
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/` and the
version is whatever the developer machine runs. An independent reviewer cannot
reach that path, so every Pi-behaviour DoD above is written to be provable from a
real Pi on the machine (an observed turn or `model_change` entry), not from a
quoted document. If a claim here turns out wrong on a different Pi version, the
real-Pi test is what catches it.

## Issues

### M6-1 - the model-control and command-hint decision (ADR 0017)

No code. The ADR must settle, explicitly:

- **Grant.** Whether choosing a model rides the existing execution grant
  (ADR 0008's `--allow-execution`, ADR 0013's single gate) or needs its own
  opt-in. The ADR must state the consequence either way. The position to argue:
  execution already lets an allowed caller start arbitrary work on the machine;
  choosing the model of that work is inside the same authority **provided the
  caller may only choose a value the machine itself advertises** - so the bound
  is the catalog, not a second flag. If the ADR instead makes model control a
  separate grant, it must say what `process.spawn {model}` does when that grant
  is closed (refuse the whole spawn, or spawn with the default and say so).
- **Menu, not pattern - and the agent enforces it.** The caller names an exact
  `(provider, model_id)`. The **agent** compares it for equality against a fresh
  Pi catalog before any argv is built, and never accepts a free string, a
  `provider/id` glob, or a fuzzy pattern. This is not optional: Pi itself accepts
  fuzzy `--model` patterns, so "let Pi resolve it" would reinstate exactly what
  `PROTOCOL.md`'s "no `argv`" bullet forbids. `PROTOCOL.md`'s bullet is amended to
  name this one validated field; `--provider`/`--model` stay the server's argv.
  M6-4 must include a mutation that submits an unlisted value and fails on the
  refusal, not on the argv.
- **Enumeration with no live job is bounded.** The pre-spawn case has no Pi
  process to ask. The decision is a **throwaway `pi --mode rpc` child** answered
  with `get_available_models`, cached with a short TTL, single-flight per agent,
  hard-timeout, and killed on shutdown. Because this is the one ungated read that
  can start a local process, the ADR states that bound and answers it: concurrent
  calls join one child, a cached list does not spawn, and a helper that cannot
  start or times out returns a distinct `catalog_unavailable` rather than an empty
  list, degrading the selector to "machine default" with the reason. Parsing
  `pi --list-models` text and an always-empty selector were rejected.
- **Precedence and authority.** At spawn, `--model` in the argv the spawner
  already builds; on a running job, `set_model`. The agent enforces the catalog
  equality above and keeps no long-lived duplicate of Pi's catalog - the list is
  obtained and checked at use. Pi remains the authority for what happens *after* a
  valid selection (credentials, success), and its error is rendered with its
  message. Catalog states are distinct and testable: listed → proceed; unlisted →
  invalid-params refusal; unavailable/stale → refusal with retry guidance, never a
  fall-through to Pi's fuzzy match. If a local operator changes the model out of
  band, the dashboard learns it by re-reading the transcript - never by assuming.
- **Hints are advisory.** `get_commands` names resources Pi loaded; it does not
  promise a gated skill will run, and expansion belongs to Pi. State that the
  list is scoped to the selected job's Pi process and can go stale.

**DoD:** `docs/adr/0017-model-and-command-surface.md` is **accepted** (the
operator settled every decision up front - see `## Decisions`) and states the
grant question, the agent-enforced catalog equality and its three catalog-state
outcomes, the `PROTOCOL.md` amendment text, the bounded no-live-job enumeration,
the command support matrix (M6-5), and the advisory rule. It is a document and so
has no failing test of its own; the enforcement it promises is tested by
M6-2/M6-3/M6-4's mutations, and M6-1 is not done until those exist. M6-2 onward
cite it.

### M6-2 - `session.models`

A new `Skill` member, exposure and wire shape in `docs/PROTOCOL.md`, in
`KNOWN_SKILLS` and the `Skill` union (`packages/protocol/src/types.ts`). Input is
`{ job_id? }`. With a `job_id` the handler requires that job to be tracked and
**running** - a `stopping` or `exited` job is refused, because `JobManager.send`
would still accept a `stopping` one (`packages/agent/src/jobs.ts:556-566`) - and
forwards `{type:"get_available_models"}` to that job's Pi. With no `job_id` it
starts the bounded throwaway `pi --mode rpc` child and serves a one-TTL cached
list (ADR 0017). The caller never gets an implicit job choice, and never sends a
`session_id` to be matched. Exposure is ungated: watching and listing are reads
(ADR 0009 §5).

**DoD:**

- A non-empty, exact fixture list round-trips with `id`, `provider` and the label
  fields Pi carries (`name`, and cost/`reasoning` only if shown honestly). The
  test asserts the exact list, not "an array arrived" - an always-empty stub must
  fail it.
- "Pi reports none" returns an empty list; a helper that cannot start or a dead
  job returns a distinct error, never `[]`. The two are asserted separately so
  neither can satisfy the other's clause.
- Removing the enumeration/forwarding makes the non-empty-list test fail on that
  clause, not on a timeout or a transport error.
- Gating matches ADR 0017 (ungated read); the bounded helper's single-flight and
  TTL each have a test that fails when the bound is removed.
- Job identity is explicit: a `job_id` naming a `stopping` or `exited` job is
  refused (test fails by name when the running check is removed), and no code path
  selects a job from a `session_id`.

### M6-3 - `session.set_model`

`{ job_id, provider, model_id }` forwarded as
`{type:"set_model", provider, modelId}` through the existing `JobManager.send`
(`packages/agent/src/jobs.ts:556`). Gated exactly as `session.steer`.

**DoD:**

- The outbound command shape is asserted exactly, via a fixture that **refuses a
  wrong shape** (missing `provider`, camelCase vs snake_case): a fixture-supplied
  `model_change` entry cannot stand in for the dispatch. Removing the
  `jobs.send`/forwarding makes the test fail on the dispatch clause.
- The **effect** is observed, not the acknowledgement: with a real Pi and a known
  starting model, the selected model differs afterwards and the session shows a
  `model_change` entry naming the chosen `provider`/`modelId`. A `200` alone is not
  evidence.
- The catalog equality from ADR 0017 is enforced here too: an unlisted pair is
  refused with invalid-params and reaches no `jobs.send`; the refusal test fails
  by name when the check is removed.
- The closed gate returns `-32102` with a positive control (the same call with the
  gate open is not `-32102`), an unknown job the existing `-32103`, and Pi's own
  refusal is surfaced with its message.
- The control appears only where the agent advertises the capability
  (`agentControls` gains `setModel`).
- "Running" is checked, not assumed: because `JobManager.send` still accepts a
  `stopping` job (`packages/agent/src/jobs.ts:556-566`), a `stopping` or `exited`
  job is refused by the skill rather than passed through.
- The ADR 0013 guard test that scans `packages/control-plane/src` for process
  machinery still passes unchanged.

### M6-4 - model before spawn

The Start form gains a model selector, populated from `session.models` for that
agent, and the chosen value rides `process.spawn`'s new `model` field. The
spawner places `--provider`/`--model` (or `--model provider/id`) in the argv it
already builds (`packages/agent/src/spawner.ts`, the `args` array).

**DoD:**

- The **effective** model, not the recorded flag: with a known machine default,
  the first assistant turn is produced by the selected model (a `model_change`
  entry naming it, or the model reported for the turn). Appending unused argv
  flags must fail this, and so must an unrelated `session_info` entry - that entry
  carries `name`/`cwd` only (`packages/control-plane/src/dashboard.ts:358-372`) and
  cannot establish a first-turn model.
- Mutation: remove the effective model selection (drop the flag from the argv the
  spawner actually launches with) and the test fails on the model clause.
- With no confirmed list, or a `catalog_unavailable` from `session.models`, the
  selector degrades to "use this machine's default" with the reason stated (the
  M5-4 honesty pattern), and the free-text project field still works. If the
  choice is refused by the catalog check, the spawn fails before any process
  starts and says so - never a silent fallback to a different model.
- M5-4's rules still hold: inline confirmation, double-submit guard, form
  content retained on refusal, no framework or external resource.
- The ADR 0013 guard test still passes: model selection adds no process
  machinery to the control plane.

### M6-5 - command and skill hints, and the command surface

A `session.commands` skill takes a required `{ job_id }` - commands belong to a Pi
process, so the caller must name it, and there is no implicit selection (ADR 0017,
ADR 0016's rule) - requires that job to be running, and wraps `get_commands` for
it. The prompt box offers the names as completion and lists them with
descriptions; the box still sends plain text through `session.steer` unchanged.
The ADR fixes an explicit **support matrix** rather than leaving it implied:

| Entered as | Reaches Pi as | Supported |
|---|---|---|
| plain prose | a user turn | yes |
| `/skill:<name>` (and an enabled skill) | expanded by Pi before the turn | yes |
| `/<template>` prompt template | expanded by Pi | yes |
| an extension command | executed immediately, even while streaming | yes |
| `/model`, `/settings`, `/compact`, `/hotkeys` and other TUI built-ins | nothing - Pi rejects them outside interactive mode | **no**, and the UI says so |

**DoD:**

- The list comes from a real `get_commands` on the job named by the **required**
  `job_id`, which must be running (a `stopping`/`exited` job is refused; the test
  fails by name when either the required-`job_id` check or the running check is
  removed). Removing the fetch, or disabling completion, must fail a named clause,
  and the exact fixture list is asserted so `[]` from a stub cannot pass.
- **A command actually acts.** At least one real skill command, entered in the
  box, produces its effect in the session - asserted from the resulting turn, not
  from the text appearing or a `200`. A test that only checks the hint rendered is
  not sufficient, and this clause fails when expansion is left as prose.
- A name that is stale, gated or unknown is still submitted as text and rendered
  as the agent's refusal if Pi refuses it - the box never blocks on a name it does
  not recognise, and never reports a command as executed.
- Built-in TUI commands are absent from the list, the support matrix above is in
  `docs/PROTOCOL.md`/`README.md`, and entering one shows the unsupported
  explanation rather than silence.
- RPC equivalents of built-in TUI commands (`compact`, `new_session`) are
  **out of scope** (ADR 0017). They mutate the session, so they are
  execution-shaped and need their own issue under the ADR 0008/0013 gate and the
  ADR 0016 refusal model.

### M6-6 - session status: the current model and the context window

A read-only `session.status` skill takes a required `{ job_id }` - a status belongs
to a Pi process, so the caller names it (ADR 0016's rule) - requires that job to be
running, and answers from two Pi reads: `get_state` for the current `model` and
`thinkingLevel`, and `get_session_stats` for `tokens`, `cost` and `contextUsage`
(`docs/rpc-commands.md:149-180, 520-561`). The dashboard renders it beside the
composer, the way Pi's own status bar shows the model and how full the context
window is, so an operator steering work on another machine can see which model is
answering and how much room it has left.

This is the same exposure shape as `session.commands` (M6-5): an ungated read
(ADR 0009 §5) that passes Pi's own numbers through unmodified. It does not choose a
model (M6-3/M6-4), does not compact, and does not compute a context estimate of its
own. `contextUsage` is omitted by Pi until a fresh post-compaction response exists,
and its fields are `null` in that window; the UI shows that as unknown, never as 0%
or a full bar.

Before code, ADR 0017 is extended with this read's wire shape, its ungated
exposure, and the honesty rule for absent context numbers (decision 7 and a row in
the wire-surface table); this issue implements that decision and does not invent
one.

**DoD:**

- The status is assembled from a real `get_state` **and** `get_session_stats` on
  the job named by the **required** `job_id`, which must be running (a
  `stopping`/`exited` job is refused; the test fails by name when either check is
  removed; unlike `session.models` there is no pre-spawn helper form). A fixture
  returns an exact `{ model, contextUsage }` object and the test asserts that
  object, so an always-null stub fails it.
- The model reported is the one Pi reports, not the one the dashboard last
  requested: after an out-of-band change the next status read differs, and the
  status path sent no `set_model`.
- `contextUsage` absent, or `tokens`/`percent` `null`, renders as unknown - a test
  asserts the absent case produces the unknown label rather than 0% or 100%.
- The control appears only where the agent advertises `session.status`
  (`agentControls`), and the ADR 0013 guard test passes unchanged.

### M6-7 - docs and proof

- `README.md`: the model and command bullets, in their own honest words.
- `SECURITY.md`: choosing a model spends the operator's money on a provider the
  operator's own machine already trusts, and grants nothing beyond the existing
  execution opt-in; the command hint list reveals resource *names* only.
- `PRODUCT.md` / `DESIGN.md`: the new controls and the honesty rule they obey.
- `docs/PROTOCOL.md`: the new skills and the amended `process.spawn` shape.
- `README.md`/`docs/PROTOCOL.md`: the status readout skill, and what an ungated
  peer read of the operator's model, cost and context numbers reveals.
- `docs/two-machine-proof.md`: a transcript of choosing a model before a spawn,
  changing the model of a running session, and a prompt with a skill command,
  including at least one refusal.

**DoD:** the transcript is in the repo, uses **deployed commit IDs**, shows the
command or model actually acting on the session (not an API acknowledgement), and
names explicitly what it does not show - as M5's transcript does. At least one
refusal (closed gate, unlisted model, or an unsupported built-in) is in it.

## Risks

- **Model choice as a smuggling route for argv.** If the value is ever passed as
  free text, a pattern, or interpolated into a shell string, the "no argv"
  guarantee in `PROTOCOL.md` is gone. The ADR's equality-against-the-catalog rule
  is the mitigation, and the test must fail if it is removed.
- **A picker that implies a bill was quoted.** Costs differ by orders of
  magnitude between models; show what the catalog carries or show nothing, and do
  not present a model as "cheap" without the source.
- **A hint list that reads as a promise.** The most likely operator error is
  believing a listed command ran. The advisory label is a requirement, not a
  nicety.
- **A stale list across a restart.** `get_commands` and `get_available_models`
  are per Pi process; a cached list from a previous job is not evidence for the
  current one. The ADR must say when a list is treated as confirmed.
- **Gating drift between spawn-time and run-time.** `process.spawn {model}` and
  `session.set_model` must resolve to the same authority, or one becomes a way
  around the other.

## Decisions

All settled by the operator before implementation; recorded in
`docs/adr/0017-model-and-command-surface.md` (M6-1).

- **D1 - grant.** Model choice **rides the existing execution grant** (ADR 0008's
  `--allow-execution`, the single ADR 0013 gate). No second flag. The bound is the
  machine's own advertised catalog: a caller may only name an exact
  `(provider, model_id)` the agent listed, never a free string or fuzzy pattern.
- **D2 - enumeration.** A throwaway `pi --mode rpc` child answers
  `get_available_models` when no job is running, with a short-lived cache.
- **D3 - scope.** Model change applies to a **running Pi process only**. No
  persisted per-agent default; the agent stays stateless (AGENTS.md), and the
  remembered choice is the control plane's convenience, not the agent's state.
- **D4 - command surface.** **Advisory hints only**: the dashboard shows what
  `get_commands` reports and autocompletes names, and still submits plain text.
  RPC equivalents of built-ins (`compact`, `new_session`) are out of scope.
- **D5 - thinking level.** Deferred. `set_thinking_level` and `cycle_model` have
  the same shape as `set_model` and are a separate change.

Streaming to the dashboard is a separate milestone (M7) under
`docs/adr/0018-dashboard-live-streaming.md`, not part of this one: it adds a
long-lived connection and a shutdown/pair-unpair lifecycle that this milestone
does not touch.

## Exit criteria

- An operator can see which models an agent's Pi offers, choose one before a
  spawn and change one on a running session, and the transcript confirms the
  choice rather than the request.
- The prompt box offers the commands Pi reports, labels them advisory, and never
  presents a refusal as a success.
- The status readout shows the model and context Pi reports, or states that they
  are unknown; it never invents a context window and never mutates the session.
- No new process machinery exists in the control plane; the ADR 0013 guard test
  passes unchanged.
- Every absent capability states its reason, and an unconfirmed list is never
  presented as live.
