// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { ErrorCode, PiMeshError, isPiMeshError } from "../src/index.js";

describe("PiMeshError", () => {
  it("exports the protocol error codes", () => {
    expect(ErrorCode).toEqual({
      Unauthorized: -32001,
      UnknownSession: -32002,
      SpawnDenied: -32003,
      PeerUnreachable: -32004,
      HandoffRejected: -32005,
    });
  });

  it("serializes code, message, and optional data", () => {
    const error = new PiMeshError(ErrorCode.UnknownSession, "missing", {
      cause: "upstream",
      data: { sessionId: "s-1" },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PiMeshError);
    expect(error.name).toBe("PiMeshError");
    expect(error.code).toBe(-32002);
    expect(error.message).toBe("missing");
    expect(error.toJSON()).toEqual({
      code: -32002,
      message: "missing",
      data: { sessionId: "s-1" },
    });
    expect((error as Error & { cause: unknown }).cause).toBe("upstream");
  });

  it("supports subclasses and type-guard checks", () => {
    class ChildError extends PiMeshError {}
    const child = new ChildError(ErrorCode.Unauthorized, "no access");

    expect(child).toBeInstanceOf(PiMeshError);
    expect(isPiMeshError(child)).toBe(true);
    expect(isPiMeshError(new Error("other"))).toBe(false);
    expect(isPiMeshError({ code: ErrorCode.Unauthorized })).toBe(false);
    expect(child.toJSON()).toEqual({ code: -32001, message: "no access" });
  });
});
