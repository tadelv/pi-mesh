// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PiRpcChildExitError,
  PiRpcClient,
  PiRpcEofError,
  PiRpcMalformedRecordError,
  PiRpcRecordTooLargeError,
  PiRpcTimeoutError,
} from "../src/rpc.js";

const fixture = fileURLToPath(
  new URL("./fixtures/rpc-stub.mjs", import.meta.url),
);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll the real process table: init reaps an orphan slightly later. */
async function waitForGone(pid: number, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

describe("Pi RPC client", () => {
  it("opens the requested existing session file instead of a session directory", async () => {
    const sessionFile = "/tmp/exact-session.jsonl";
    const rpc = makeClient("unicode", { sessionFile });
    try {
      expect(rpc.argv).toContain("--session");
      expect(rpc.argv).toContain(sessionFile);
      expect(rpc.argv).not.toContain("--session-dir");
    } finally {
      await rpc.close();
    }
  });

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
      const error = await Promise.race([
        rpc.request({ type: "prompt" }),
        new Promise((_, reject) =>
          // Generous enough to survive a contended CI runner (the stub spawns
          // and parses in tens of ms), but BELOW vitest's default 5s
          // testTimeout: a bound above the harness timeout is dead code,
          // because the harness fails the test first and this message never
          // appears.
          setTimeout(() => reject(new Error("hung")), 3_000),
        ),
      ]).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      // Which death report arrives is a RACE, not a fact about the client:
      // the child's `exit` event and its stdout reaching EOF are unordered, and
      // CI on Linux resolves it the other way round from macOS. Asserting one
      // of them made this fail on CI while passing locally, which is exactly
      // what this test is not for. Both are death diagnoses; the property worth
      // pinning is that a dead child is not mislabelled as a SLOW one.
      expect(error).not.toBeInstanceOf(PiRpcTimeoutError);
      expect(
        error instanceof PiRpcChildExitError || error instanceof PiRpcEofError,
      ).toBe(true);
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

  it("stops the session's descendants, not just the session", async () => {
    // The reason the child is spawned in its own process group. A pid-only
    // signal reaches the session and nothing else, and the leftovers are then
    // unfindable: the kernel reparents them to init the moment the session dies
    // (measured, docs/GOTCHAS.md). Reverting signalChild to `child.kill()` fails
    // here with the grandchild still alive.
    const rpc = makeClient("tree");
    let stderr = "";
    rpc.on("stderr", (text: string) => (stderr += text));
    try {
      await rpc.request({ type: "prompt" });
      const grandchild = Number(/grandchild=(\d+)/.exec(stderr)?.[1]);
      expect(grandchild).toBeGreaterThan(0);
      expect(isAlive(grandchild)).toBe(true);
      await rpc.close();
      expect(await waitForGone(grandchild)).toBe(true);
    } finally {
      const grandchild = Number(/grandchild=(\d+)/.exec(stderr)?.[1]);
      if (grandchild > 0) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
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
  options: {
    maxRecordBytes?: number;
    shutdownTimeoutMs?: number;
    sessionFile?: string;
  } = {},
): PiRpcClient {
  return new PiRpcClient({
    piBinary: process.execPath,
    binaryArgs: [fixture],
    sessionDir: process.cwd(),
    ...(options.sessionFile === undefined
      ? {}
      : { sessionFile: options.sessionFile }),
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
