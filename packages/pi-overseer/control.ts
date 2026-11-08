// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Overseer control - turns a control verb into a pi-subagents RPC call.
 *
 * pi-subagents RPC lives on `pi.events` (process-local) and is ownership-scoped:
 * a run can only be steered/stopped by the session whose branch spawned it. So a
 * command always executes in the process hosting the owning session - locally
 * when we own the run, or in the peer session that received the broadcast.
 */

import { randomUUID } from "node:crypto";

export const SUBAGENT_RPC_REQUEST = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_READY = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_RPC_VERSION = 1;

export type Verb = "steer" | "stop" | "interrupt";

export const VERBS: readonly Verb[] = ["steer", "stop", "interrupt"];

export function isVerb(value: unknown): value is Verb {
  return value === "steer" || value === "stop" || value === "interrupt";
}

/** The subset of `pi.events` we use; keeps this module free of pi imports. */
export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface RpcResult {
  ok: boolean;
  detail: string;
  data?: unknown;
}

function summarize(data: unknown): string {
  if (data === undefined || data === null) return "ok";
  if (typeof data === "string") return data;
  const record = data as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.state === "string") return `state=${record.state}`;
  return "ok";
}

export function callSubagentRpc(
  bus: EventBus,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<RpcResult> {
  const requestId = randomUUID();
  return new Promise<RpcResult>((resolve) => {
    let settled = false;
    const finish = (result: RpcResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };
    const unsubscribe = bus.on(SUBAGENT_RPC_REPLY_PREFIX + requestId, (raw) => {
      const reply = raw as
        | {
            success?: boolean;
            data?: unknown;
            error?: { code?: string; message?: string };
          }
        | undefined;
      if (reply?.success) {
        finish({ ok: true, detail: summarize(reply.data), data: reply.data });
      } else {
        finish({
          ok: false,
          detail:
            reply?.error?.message ??
            "pi-subagents RPC failed without a message",
        });
      }
    });
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          detail: `pi-subagents RPC '${method}' timed out after ${timeoutMs}ms (run not live, not owned here, or pi-subagents absent)`,
        }),
      timeoutMs,
    );
    bus.emit(SUBAGENT_RPC_REQUEST, {
      version: SUBAGENT_RPC_VERSION,
      requestId,
      method,
      params,
    });
  });
}

/** RPC params per verb (rpc.js: steer needs a message; stop/interrupt take a target). */
export function rpcParams(
  verb: Verb,
  runId: string,
  text?: string,
): Record<string, unknown> {
  if (verb === "steer") return { id: runId, message: (text ?? "").trim() };
  return { id: runId };
}

export function executeLocalControl(
  bus: EventBus,
  verb: Verb,
  runId: string,
  text?: string,
): Promise<RpcResult> {
  if (verb === "steer" && !(text ?? "").trim()) {
    return Promise.resolve({
      ok: false,
      detail: "steer requires a non-empty message",
    });
  }
  return callSubagentRpc(bus, verb, rpcParams(verb, runId, text));
}
