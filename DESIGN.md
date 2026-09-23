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

- Monospace stack: `ui-monospace`, Cascadia Code, Source Code Pro, Menlo, Consolas, DejaVu Sans Mono.
- Transcript base: 12px / 18px. Timestamps and navigation metadata: 10px. Tabular numerals for times and IDs.
- A 320px fixed, independently scrolling session sidebar sits beside the main scrolling column; below 760px the sidebar becomes a shallow top region.
- Session text measures at most 75ch and wraps long tokens and paths.

## Primitives

- Session row: name and project basename on one line, relative update time below, selected state on the Pi-style selected field.
- Transcript entry: role/type plus timestamp, then readable text; user, assistant, metadata, tool call, and tool result each have distinct surfaces.
- Tool calls, tool results, and thinking payloads use native collapsed `<details>` disclosure.
- Session info and model changes are compact labeled entries; cache state remains explicit.
- Controls use native buttons, labeled inputs, visible keyboard focus, and high-contrast light/dark tokens.
