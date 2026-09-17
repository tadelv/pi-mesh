// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile, retry, sleep } from "../src/index.js";

describe("shared utilities", () => {
  it("sleeps for at least the requested duration", async () => {
    const startedAt = Date.now();
    await sleep(20);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });

  it("retries failures and returns when a later attempt succeeds", async () => {
    let attempts = 0;
    const errors: Array<{ message: string; attempt: number }> = [];

    await expect(
      retry(
        async () => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error(`failure ${attempts}`);
          }
          return "ok";
        },
        {
          retries: 2,
          delayMs: 0,
          onError: (error, attempt) => {
            errors.push({
              message: (error as Error).message,
              attempt,
            });
          },
        },
      ),
    ).resolves.toBe("ok");

    expect(attempts).toBe(3);
    expect(errors).toEqual([
      { message: "failure 1", attempt: 1 },
      { message: "failure 2", attempt: 2 },
    ]);
  });

  it("rethrows the last error after retries are exhausted", async () => {
    const failure = new Error("final failure");
    let attempts = 0;

    await expect(
      retry(
        async () => {
          attempts += 1;
          throw failure;
        },
        { retries: 2, delayMs: 0 },
      ),
    ).rejects.toBe(failure);
    expect(attempts).toBe(3);
  });

  it("rejects immediately with an already-aborted signal reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    let called = false;

    await expect(
      retry(
        async () => {
          called = true;
          return "unexpected";
        },
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(called).toBe(false);
  });

  it("rejects with the abort reason when aborted while a call is in flight", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled in flight");

    await expect(
      retry(
        async () => {
          controller.abort(reason);
          throw new Error("boom");
        },
        { retries: 5, delayMs: 0, signal: controller.signal },
      ),
    ).rejects.toBe(reason);
  });

  it("treats a non-finite retry count as the default instead of looping forever", async () => {
    let attempts = 0;

    await expect(
      retry(
        async () => {
          attempts += 1;
          throw new Error("nope");
        },
        { retries: Number.NaN, delayMs: 0 },
      ),
    ).rejects.toThrow("nope");
    expect(attempts).toBe(4);
  });

  it("reads valid JSON and preserves filesystem and parse errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-mesh-shared-"));
    const validPath = join(directory, "valid.json");
    const invalidPath = join(directory, "invalid.json");
    const missingPath = join(directory, "missing.json");

    try {
      await writeFile(validPath, JSON.stringify({ ready: true }), "utf8");
      await writeFile(invalidPath, "{not-json", "utf8");

      await expect(
        readJsonFile<{ ready: boolean }>(validPath),
      ).resolves.toEqual({
        ready: true,
      });
      await expect(readJsonFile(invalidPath)).rejects.toBeInstanceOf(
        SyntaxError,
      );
      await expect(readJsonFile(missingPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
