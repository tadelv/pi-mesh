// SPDX-License-Identifier: GPL-3.0-or-later

import { stdin, stdout } from "node:process";

const mode = globalThis.process.env.PI_RPC_STUB_MODE;
let buffer = "";
let dialogCommand;

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
    if (dialogCommand === undefined) {
      throw new Error(
        `client sent extension_ui_response for ${JSON.stringify(command.id)} with no dialog pending`,
      );
    }
    const pending = dialogCommand;
    dialogCommand = undefined;
    if (command.cancelled !== true) throw new Error("dialog was not cancelled");
    response(pending.id, { value: "continued" });
    return;
  }
  if (command.type === "shutdown") {
    response(command.id);
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
    const text = JSON.stringify({
      type: "response",
      id: command.id,
      value: "split",
    });
    stdout.write(text.slice(0, 8));
    globalThis.setTimeout(() => stdout.write(`${text.slice(8)}\n`), 10);
    return;
  }
  if (mode === "mismatch") {
    write({ type: "response", id: "not-the-request", value: "wrong" });
    write({ type: "event", value: "between" });
    globalThis.setTimeout(() => response(command.id, { value: "right" }), 10);
    return;
  }
  if (mode === "dialog") {
    dialogCommand = command;
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
