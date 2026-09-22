// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderFollowFrame } from "../src/follow.js";
import { run } from "../src/cli.js";

/** Wrap a frame the way the server puts one on the wire. */
function wire(result: unknown): unknown {
  return {
    message: {
      messageId: "m",
      role: "ROLE_AGENT",
      parts: [{ data: { result } }],
    },
  };
}

function update(event: Record<string, unknown>): unknown {
  return wire({
    type: "message_update",
    assistantMessageEvent: event,
    source: "live",
  });
}

function capture(): {
  stdout: () => string;
  stderr: () => string;
  writer: {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
  };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    writer: {
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
    },
  };
}

describe("follow rendering", () => {
  it("writes a text delta to stdout, and nothing to stderr", () => {
    const out = capture();
    renderFollowFrame(
      update({ type: "text_delta", delta: "Hello " }),
      out.writer,
    );
    expect(out.stdout()).toBe("Hello ");
    expect(out.stderr()).toBe("");
  });

  it("keeps thinking on stderr so stdout stays the answer", () => {
    const out = capture();
    renderFollowFrame(
      update({ type: "thinking_delta", delta: "weighing it" }),
      out.writer,
    );
    expect(out.stdout()).toBe("");
    expect(out.stderr()).toBe("weighing it");
  });

  it("names a tool as it starts, on its own line", () => {
    const out = capture();
    renderFollowFrame(
      update({ type: "toolcall_start", id: "c1", toolName: "read" }),
      out.writer,
    );
    expect(out.stdout()).toBe("\n[read]\n");
  });

  it("ends a turn with a newline so consecutive turns do not run together", () => {
    const out = capture();
    renderFollowFrame(wire({ type: "turn_end", source: "live" }), out.writer);
    expect(out.stdout()).toBe("\n");
  });

  it("renders a durable entry as role-prefixed text", () => {
    const out = capture();
    renderFollowFrame(
      wire({
        type: "message",
        id: "e1",
        source: "file",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      }),
      out.writer,
    );
    expect(out.stdout()).toBe("assistant: hello\n");
  });

  it("stays silent on what it does not know, rather than printing JSON", () => {
    const out = capture();
    renderFollowFrame(
      update({ type: "toolcall_delta", delta: '{"path":' }),
      out.writer,
    );
    renderFollowFrame(
      wire({ type: "queue_update", source: "live" }),
      out.writer,
    );
    renderFollowFrame(wire({ type: "message", source: "file" }), out.writer);
    expect(out.stdout()).toBe("");
    expect(out.stderr()).toBe("");
  });

  it("refuses a value that is not a stream response", () => {
    const out = capture();
    for (const value of [{ type: "message_update" }, undefined, "nope", 42]) {
      renderFollowFrame(value, out.writer);
    }
    expect(out.stdout()).toBe("");
    expect(out.stderr()).toBe("");
  });

  it("rejects --follow anywhere but stream", async () => {
    const stderr: string[] = [];
    const code = await run(["doctor", "--follow"], {
      stdout: { write: () => true },
      stderr: {
        write: (text: string) => {
          stderr.push(text);
          return true;
        },
      },
    });
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("--follow is only valid with stream");
  });

  it("accepts --follow with stream", async () => {
    const stderr: string[] = [];
    const code = await run(["stream"], {
      stdout: { write: () => true },
      stderr: {
        write: (text: string) => {
          stderr.push(text);
          return true;
        },
      },
    });
    // No session id is a usage error, but it must be the *id* that is missing,
    // not --follow being refused.
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("stream requires a session id");
  });
});
