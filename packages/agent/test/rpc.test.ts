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

  it("reassembles records split across chunks", async () => {
    const rpc = makeClient("chunk");
    try {
      await expect(rpc.request({ type: "prompt" })).resolves.toMatchObject({
        value: "split",
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
            // A bound generous enough to survive a contended CI runner. This
            // asserts that a hang eventually FAILS rather than that the path
            // is fast: at 500ms a loaded machine can exceed the bound just
            // from spawning the stub, which makes the suite flaky and hides
            // real failures behind noise.
            setTimeout(() => reject(new Error("hung")), 10_000),
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

  it("drops fire-and-forget UI requests without an error or response", async () => {
    const rpc = makeClient("fire");
    const events: unknown[] = [];
    rpc.on("event", (event) => events.push(event));
    try {
      await expect(rpc.request({ type: "prompt" })).resolves.toMatchObject({
        value: "ok",
      });
      expect(events).toEqual([]);
    } finally {
      await rpc.close();
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
  options: { maxRecordBytes?: number } = {},
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
    logger: silentLogger,
    env: { ...process.env, PI_RPC_STUB_MODE: mode },
  });
}
