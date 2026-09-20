// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PiRpcChildExitError,
  PiRpcClient,
  PiRpcMalformedRecordError,
  PiRpcRecordTooLargeError,
} from "../src/rpc.js";

const fixture = fileURLToPath(
  new URL("./fixtures/rpc-stub.mjs", import.meta.url),
);

describe("Pi RPC client", () => {
  it("preserves U+2028 inside a JSON string", async () => {
    const rpc = makeClient("unicode");
    try {
      await expect(rpc.request({ type: "prompt" })).resolves.toMatchObject({
        value: "left\u2028right",
      });
    } finally {
      await rpc.close();
    }
  });

  it("reassembles records split inside a multi-byte character", async () => {
    // The chunk boundary lands in the middle of a 2-byte UTF-8 character and
    // the value contains U+2028, so this fails for a decoder that concatenates
    // strings before splitting, and for one built on readline.
    const rpc = makeClient("chunk");
    try {
      await expect(rpc.request({ type: "prompt" })).resolves.toMatchObject({
        value: "\u00e9\u2028\u00fc",
      });
    } finally {
      await rpc.close();
    }
  });

  it("refuses an over-size record with a distinct error", async () => {
    const rpc = makeClient("oversize", { maxRecordBytes: 32 });
    try {
      await expect(rpc.request({ type: "prompt" })).rejects.toBeInstanceOf(
        PiRpcRecordTooLargeError,
      );
    } finally {
      await rpc.close();
    }
  });

  it("does not match an unrelated response id and delivers interleaved events", async () => {
    const rpc = makeClient("mismatch");
    const events: unknown[] = [];
    rpc.on("event", (event) => events.push(event));
    try {
      await expect(rpc.request({ type: "prompt" })).resolves.toMatchObject({
        value: "right",
      });
      expect(events).toEqual([{ type: "event", value: "between" }]);
    } finally {
      await rpc.close();
    }
  });

  it("reports malformed records", async () => {
    const rpc = makeClient("malformed");
    try {
      await expect(rpc.request({ type: "prompt" })).rejects.toBeInstanceOf(
        PiRpcMalformedRecordError,
      );
    } finally {
      await rpc.close();
    }
  });

  it("reports child death instead of hanging", async () => {
    const rpc = makeClient("death");
    try {
      await expect(
        Promise.race([
          rpc.request({ type: "prompt" }),
          new Promise((_, reject) =>
            // Generous enough to survive a contended CI runner (the stub
            // spawns and parses in tens of ms), but BELOW vitest's default 5s
            // testTimeout: a bound above the harness timeout is dead code,
            // because the harness fails the test first and this message never
            // appears. 500ms was too tight here and made the suite flaky, which
            // is worse than slow - a flaky gate hides real failures.
            setTimeout(() => reject(new Error("hung")), 3_000),
          ),
        ]),
      ).rejects.toBeInstanceOf(PiRpcChildExitError);
    } finally {
      await rpc.close();
    }
  });

  it("answers a dialog with no timeout as cancelled and continues", async () => {
    const rpc = makeClient("dialog");
    try {
      await expect(rpc.request({ type: "prompt" })).resolves.toMatchObject({
        value: "continued",
      });
    } finally {
      await rpc.close();
    }
  });

  it("ignores a blank line instead of tearing down the session", async () => {
    // A descendant that inherits fd 1 can print a bare newline. Failing the
    // whole session and every pending request for that is disproportionate.
    const rpc = makeClient("blank");
    try {
      await expect(rpc.request({ type: "prompt" })).resolves.toMatchObject({
        value: "survived",
      });
    } finally {
      await rpc.close();
    }
  });

  it("surfaces Pi's error string rather than a generic message", async () => {
    // Pi reports failures as {"success":false,"error":"<string>"}. Reading
    // only an object `error` discarded every real diagnostic, which is the text
    // M2-5 needs to explain why a spawn failed.
    const rpc = makeClient("errorstring");
    try {
      await expect(rpc.request({ type: "prompt" })).rejects.toThrow(
        /Model not found: fixture-model/,
      );
    } finally {
      await rpc.close();
    }
  });

  it("bounds close() even when a descendant holds the stdio pipes", async () => {
    // The regression test for the blocking defect. The child exits while a
    // descendant keeps stdout open, so Node fires `exit` and never fires
    // `close`. Waiting on the close promise without a bound hangs shutdown
    // forever - the same failure M1 hit with server.stop(). close() must
    // return within its shutdown budget regardless.
    const rpc = makeClient("holdfd", { shutdownTimeoutMs: 200 });
    let stderr = "";
    rpc.on("stderr", (text: string) => (stderr += text));
    try {
      // A request is what triggers the mode: the fixture spawns the holder and
      // exits on the first command. Calling close() without one left the stub
      // sitting on stdin, so nothing held the pipe and the hazard never
      // materialised - which is why this test passed even with the unbounded
      // await restored.
      await expect(rpc.request({ type: "prompt" })).rejects.toBeInstanceOf(
        PiRpcChildExitError,
      );
      await expect(
        Promise.race([
          rpc.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("close() hung")), 3_000),
          ),
        ]),
      ).resolves.toBeUndefined();
    } finally {
      // The holder inherits our pipe on purpose, so it must be cleaned up or
      // the suite waits on an open handle.
      const holder = /holder=(\d+)/.exec(stderr);
      if (holder !== null) {
        try {
          process.kill(Number(holder[1]), "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
});

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeClient(
  mode: string,
  options: { maxRecordBytes?: number; shutdownTimeoutMs?: number } = {},
): PiRpcClient {
  return new PiRpcClient({
    piBinary: process.execPath,
    binaryArgs: [fixture],
    sessionDir: process.cwd(),
    name: "rpc-test",
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    ...(options.maxRecordBytes === undefined
      ? {}
      : { maxRecordBytes: options.maxRecordBytes }),
    ...(options.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    logger: silentLogger,
    env: { ...process.env, PI_RPC_STUB_MODE: mode },
  });
}
