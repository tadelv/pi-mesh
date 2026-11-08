// SPDX-License-Identifier: GPL-3.0-or-later

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MAX_STEER_MESSAGE_BYTES,
  stopRun,
  writeSteerRequest,
} from "../src/index.js";

const NOW = 1_800_000_000_000;

function makeRunDir(tag: string): string {
  const runDir = path.join(
    mkdtempSync(path.join(tmpdir(), `runs-${tag}-`)),
    "run-1",
  );
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, "status.json"),
    JSON.stringify({ runId: "run-1", state: "running", startedAt: NOW - 1000 }),
  );
  return runDir;
}

function steerFiles(runDir: string): string[] {
  const dir = path.join(runDir, "control", "steer-requests");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function stopFiles(runDir: string): string[] {
  const dir = path.join(runDir, "control", "stop-requests");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("writeSteerRequest", () => {
  it("writes a file that parses and matches upstream's shape and bounds", () => {
    const runDir = makeRunDir("steer-ok");
    const result = writeSteerRequest(
      runDir,
      { message: "  keep going  ", id: "req-1", ts: NOW },
      { installedVersion: "0.78.0" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.path).toMatch(
      /control[/\\]steer-requests[/\\]\d{13}-cmVxLTE\.json$/,
    );
    const payload = JSON.parse(readFileSync(result.path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      type: "steer",
      id: "req-1",
      ts: NOW,
      message: "keep going",
    });
    expect(typeof payload["ts"]).toBe("number");
    expect(
      Buffer.byteLength(payload["message"] as string, "utf8"),
    ).toBeLessThanOrEqual(MAX_STEER_MESSAGE_BYTES);
  });

  it("a pre-existing closed marker refuses with no file left behind", () => {
    const runDir = makeRunDir("steer-closed");
    mkdirSync(path.join(runDir, "control"), { recursive: true });
    writeFileSync(
      path.join(runDir, "control", "steer-inbox-closed.json"),
      JSON.stringify({ version: 1 }),
    );
    const result = writeSteerRequest(runDir, { message: "hello" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("steer-inbox-closed");
    expect(steerFiles(runDir)).toEqual([]);
  });

  it("a marker appearing after the write removes the request and refuses", () => {
    const runDir = makeRunDir("steer-race");
    const checks: number[] = [];
    const result = writeSteerRequest(
      runDir,
      { message: "hello", id: "race-1", ts: NOW },
      {
        // Closed on the second (post-write) check only: a pre-write-only
        // implementation would report success here.
        isInboxClosed: () => {
          checks.push(checks.length);
          return checks.length > 1;
        },
      },
    );
    expect(checks).toHaveLength(2);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("steer-inbox-closed");
    const dir = path.join(runDir, "control", "steer-requests");
    const expectedName = `${String(NOW).padStart(13, "0")}-${Buffer.from("race-1").toString("base64url")}.json`;
    expect(existsSync(path.join(dir, expectedName))).toBe(false);
    // No request and no leftover temp file.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses malformed requests without writing", () => {
    const runDir = makeRunDir("steer-bad");
    expect(writeSteerRequest(runDir, { message: "   " }).ok).toBe(false);
    expect(
      writeSteerRequest(runDir, {
        message: "x".repeat(MAX_STEER_MESSAGE_BYTES + 1),
      }).ok,
    ).toBe(false);
    expect(
      writeSteerRequest(runDir, { message: "hi", id: "has space" }).ok,
    ).toBe(false);
    expect(writeSteerRequest(runDir, { message: "hi", ts: 0 }).ok).toBe(false);
    expect(steerFiles(runDir)).toEqual([]);
    // Exactly at the bound still passes.
    const atBound = writeSteerRequest(runDir, {
      message: "x".repeat(MAX_STEER_MESSAGE_BYTES),
    });
    expect(atBound.ok).toBe(true);
  });
});

describe("stopRun", () => {
  it("writes exactly one stop request for a live run", () => {
    const runDir = makeRunDir("stop-ok");
    const result = stopRun(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(stopFiles(runDir)).toHaveLength(1);
    const payload = JSON.parse(
      readFileSync(result.requestPath, "utf8"),
    ) as Record<string, unknown>;
    expect(payload["type"]).toBe("stop");
  });

  it("converts the closed-inbox throw into a typed refusal with no file", () => {
    const runDir = makeRunDir("stop-closed");
    mkdirSync(path.join(runDir, "control"), { recursive: true });
    writeFileSync(
      path.join(runDir, "control", "stop-inbox-closed.json"),
      JSON.stringify({ version: 1 }),
    );
    let result: ReturnType<typeof stopRun> | undefined;
    expect(() => {
      result = stopRun(runDir);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result === undefined || result.ok) {
      throw new Error("expected a refusal from a closed stop inbox");
    }
    expect(result.code).toBe("stop-inbox-closed");
    expect(stopFiles(runDir)).toEqual([]);
  });
});

describe("version gate", () => {
  it("an injected unsupported version refuses instead of writing", () => {
    const runDir = makeRunDir("version-stop");
    const stopped = stopRun(runDir, { installedVersion: "0.77.0" });
    expect(stopped.ok).toBe(false);
    expect(stopped.ok ? "" : stopped.code).toBe("unsupported-version");
    const steered = writeSteerRequest(
      runDir,
      { message: "hello" },
      { installedVersion: "9.9.9" },
    );
    expect(steered.ok).toBe(false);
    expect(steered.ok ? "" : steered.code).toBe("unsupported-version");
    expect(existsSync(path.join(runDir, "control"))).toBe(false);
  });

  it("an unrecognised layout refuses instead of writing", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "runs-layout-"));
    const stopped = stopRun(runDir);
    expect(stopped.ok).toBe(false);
    expect(stopped.ok ? "" : stopped.code).toBe("unrecognised-layout");
    expect(existsSync(path.join(runDir, "control"))).toBe(false);
  });
});
