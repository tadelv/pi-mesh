// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  A2A_FIELDS,
  A2A_SOURCE,
  type AgentCapabilities,
  type AgentCard,
  type AgentInterface,
  type Artifact,
  type Message,
  type MessageSendParams,
  type Part,
  type SendMessageConfiguration,
  type StreamResponse,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatus,
  type TaskStatusUpdateEvent,
} from "../src/index.js";

const protoPath = new URL("../spec/a2a.proto", import.meta.url);

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

const agentInterfaceKeys: Assert<
  Equal<keyof AgentInterface, (typeof A2A_FIELDS.AgentInterface)[number]>
> = true;
const agentCardKeys: Assert<
  Equal<keyof AgentCard, (typeof A2A_FIELDS.AgentCard)[number]>
> = true;
const capabilitiesKeys: Assert<
  Equal<keyof AgentCapabilities, (typeof A2A_FIELDS.AgentCapabilities)[number]>
> = true;
const taskKeys: Assert<Equal<keyof Task, (typeof A2A_FIELDS.Task)[number]>> =
  true;
const taskStatusKeys: Assert<
  Equal<keyof TaskStatus, (typeof A2A_FIELDS.TaskStatus)[number]>
> = true;
const partKeys: Assert<Equal<keyof Part, (typeof A2A_FIELDS.Part)[number]>> =
  true;
const messageKeys: Assert<
  Equal<keyof Message, (typeof A2A_FIELDS.Message)[number]>
> = true;
const artifactKeys: Assert<
  Equal<keyof Artifact, (typeof A2A_FIELDS.Artifact)[number]>
> = true;
const statusEventKeys: Assert<
  Equal<
    keyof TaskStatusUpdateEvent,
    (typeof A2A_FIELDS.TaskStatusUpdateEvent)[number]
  >
> = true;
const artifactEventKeys: Assert<
  Equal<
    keyof TaskArtifactUpdateEvent,
    (typeof A2A_FIELDS.TaskArtifactUpdateEvent)[number]
  >
> = true;
const streamKeys: Assert<
  Equal<keyof StreamResponse, (typeof A2A_FIELDS.StreamResponse)[number]>
> = true;
const sendParamsKeys: Assert<
  Equal<keyof MessageSendParams, (typeof A2A_FIELDS.SendMessageRequest)[number]>
> = true;
const sendConfigurationKeys: Assert<
  Equal<
    keyof SendMessageConfiguration,
    (typeof A2A_FIELDS.SendMessageConfiguration)[number]
  >
> = true;

void [
  agentInterfaceKeys,
  agentCardKeys,
  capabilitiesKeys,
  taskKeys,
  taskStatusKeys,
  partKeys,
  messageKeys,
  artifactKeys,
  statusEventKeys,
  artifactEventKeys,
  streamKeys,
  sendParamsKeys,
  sendConfigurationKeys,
];

function skipTrivia(source: string, offset: number): number {
  let index = offset;
  while (index < source.length) {
    if (/\s/.test(source[index] ?? "")) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    break;
  }
  return index;
}

function identifierAt(
  source: string,
  offset: number,
): { value: string; end: number } | undefined {
  const start = skipTrivia(source, offset);
  if (!/[A-Za-z_]/.test(source[start] ?? "")) return undefined;
  let end = start + 1;
  while (/[A-Za-z0-9_]/.test(source[end] ?? "")) end += 1;
  return { value: source.slice(start, end), end };
}

function messageBodies(source: string): Map<string, string> {
  const messages = new Map<string, string>();
  let offset = 0;
  while (offset < source.length) {
    const token = identifierAt(source, offset);
    if (token === undefined) {
      offset += 1;
      continue;
    }
    offset = token.end;
    if (token.value !== "message") continue;
    const name = identifierAt(source, offset);
    if (name === undefined) continue;
    const opening = skipTrivia(source, name.end);
    if (source[opening] !== "{") continue;

    let depth = 1;
    let index = opening + 1;
    let quote = false;
    let escaped = false;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quote = false;
        index += 1;
        continue;
      }
      if (source.startsWith("//", index)) {
        const newline = source.indexOf("\n", index + 2);
        index = newline < 0 ? source.length : newline + 1;
        continue;
      }
      if (source.startsWith("/*", index)) {
        const end = source.indexOf("*/", index + 2);
        index = end < 0 ? source.length : end + 2;
        continue;
      }
      if (character === '"') quote = true;
      else if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      index += 1;
    }
    messages.set(name.value, source.slice(opening + 1, index - 1));
    offset = index;
  }
  return messages;
}

function fieldNames(body: string): string[] {
  const withoutComments = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const fields: string[] = [];
  for (const line of withoutComments.split("\n")) {
    const match = line.match(
      /^\s*(?:(?:optional|repeated)\s+)?(?:map<[^>]+>|[A-Za-z_][\w.]*)\s+([A-Za-z_]\w*)\s*=\s*\d+/,
    );
    if (match?.[1] !== undefined) fields.push(match[1]);
  }
  return fields;
}

function lowerCamelCase(name: string): string {
  return name.replace(/_([a-z])/g, (_, character: string) =>
    character.toUpperCase(),
  );
}

describe("pinned A2A wire conformance", () => {
  it("keeps the vendored source hash and every message field set in sync", async () => {
    const source = await readFile(protoPath, "utf8");
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      A2A_SOURCE.sha256,
    );

    const parsed = new Map<string, string[]>();
    for (const [name, body] of messageBodies(source)) {
      parsed.set(name, fieldNames(body).map(lowerCamelCase));
    }
    expect([...parsed.keys()].sort()).toEqual(Object.keys(A2A_FIELDS).sort());
    for (const name of Object.keys(A2A_FIELDS) as Array<
      keyof typeof A2A_FIELDS
    >) {
      expect(parsed.get(name)).toEqual([...A2A_FIELDS[name]]);
    }
  });
});
