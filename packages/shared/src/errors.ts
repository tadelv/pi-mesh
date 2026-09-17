// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Mirrors the error-code table in docs/PROTOCOL.md.
 *
 * These sit above -32000 deliberately: A2A reserves -32001..-32099 for its
 * own errors (TaskNotFoundError, TaskNotCancelableError, ...) and pi-mesh
 * carries A2A over the same JSON-RPC channel. See ADR 0005.
 *
 * Only genuine application errors are listed. A rejected handoff is an A2A
 * task state (TASK_STATE_REJECTED) and an unreachable peer is a transport
 * failure; neither is an RPC error, and modelling them as one would give a
 * single condition two representations.
 */
export const ErrorCode = {
  Unauthorized: -32100,
  UnknownSession: -32101,
  SpawnDenied: -32102,
} as const;

export class PiMeshError extends Error {
  readonly code: number;
  private readonly data: unknown;

  constructor(
    code: number,
    message: string,
    options?: { cause?: unknown; data?: unknown },
  ) {
    super(message);
    this.name = "PiMeshError";
    this.code = code;
    this.data = options?.data;
    if (options !== undefined && "cause" in options) {
      this.cause = options.cause;
    }
  }

  toJSON(): { code: number; message: string; data?: unknown } {
    const result: { code: number; message: string; data?: unknown } = {
      code: this.code,
      message: this.message,
    };
    if (this.data !== undefined) {
      result.data = this.data;
    }
    return result;
  }
}

export function isPiMeshError(value: unknown): value is PiMeshError {
  return value instanceof PiMeshError;
}
