# ADR 0019 — Resuming a saved session must warn about concurrent writers

Status: accepted (operator requested resume with an explicit corruption warning; verified against installed Pi 0.87.1)

## Context

The dashboard shows durable Pi session files, including sessions started in a local TUI. It only prompts a session when the agent owns a running job (ADR 0016). Pi can open an existing file with `--session <path>`, but pi-mesh cannot determine from the file whether an independently started TUI is still writing to it. Pi loads its own in-memory view and appends to the file; two writers can diverge and hide each other's work, and a version migration rewrites the file. A recent timestamp does not prove liveness, and an old timestamp does not prove safety. This was verified against Pi 0.87.1: `docs/cli.md` documents `--session <path|id>` for an exact session while `-r` opens a selector; `dist/core/session-manager.js` loads entries into each process independently (`:665-684`), appends entries (`:785-814`), and can truncate/rewrite a file on migration (`:717-764`). A temporary-file probe opened one file in two Pi SessionManagers and observed two independent in-memory leaves with the same parent; a real Pi RPC `get_state` launched with `--session <file>` returned the saved session ID. This shows a concrete branch conflict, not proof that every concurrent open corrupts bytes.

## Decision

Offer **Resume** as a separate action on a selected, agent-verified saved session, never as an implicit Send to a cached transcript. Refuse Resume if this agent already has a running or starting job for that session; use Prompt instead. Before each resume, show an inline warning and require an unchecked-by-default confirmation:

> **This writes to the existing Pi session file.** pi-mesh cannot tell whether a separate Pi TUI is still using it. Resuming while that TUI is active may corrupt the session or lose conversation history. Close the other Pi session before continuing. If you cannot confirm it has exited, do not resume this file.
>
> [ ] I have closed any other Pi process using this session file and understand the risk.

Do not infer that the file is safe from age, a successful read, or an empty agent job list; the confirmation records the operator's assertion, not proof. Direct mesh callers have no dashboard warning, so the agent also requires `acknowledge_concurrent_writers: true` on every `session.resume` call and refuses an omitted value before spawning. This acknowledgement is an accident guard, not evidence that an external Pi process has exited or another execution grant. Keep the action unavailable while the agent is unreachable, the selected session cannot be verified with it, its execution opt-in is closed, or dashboard execution transport is refused. The agent must locate exactly one session by ID itself, validate the existing file under its configured sessions root and its cwd inside the configured workspace, and start a **new managed RPC job** for that exact file using Pi's `--session` option. Never accept a browser-supplied filesystem path, attach to an unowned PID, or create a process in the control plane. The existing agent execution gate, job bounds, and dashboard token/transport rules apply. Concurrent Resume requests for one file must not start two writers, even while the first Pi job is still starting. Only after the agent returns a job ID and its running state is confirmed can the existing `session.steer` path offer Prompt.

This **resumes a saved conversation**, not a running external TUI process. The warning is necessary because the agent cannot enforce exclusive ownership against external Pi processes. A future fork/copy action or cooperative live-TUI attachment is a separate decision; neither is implied by Resume.
