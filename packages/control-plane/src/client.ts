// SPDX-License-Identifier: GPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_ROUTE,
  PI_MESH_HEADERS,
  createNonce,
  signRequest,
} from "@pi-mesh/protocol";
import type { SessionSummary } from "@pi-mesh/protocol";

export class AgentSkillError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentSkillError";
  }
}

export class AgentUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnreachableError";
  }
}

export interface AgentTarget {
  peerId: string;
  host: string;
  port: number;
  credential: string;
}
export interface CallOptions {
  controlId: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

function credentialBytes(credential: string): Uint8Array {
  if (credential.length % 4 !== 0)
    throw new TypeError("Agent credential must be canonical base64");
  const bytes = Buffer.from(credential, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== credential)
    throw new TypeError("Agent credential must be canonical base64");
  return bytes;
}

export async function callAgent<T = unknown>(
  target: AgentTarget,
  skill: string,
  input: unknown,
  options: CallOptions,
): Promise<T> {
  try {
    const key = credentialBytes(target.credential);
    const request = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message/send",
      params: {
        message: { role: "ROLE_USER", parts: [{ data: { skill, input } }] },
      },
    };
    const body = JSON.stringify(request);
    const nonce = createNonce();
    const timestamp = new Date().toISOString();
    const signature = signRequest(key, {
      method: "POST",
      path: "/",
      body,
      peerId: options.controlId,
      recipientPeerId: target.peerId,
      nonce,
      timestamp,
    });
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const response = await fetchImpl(
      `http://${target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host}:${target.port}/`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "A2A-Version": A2A_PROTOCOL_VERSION,
          [PI_MESH_HEADERS.peer]: options.controlId,
          [PI_MESH_HEADERS.nonce]: nonce,
          [PI_MESH_HEADERS.timestamp]: timestamp,
          [PI_MESH_HEADERS.signature]: signature,
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      },
    );
    if (response.status !== 200)
      throw new AgentUnreachableError(`Agent returned HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new AgentUnreachableError(
        "Agent returned an invalid JSON-RPC response",
      );
    const rpc = value as Record<string, unknown>;
    if (rpc.jsonrpc !== "2.0" || rpc.id !== request.id)
      throw new AgentUnreachableError(
        "Agent returned an invalid JSON-RPC response",
      );
    if (rpc.error !== undefined) {
      const error = rpc.error;
      if (
        typeof error !== "object" ||
        error === null ||
        Array.isArray(error) ||
        typeof (error as Record<string, unknown>).code !== "number" ||
        typeof (error as Record<string, unknown>).message !== "string"
      ) {
        throw new AgentUnreachableError(
          "Agent returned a malformed JSON-RPC error",
        );
      }
      const rpcError = error as { code: number; message: string };
      throw new AgentSkillError(rpcError.code, rpcError.message);
    }
    if (!("result" in rpc))
      throw new AgentUnreachableError(
        "Agent returned an invalid JSON-RPC response",
      );
    const envelope = rpc.result as
      { message?: { parts?: Array<{ data?: { result?: T } }> } } | undefined;
    const result = envelope?.message?.parts?.[0]?.data?.result;
    if (result === undefined)
      throw new AgentUnreachableError(
        "Agent returned an invalid JSON-RPC result",
      );
    return result;
  } catch (error) {
    if (
      error instanceof AgentSkillError ||
      error instanceof AgentUnreachableError
    )
      throw error;
    throw new AgentUnreachableError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function fetchAgentCard(
  target: AgentTarget,
  options: CallOptions,
): Promise<{ name?: string; skills: string[] } | undefined> {
  try {
    const host =
      target.host.includes(":") && !target.host.startsWith("[")
        ? `[${target.host}]`
        : target.host;
    const response = await (options.fetch ?? globalThis.fetch)(
      `http://${host}:${target.port}${AGENT_CARD_ROUTE}`,
      { signal: AbortSignal.timeout(options.timeoutMs ?? 3000) },
    );
    if (response.status !== 200) return undefined;
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    const card = value as { name?: unknown; skills?: unknown };
    if (
      !Array.isArray(card.skills) ||
      !card.skills.every(
        (skill) =>
          typeof skill === "object" &&
          skill !== null &&
          !Array.isArray(skill) &&
          typeof (skill as { id?: unknown }).id === "string",
      )
    ) {
      return undefined;
    }
    return {
      ...(typeof card.name === "string" ? { name: card.name } : {}),
      skills: card.skills.map((skill) => (skill as { id: string }).id),
    };
  } catch {
    return undefined;
  }
}

export async function fetchSessionList(
  target: AgentTarget,
  options: CallOptions,
): Promise<SessionSummary[]> {
  return callAgent<{ sessions: SessionSummary[] }>(
    target,
    "session.list",
    {},
    options,
  ).then((result) => result.sessions);
}

/** One unwrapped frame from an A2A `message/stream` response. */
export type AgentStreamFrame =
  { kind: "task"; task: unknown } | { kind: "message"; value: unknown };

