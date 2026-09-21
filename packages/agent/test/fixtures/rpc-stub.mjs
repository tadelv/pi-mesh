// SPDX-License-Identifier: GPL-3.0-or-later

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { stdin, stdout } from "node:process";

const mode = globalThis.process.env.PI_RPC_STUB_MODE;
let buffer = "";
let pendingDialogId;
let pendingPrompt;

function write(value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

function response(id, data = {}) {
  write({ type: "response", id, ...data });
}

function handle(line) {
  const command = JSON.parse(line);
  if (command.type === "extension_ui_response") {
    // A response is only legal for a DIALOG method, and only while one is
    // pending. Answering a fire-and-forget request (notify, setStatus,
    // setWidget, setTitle, set_editor_text) is a protocol error that Pi would
    // never ask for, so the stub refuses it loudly - otherwise a client that
    // answered everything would still pass every test here.
    if (pendingDialogId === undefined) {
      throw new Error(
        `client sent extension_ui_response for ${JSON.stringify(command.id)} with no dialog pending`,
      );
    }
    if (command.id !== pendingDialogId) {
      // Real Pi keys the waiting dialog on the DIALOG's id and silently drops
      // an unmatched response (rpc-mode.js). A client that echoes the wrong id
      // hangs the session forever - and without this check the test still
      // passed, because the stub answered anything at all while a dialog was
      // pending. Note the dialog's id is not the prompt's id.
      throw new Error(
        `client answered dialog ${JSON.stringify(pendingDialogId)} with id ${JSON.stringify(command.id)}`,
      );
    }
    if (command.cancelled !== true) throw new Error("dialog was not cancelled");
    const answered = pendingPrompt;
    pendingDialogId = undefined;
    pendingPrompt = undefined;
    response(answered.id, { value: "continued" });
    return;
  }
  if (command.type === "shutdown") {
    // Real Pi 0.85.1 has NO shutdown command: it answers
    // {"success":false,"error":"Unknown command: shutdown"}. This stub used to
    // implement one, which made the suite exercise a protocol Pi does not
    // speak and hid the fact that the client's "graceful shutdown" stage was
    // fiction. Modelling the refusal is the point.
    write({
      type: "response",
      id: command.id,
      command: "shutdown",
      success: false,
      error: "Unknown command: shutdown",
    });
    return;
  }
  if (mode === "errorstring") {
    // Pi's real failure envelope carries `error` as a STRING, verified against
    // the binary: {"success":false,"error":"Unknown command: shutdown"}.
    write({
      type: "response",
      id: command.id,
      command: "prompt",
      success: false,
      error: "Model not found: fixture-model",
    });
    return;
  }
  if (mode === "blank") {
    // A descendant sharing fd 1 can print a bare newline. Pi's own client
    // ignores non-JSON lines; tearing the session down for this would fail
    // every pending request because something printed a blank line.
    stdout.write("\n");
    globalThis.setTimeout(() => response(command.id, { value: "survived" }), 5);
    return;
  }
  if (mode === "holdfd") {
    // Exit while a descendant still holds stdout. This is the real hazard
    // behind the close() fix: Node fires `exit` but never `close`, because the
    // pipe is still open, so an unbounded wait on the close promise hangs
    // shutdown forever. Spawn a child that inherits our stdout and outlives us.
    const holder = spawn(
      globalThis.process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      {
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    holder.unref();
    // Publish the holder's pid on stderr so a test can clean it up. Without
    // that the holder outlives the suite and vitest waits on the open pipe. It
    // is deliberately long-lived: a holder that exits inside the test's own
    // bound would let an unbounded close() pass by finishing in time, which is
    // exactly how this reproduction failed to discriminate the first time.
    globalThis.process.stderr.write(`[fixture] holder=${holder.pid}\n`);
    globalThis.setImmediate(() => globalThis.process.exit(0));
    return;
  }
  if (mode === "oversize") {
    stdout.write(`${"x".repeat(256)}\n`);
    return;
  }
  if (mode === "malformed") {
    stdout.write("{not-json}\n");
    return;
  }
  if (mode === "death") {
    globalThis.process.exit(17);
    return;
  }
  if (mode === "unicode") {
    response(command.id, { value: "left\u2028right" });
    return;
  }
  if (mode === "chunk") {
    // Split INSIDE a multi-byte character, and include U+2028, which
    // JSON.stringify does not escape. Splitting at an ASCII boundary (as this
    // stub used to, at character 8) lets a naive chunk.toString()
    // implementation pass, and that implementation corrupts the record exactly
    // here - a byte-buffer decoder is only correct because of this case.
    const text = `${JSON.stringify({ type: "response", id: command.id, value: "\u00e9\u2028\u00fc" })}\n`;
    const bytes = Buffer.from(text, "utf8");
    const splitAt = bytes.indexOf(0xc3) + 1; // the middle of the 2-byte e-acute
    if (splitAt <= 0) throw new Error("fixture: multi-byte marker not found");
    stdout.write(bytes.subarray(0, splitAt));
    globalThis.setTimeout(() => stdout.write(bytes.subarray(splitAt)), 10);
    return;
  }
  if (mode === "mismatch") {
    write({ type: "response", id: "not-the-request", value: "wrong" });
    write({ type: "event", value: "between" });
    globalThis.setTimeout(() => response(command.id, { value: "right" }), 10);
    return;
  }
  if (mode === "dialog") {
    pendingDialogId = "dialog-1";
    pendingPrompt = command;
    write({ type: "extension_ui_request", id: "dialog-1", method: "confirm" });
    return;
  }
  if (mode === "fire") {
    write({
      type: "extension_ui_request",
      id: "status-1",
      method: "setStatus",
      status: "busy",
    });
    globalThis.setTimeout(() => response(command.id, { value: "ok" }), 10);
    return;
  }
  response(command.id, { value: command.value ?? null });
}

stdin.setEncoding("utf8");
// Pi exits cleanly when its stdin ends: that is the real graceful shutdown
// path, and the client now uses it instead of a command Pi does not have.
stdin.on("end", () => {
  if (mode === "ignoreterm") return;
  globalThis.setImmediate(() => globalThis.process.exit(0));
});

if (mode === "ignoreterm") {
  globalThis.process.on("SIGTERM", () => undefined);
  // Load-bearing, not decoration: without a ref'd handle the process would exit
  // as soon as stdin ended, and the SIGKILL escalation stage would never be
  // exercised. Removing this silently changes what the escalation test covers.
  globalThis.setInterval(() => undefined, 1_000);
}
stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > 0) handle(line);
    newline = buffer.indexOf("\n");
  }
});
