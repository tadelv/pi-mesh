// SPDX-License-Identifier: GPL-3.0-or-later

/** Mirrors the error-code table in docs/PROTOCOL.md. */
export const ErrorCode = {
  Unauthorized: -32001,
  UnknownSession: -32002,
  SpawnDenied: -32003,
  PeerUnreachable: -32004,
  HandoffRejected: -32005,
} as const;

export class PiMeshError extends Error {
  readonly code: number;
  private readonly data: unknown;

  constructor(code: number, message: string, options?: { cause?: unknown; data?: unknown }) {
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
