// SPDX-License-Identifier: GPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  A2A_PROTOCOL_VERSION,
  PI_MESH_HEADERS,
  createNonce,
  signRequest,
} from "@pi-mesh/protocol";
import type { SessionSummary } from "@pi-mesh/protocol";

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
    throw new Error(`Agent returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Agent returned an invalid JSON-RPC response");
  const rpc = value as Record<string, unknown>;
  if (rpc.error !== undefined) {
    const error = rpc.error as Record<string, unknown>;
    throw new Error(
      `JSON-RPC error ${String(error?.code)}: ${String(error?.message)}`,
    );
  }
  const result = rpc.result as
    { message?: { parts?: Array<{ data?: { result?: T } }> } } | undefined;
  return result?.message?.parts?.[0]?.data?.result as T;
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
