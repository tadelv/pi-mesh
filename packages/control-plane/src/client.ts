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
