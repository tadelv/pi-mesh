# ADR 0017 - Choosing the model, and speaking to Pi's command surface

Status: accepted (operator-settled decisions; see "Decision")

## Context

The dashboard can start a session (`process.spawn`) and prompt the selected
session (`session.steer`, ADR 0016). It cannot say which **model** answers, and
its prompt box understands only prose. Pi's RPC surface already exposes both, and
the mesh reaches neither:

- `get_available_models`, `set_model` and `cycle_model` are documented RPC
  commands (`docs/rpc-commands.md:202-264`). Nothing in the mesh calls them.
- `get_commands` returns extension commands, prompt templates and skills with
  names and descriptions - exactly what Pi's own completion menu is built from
  (`docs/rpc-commands.md:780-828`). Nothing in the mesh calls it.
- The mesh **does** already send `{type:"prompt"}` for `session.steer`
  (`packages/agent/src/skills.ts`), and Pi expands skill commands
  (`/skill:name`) and prompt templates on `prompt`. So `/skill:` text typed in
  the dashboard already works; the dashboard simply never told the operator
  which names exist, and never offered the model.

The two risks this ADR settles.

**A model picker is a provider and a bill.** A remote caller choosing the model
changes which provider receives the operator's code and prompts and who pays.
`docs/PROTOCOL.md` states that `process.spawn` takes **no `argv`**: *"The server
constructs the command line; a remote caller chooses a project, not a program.
Peer-chosen argv could change the provider, the session directory, or which
extensions load."* Model choice is exactly that sentence's provider case, so it
is either rejected or made a bounded exception.

**A command hint is not a grant.** Showing `/skill:deploy` implies it runs. If
the skill is disabled or the name stale, the text reaches the model as prose and
the operator may believe something executed.

## Decision

### 1. Model choice rides the existing execution grant, bounded by the catalog

No new opt-in flag. `--allow-execution` (ADR 0008) already lets an allowed caller
start arbitrary work on the machine; choosing the model of that work is the same
authority, **provided the caller may only name a model the machine itself
advertised**. The grant is unchanged; the value is bounded.

### 2. The binder is agent-enforced equality against a fresh Pi catalog, not a pattern

The caller names an exact `(provider, model_id)` pair. The **agent** resolves it
against the catalog its own Pi reports and never accepts a free string, a fuzzy
pattern, or a `provider/id` glob. `docs/PROTOCOL.md`'s "no `argv`" bullet is
amended to name this one validated field and why it is not argv: it is a value
from the machine's own catalog, compared for equality, and `--provider`/`--model`
remain the server's argv, not the caller's.

The check is the agent's, not Pi's. "Let `--model` resolve it" would reinstate
the very thing the bullet forbids, because Pi accepts **fuzzy patterns**: a caller
could pass a pattern that happens to match a provider the machine did not intend
to offer. Equality is therefore enforced before any argv is built, for both
`process.spawn` and `session.set_model`.

### 3. Wire surface

| Skill | Exposure | Input | Output |
|---|---|---|---|
| `session.models` | peer (ungated; read) | `{ job_id? }` | `{ models: Model[] }` |
| `session.set_model` | **gated on the spawn policy** | `{ job_id, provider, model_id }` | Pi's `set_model` data (the model object) |
| `session.commands` | peer (ungated; read) | `{ job_id }` | `{ commands: Command[] }` from `get_commands` |
| `session.status` | peer (ungated; read) | `{ job_id }` | `{ model, thinkingLevel, tokens, cost, contextUsage }` from `get_state` + `get_session_stats` |

`process.spawn` gains one optional field: `model?: { provider, model_id }`.

**Job identity is explicit, never inferred.** `session.set_model` and
`session.commands` require `job_id`; `session.models` takes an optional
`job_id`. A job is never chosen by matching a `session_id`, by position in the
job table, or by the first running match. This is ADR 0016's rule applied to the
new skills: where an answer depends on a particular Pi process, the caller names
that process or the call is refused. When `job_id` is given, the agent requires
that job to be tracked and running before answering (a `stopping` or `exited` job
is refused - `JobManager.send` alone would accept a `stopping` one,
`packages/agent/src/jobs.ts:556-566`). When `session.models` is called with no
`job_id`, that is the pre-spawn case and only decision 4's helper answers.

`session.models` and `session.commands` are reads, like `session.read`, and are
ungated (ADR 0009 §5). `session.set_model` starts or steers work and is gated
exactly as `session.steer`.

### 4. Enumeration with no running job: a bounded throwaway Pi, cached

`session.models` with a `job_id` asks that job's Pi through `JobManager.send`.
With no `job_id` - the pre-spawn case, where there is no process to ask - the
agent starts one short-lived `pi --mode rpc` child, asks
`get_available_models`, closes it, and caches the list for one TTL.

This helper is the one place an **ungated** read causes a local process, so it is
bounded rather than left as a per-request spawn:

- **Single-flight per agent** with a short TTL: concurrent `session.models` calls
  join one child, and a cached list is served without spawning.
