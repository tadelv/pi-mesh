# Dashboard design system

The dashboard borrows Pi's exported session transcript grammar; the stylesheet source is `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.css` and `template.html`. This is an operator surface: keep navigation dense and stable while making the transcript readable.

## Tokens

| Token | Light | Dark | Role |
|---|---|---|---|
| `--text` | `#20262b` | `#e4e8ea` | Primary transcript and controls |
| `--dim` | `#56616a` | `#b3bdc3` | Supporting text and timestamps |
| `--muted` | `#697680` | `#9ba7ae` | Secondary metadata |
| `--body-bg` | `#f5f6f7` | `#1c2023` | Scrolling page field |
| `--container-bg` | `#ffffff` | `#24292d` | Sidebar and toolbar |
| `--info-bg` | `#edf0f2` | `#2b3135` | Neutral entry surface |
| `--accent` | `#176b86` | `#82c9df` | Active navigation and focus |
| `--userMessageBg` | `#e7f0f3` | `#29383e` | User transcript entry |
| `--toolSuccessBg` | `#e8f2ed` | `#263730` | Tool result |
| `--toolErrorBg` | `#f8e9e7` | `#3b2c2b` | Failed tool result |

## Typography and layout

- UI chrome uses the system sans stack (`system-ui`, Segoe UI, Roboto, Helvetica); the transcript, paths, ids and command output use a monospace stack (`ui-monospace`, Cascadia Code, Source Code Pro, Menlo, Consolas, DejaVu Sans Mono). The transcript still borrows Pi's grammar; the shell around it does not.
- Dashboard base: 13px / 19px in the UI face; transcript bodies: 14px / 21px monospace. Transcript entry metadata, including timestamps: 11px. Tabular numerals for times and ids.
- Fixed-height shell: a 300px session sidebar, the transcript column, and a 360px agent/jobs panel, each scrolling independently. The composer is docked to the bottom of the transcript column so it never scrolls out of reach.
- Below 1000px the three panes collapse to one at a time; the header's Sessions and Agents buttons switch panes, and opening a session selects the transcript.
- Session text measures at most 75ch and wraps long tokens and paths.

## Primitives

- Session row: name and project basename on one line, relative update time below, selected state on the Pi-style selected field.
- Transcript entry: role/type plus timestamp, then readable text; user, assistant, metadata, tool call, and tool result each have distinct surfaces.
- Tool calls, tool results, and thinking payloads use native collapsed `<details>` disclosure.
- Session info and model changes are compact labeled entries; cache state remains explicit.
- Controls use native buttons, labeled inputs, visible keyboard focus, and high-contrast light/dark tokens.
- The selected transcript ends in a composer docked to the bottom of its column, above it the model control, or a specific unavailability reason; statuses distinguish sending, agent acceptance, an observed turn with unverified origin, and unconfirmed delivery. Only short statuses are announced, not the whole log.
- Beside the composer, a session status line shows Pi's reported model, thinking level and context usage as a snapshot, or `context: unknown` when Pi reports none - never 0% or a full bar. Command hints list the reported names with their descriptions and an insert-as-completion control; a hint is labelled advisory and never reported as executed.
- Agent management remains separate: each agent is a card whose header carries its name, address, a status chip (execution enabled / not advertised / capability unknown) and a job count. Start offers agent-scoped cached project values through a native datalist and asks for inline confirmation before spawning; the pending state blocks duplicate starts, while the returned job/session/PID or refusal stays visible beside that agent.

## Working on the dashboard

The markup is `packages/control-plane/src/dashboard.html`, served as-is; `dashboard.ts` is
only a loader. `pnpm -r build` copies the file beside the compiled module for the real
server.

To iterate without a mesh:

    pnpm -r build        # once, for the store and server the script imports
    pnpm dashboard:dev   # http://127.0.0.1:7331, dashboard token `dev`

`scripts/dashboard-dev.mjs` runs the control plane against real `HttpAgentServer`s from
`@pi-mesh/agent`, backed by fixture session files and a fake job handle, plus one
paired-but-unreachable agent. No mDNS, no pairing handshake and no real Pi are involved,
but capabilities, sessions, jobs, transcripts and the model catalog all travel the real
wire, so the execution controls are genuinely enabled for the reachable agents and
unknown for the offline one. It reads `src/dashboard.html` on every request, so an edit
is a browser refresh, no rebuild. A state that must be visible here belongs in
`scripts/dashboard-fixtures.mjs`, not in a live agent.
