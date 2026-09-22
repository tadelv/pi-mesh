// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Human-readable rendering for `stream --follow`.
 *
 * This is driven only by event shapes that are actually documented - Pi's RPC
 * reference for `message_update.assistantMessageEvent`, and this repository's own
 * session entry shape - so nothing here guesses a field name. That has a cost:
 * an event this file does not recognise is ignored rather than printed as
 * mystery JSON, so adding `--follow` can hide information that the raw mode
 * shows. Raw frames remain one flag away (`stream` without `--follow`), and that
 * is the mode to use when something looks wrong.
 *
 * Text goes to stdout and thinking goes to stderr, so `stream --follow > out.txt`
 * captures the answer rather than the reasoning.
 */
export interface FollowWriter {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Unwrap the A2A stream response down to the frame the server sent. */
function frameOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const message = (value as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return undefined;
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    if (typeof part !== "object" || part === null || !("data" in part))
      continue;
    const data = (part as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) continue;
    const result = (data as { result?: unknown }).result;
    if (typeof result === "object" && result !== null)
      return result as Record<string, unknown>;
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A live frame is the raw Pi RPC event, tagged by the server. */
function renderLive(
  event: Record<string, unknown>,
  writer: FollowWriter,
): void {
  if (event.type === "turn_end" || event.type === "agent_settled") {
    writer.stdout("\n");
    return;
  }
  if (event.type !== "message_update") return;
  const update = event.assistantMessageEvent;
  if (typeof update !== "object" || update === null) return;
  const delta = update as Record<string, unknown>;
  if (delta.type === "text_delta") {
    const body = text(delta.delta);
    if (body !== undefined) writer.stdout(body);
    return;
  }
  if (delta.type === "thinking_delta") {
    const body = text(delta.delta);
    if (body !== undefined) writer.stderr(body);
    return;
  }
  if (delta.type === "toolcall_start") {
    const name = text(delta.toolName);
    if (name !== undefined) writer.stdout(`\n[${name}]\n`);
  }
}

/** A file frame is a session entry, so it carries a whole message. */
function renderFile(
  entry: Record<string, unknown>,
  writer: FollowWriter,
): void {
  if (entry.type !== "message") return;
  const message = entry.message;
  if (typeof message !== "object" || message === null) return;
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (!Array.isArray(content)) return;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const piece = part as { type?: unknown; text?: unknown };
    if (piece.type !== "text") continue;
    const body = text(piece.text);
    if (body !== undefined) parts.push(body);
  }
  if (parts.length === 0) return;
  writer.stdout(`${text(role) ?? "message"}: ${parts.join("\n")}\n`);
}

export function renderFollowFrame(value: unknown, writer: FollowWriter): void {
  const frame = frameOf(value);
  if (frame === undefined) return;
  if (frame.source === "live") renderLive(frame, writer);
  else if (frame.source === "file") renderFile(frame, writer);
}