- **Hard timeout and teardown**: the child is killed on timeout, on agent
  shutdown, and when the cache is refreshed; it never outlives its request.
- **No session, no prompt, no argv from the caller**: the helper runs Pi with no
  prompt and is only asked to list models. It is a read, which is why
  `session.models` stays ungated like `session.list`.
- **Honest failure**: if the helper cannot start or times out, `session.models`
  returns a distinct `catalog_unavailable` outcome rather than an empty list, and
  the pre-spawn selector degrades to "machine default" with the reason stated
  (M5-4's pattern). An empty list means Pi genuinely reported none; an unavailable
  catalog never masquerades as one.

Parsing `pi --list-models` text was rejected as fragile. An always-empty
pre-spawn selector was rejected as dishonest about what the machine can offer.

### 5. The agent enforces the bound; Pi is the authority for the result

The agent validates the requested `(provider, model_id)` against a **fresh**
catalog - the named job's `get_available_models`, or the helper from decision 4 -
and refuses a value it does not contain, before building any argv. Pi remains the
authority for what happens *after* a valid selection: whether the provider has
usable credentials, whether the request succeeds, and what the model then does.

**"Fresh" is defined, because the helper is cached.** A catalog is fresh when it
was obtained at most one TTL ago, from either a running job's Pi or the helper. A
within-TTL cached helper result **does** authorise a selection - that is what the
cache is for, and decision 4's single-flight bound makes the reuse deliberate
rather than accidental. Beyond the TTL the list must be re-obtained, or the
request refused; a cached result is never treated as authority once it is old.
This resolves the apparent tension with "not cached as authority": the catalog is
not a long-lived source of truth, but a recent observation is exactly what
validation uses.

Catalog states are mutually exclusive and testable:

| Catalog state | Outcome |
|---|---|
| Fresh list contains the pair | **Spawn:** `--provider`/`--model` placed in the argv the spawner already constructs. **`set_model`:** the RPC command `{type:"set_model", provider, modelId}` is sent to that job. |
| Fresh list does not contain the pair | Refuse with invalid-params; no argv, no process, no RPC |
| Catalog unavailable, or older than one TTL and unrenewable | Refuse; caller may retry. Never fall through to Pi's fuzzy match |

The agent keeps no long-lived duplicate of Pi's catalog - the list is observed
and bounds-checked at use, and only a within-TTL observation counts. If a local
operator changes the model out of band, the dashboard learns it by re-reading the
transcript (Pi appends a `model_change` entry), never by assuming.

### 6. Command hints are advisory, and do not emulate built-ins

`session.commands` exposes `get_commands` for the selected job's Pi process. The
dashboard lists the names with their descriptions and offers completion. It does
not block an unrecognised name, does not map a name to an action, and does not
claim a command ran. Built-in TUI commands are absent from `get_commands` by
Pi's design, and so they cannot be run from the box; RPC equivalents
(`compact`, `new_session`) are out of scope and are execution-shaped work for a
future issue under ADRs 0008/0013.

### 7. The status readout reports Pi's numbers and does not compute its own

`session.status` takes a required `{ job_id }` - a status belongs to a Pi process,
so ADR 0016's rule applies as it does to `session.commands` - requires that job to
be running, and answers by forwarding two documented reads: `get_state` for the
current `model` and `thinkingLevel`, and `get_session_stats` for `tokens`, `cost`
and `contextUsage` (`docs/rpc-commands.md:149-180, 520-561`). It is an ungated read
like `session.read` (ADR 0009 §5): it shows the operator what the machine already
reports and mutates nothing.

The agent does not estimate a context window, does not sum usage itself, and never
presents a stale known value as current. Pi omits `contextUsage` when no model or
window is known and returns `null` fields immediately after compaction; the
dashboard renders that absence as unknown, not as 0% or a full bar. This is a
readout, not authority: choosing the model stays with `session.set_model`
(decision 5) and `process.spawn` (decision 3), and a status read never changes what
is running. Because it needs a live process's own numbers, it has no pre-spawn
helper form; the only ungated read that starts a process remains decision 4's
`session.models`.

## Consequences

- The "can I pick a model?" gap closes without a new grant, and the `PROTOCOL.md`
  promise that a caller cannot choose a program is preserved by an agent-enforced
  equality check rather than by refusing the feature.
- Listing costs a bounded helper process when nothing is running, contended to one
  at a time and cached; a failed helper is a stated `catalog_unavailable`, not an
  empty menu.
- A cached model list is a snapshot, not proof of the current process's catalog;
  the UI labels it, and a running job's own list wins.
- Validation is per-request against a fresh catalog, so an unlisted value can never
  reach Pi even if a caller submits arbitrary text.
- No persistence on the agent: the operator's last choice lives in the browser,
  not in the agent's state.

## Amendment to `docs/PROTOCOL.md`

Replace the first bullet under the skill table with a version that adds the
`model` field and states the equality bound, keeping the existing sentences about
`cwd` and the child environment. `session.models`, `session.set_model`,
`session.commands` and `session.status` are added to the skill table with their
exposures.