/**
 * The streaming sibling of `callAgent`: consumes the agent's A2A
 * `message/stream` SSE response and yields each frame as it arrives. It stays a
 * read (ADR 0018 §2), so it signs with the paired credential exactly as
 * `callAgent` does and needs no execution grant.
 *
 * A refusal the agent writes BEFORE the SSE headers (a gated skill, an unknown
 * session) arrives as a JSON-RPC error body and throws `AgentSkillError` - a
 * distinct outcome, never an empty stream. A transport drop after frames have
 * arrived throws too; only a clean `response.end()` ends the generator, so a
 * caller cannot mistake a broken connection for a finished turn.
 */
export async function* streamAgent(
  target: AgentTarget,
  skill: string,
  input: unknown,
  options: CallOptions,
  signal?: AbortSignal,
): AsyncGenerator<AgentStreamFrame> {
  const key = credentialBytes(target.credential);
  const request = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "message/stream",
    params: {
      message: {
        messageId: randomUUID(),
        role: "ROLE_USER",
        parts: [{ data: { skill, input } }],
      },
    },
  };
  const body = JSON.stringify(request);
  const nonce = createNonce();
  const timestamp = new Date().toISOString();
  const signature = signRequest(key, {
    method: "POST",
    path: "/",
    body,
    peerId: options.controlId,
    recipientPeerId: target.peerId,
    nonce,
    timestamp,
  });
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `http://${target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host}:${target.port}/`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "A2A-Version": A2A_PROTOCOL_VERSION,
          [PI_MESH_HEADERS.peer]: options.controlId,
          [PI_MESH_HEADERS.nonce]: nonce,
          [PI_MESH_HEADERS.timestamp]: timestamp,
          [PI_MESH_HEADERS.signature]: signature,
        },
        body,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch (error) {
    if (signal?.aborted) return;
    throw new AgentUnreachableError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (response.status !== 200)
    throw new AgentUnreachableError(`Agent returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/event-stream")) {
    // The agent writes a JSON-RPC error here when it refuses before the SSE
    // headers. Surfacing it as AgentSkillError keeps "refused" distinct from
    // "streamed nothing".
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new AgentUnreachableError(
        "Agent returned a non-streaming, non-JSON response",
      );
    }
    throw rpcError(value, request.id);
  }
  const reader = response.body?.getReader();
  if (reader === undefined)
    throw new AgentUnreachableError("Agent returned an empty stream body");
  const decoder = new TextDecoder();
  let buffer = "";
  let frames = 0;
  try {
    for (;;) {
      const read = await reader.read().catch((error: unknown) => {
        if (signal?.aborted) throw streamClosed;
        throw error;
      });
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const record = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = record
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data.length > 0) {
          frames += 1;
          yield parseStreamFrame(data, request.id);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (error === streamClosed) return;
    if (
      error instanceof AgentSkillError ||
      error instanceof AgentUnreachableError
    )
      throw error;
    throw new AgentUnreachableError(
      `Agent stream ended unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (frames === 0)
    throw new AgentUnreachableError("Agent returned an empty stream response");
}

/** Internal sentinel: the caller aborted, so ending quietly is not an error. */
const streamClosed = Symbol("stream-closed");

function parseStreamFrame(data: string, requestId: string): AgentStreamFrame {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    throw new AgentUnreachableError("Agent returned invalid SSE JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new AgentUnreachableError("Agent returned a malformed SSE frame");
  const record = value as Record<string, unknown>;
  if (record.message !== undefined) {
    const message = record.message as {
      parts?: Array<{ data?: { result?: unknown } }>;
    };
    const result = message?.parts?.[0]?.data?.result;
    if (result === undefined)
      throw new AgentUnreachableError(
        "Agent returned a malformed stream message",
      );
    return { kind: "message", value: result };
  }
  if (record.task !== undefined) return { kind: "task", task: record.task };
  // A JSON-RPC error inside the stream is a refusal, not a data frame.
  if (record.error !== undefined) throw rpcError(value, requestId);
  throw new AgentUnreachableError("Agent returned a malformed SSE frame");
}

function rpcError(
  value: unknown,
  requestId: string,
): AgentSkillError | AgentUnreachableError {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return new AgentUnreachableError(
      "Agent returned an invalid JSON-RPC response",
    );
  const rpc = value as Record<string, unknown>;
  if (rpc.jsonrpc !== "2.0" || rpc.id !== requestId)
    return new AgentUnreachableError(
      "Agent returned an invalid JSON-RPC response",
    );
  const error = rpc.error;
  if (
    typeof error !== "object" ||
    error === null ||
    Array.isArray(error) ||
    typeof (error as Record<string, unknown>).code !== "number" ||
    typeof (error as Record<string, unknown>).message !== "string"
  )
    return new AgentUnreachableError(
      "Agent returned a malformed JSON-RPC error",
    );
  const rpcFailure = error as { code: number; message: string };
  return new AgentSkillError(rpcFailure.code, rpcFailure.message);
}
