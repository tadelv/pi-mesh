// SPDX-License-Identifier: GPL-3.0-or-later

import { appendFileSync, writeFileSync } from "node:fs";
import { stdin, stdout } from "node:process";

const mode = globalThis.process.env.MODEL_STUB_MODE ?? "catalog";
const models = [
  { id: "exact-model-v1", provider: "fixture-provider", name: "Fixture Exact" },
];
// What a running Pi reports for get_commands. A stub that answered `[]` would
// let a fetch removed entirely still pass, so the fixture returns a real list.
const commands = [
  { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
  { name: "skill:deploy", description: "Deploy the service", source: "skill" },
];
// Lets a test observe that the child really terminated (teardown, shutdown).
if (globalThis.process.env.MODEL_STUB_PID) {
  writeFileSync(
    globalThis.process.env.MODEL_STUB_PID,
    String(globalThis.process.pid),
  );
}
let buffer = "";
function respond(command, data) {
  stdout.write(
    `${JSON.stringify({ type: "response", id: command.id, success: true, data })}\n`,
  );
}
function handle(line) {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    respond(command, { sessionId: "123e4567-e89b-42d3-a456-426614174099" });
    return;
  }
  if (command.type === "get_available_models") {
    if (globalThis.process.env.MODEL_STUB_COUNT)
      appendFileSync(globalThis.process.env.MODEL_STUB_COUNT, "spawn\n");
    if (mode === "hang") return;
    if (mode === "fail") {
      stdout.write(
        `${JSON.stringify({ type: "response", id: command.id, success: false, error: "catalog fixture failure" })}\n`,
      );
      return;
    }
    respond(command, { models: mode === "empty" ? [] : models });
    return;
  }
  if (command.type === "get_commands") {
    respond(command, { commands });
    return;
  }
  if (command.type === "set_model") {
    if (mode === "refuse-set") {
      // A refusal for a WELL-FORMED request, which is the only way to prove
      // Pi's message survives the transport: a shape-refusal would be a
      // different code path.
      stdout.write(
        `${JSON.stringify({ type: "response", id: command.id, success: false, error: "Model not found: fixture-provider/exact-model-v1" })}\n`,
      );
      return;
    }
    // Deliberately EXACT: this fixture refuses what real Pi refuses - an
    // unlisted or fuzzy model name is "Model not found", not a success. A
    // fixture that answered any string would hide a wire-format or equality bug
    // forever (AGENTS.md: a fixture must refuse what reality refuses).
    if (
      command.provider !== "fixture-provider" ||
      command.modelId !== "exact-model-v1"
    ) {
      stdout.write(
        `${JSON.stringify({ type: "response", id: command.id, success: false, error: `Model not found: ${String(command.provider)}/${String(command.modelId)}` })}\n`,
      );
      return;
    }
    if (globalThis.process.env.MODEL_STUB_COMMANDS)
      appendFileSync(
        globalThis.process.env.MODEL_STUB_COMMANDS,
        `${JSON.stringify({ type: command.type, provider: command.provider, modelId: command.modelId })}\n`,
      );
    respond(command, models[0]);
    return;
  }
  stdout.write(
    `${JSON.stringify({ type: "response", id: command.id, success: false, error: `Unknown command: ${JSON.stringify(command)}` })}\n`,
  );
}
stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    handle(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
  }
});
stdin.on("end", () => globalThis.process.exit(0));
