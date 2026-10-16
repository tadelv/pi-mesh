// SPDX-License-Identifier: GPL-3.0-or-later

import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { discoverRuns } from "../src/index.js";

const NOW = 1_800_000_000_000;

function writeStatus(runDir: string, status: unknown): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "status.json"), JSON.stringify(status));
}

function validStatus(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId: "run-1",
    state: "running",
    pid: 4242,
    sessionId: "/sessions/parent.jsonl",
    sessionFile: "/sessions/parent/uuid/run-0/session.jsonl",
    mode: "single",
    startedAt: NOW - 60_000,
    lastUpdate: NOW - 10_000,
    steps: [{ agent: "researcher", status: "running" }],
    totalTokens: { input: 100, output: 50, total: 150 },
    totalCost: { inputTokens: 100, outputTokens: 50, costUsd: 0.02 },
    ...overrides,
  };
}

describe("discoverRuns", () => {
  it("maps a valid status.json and skips malformed or unrecognised runs without writing", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "runs-discover-"));
    const root = path.join(tmp, "pi-subagents-test", "async-subagent-runs");
    writeStatus(path.join(root, "run-1"), validStatus());
    const badDir = path.join(root, "run-bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(path.join(badDir, "status.json"), "{not json");
    const weirdDir = path.join(root, "run-weird");
    writeStatus(weirdDir, { hello: "world" });
    const emptyDir = path.join(root, "run-empty");
    mkdirSync(emptyDir, { recursive: true });
    const before = new Map<string, string[]>();
    for (const dir of [badDir, weirdDir, emptyDir]) {
      before.set(dir, readdirSync(dir).sort());
    }

    const result = discoverRuns({ tmp, now: NOW, maxAgeMs: 24 * 3600 * 1000 });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      runId: "run-1",
      state: "running",
      pid: 4242,
      parentSessionFile: "/sessions/parent.jsonl",
      childSessionFile: "/sessions/parent/uuid/run-0/session.jsonl",
      agent: "researcher",
      mode: "single",
      costUsd: 0.02,
    });
    expect(result.runs[0]?.tokens).toEqual({
      input: 100,
      output: 50,
      total: 150,
    });
    expect(result.runs[0]?.steps).toEqual([
      { index: 0, agent: "researcher", status: "running" },
    ]);
    const reasons = new Map(
      result.skipped.map((s) => [path.basename(s.runDir), s.reason]),
    );
    expect(reasons.get("run-bad")).toBe("malformed-status.json");
    expect(reasons.get("run-weird")).toBe("unrecognised-shape");
    expect(reasons.get("run-empty")).toBe("missing-status.json");
    // Skipped directories were never written to.
    for (const dir of [badDir, weirdDir, emptyDir]) {
      expect(readdirSync(dir).sort()).toEqual(before.get(dir));
    }
  });

  it("returns empty without throwing when the tmp root is missing", () => {
    const tmp = path.join(tmpdir(), `runs-missing-${Date.now()}-nodir`);
    expect(() => discoverRuns({ tmp, now: NOW, maxAgeMs: 1000 })).not.toThrow();
    expect(discoverRuns({ tmp, now: NOW, maxAgeMs: 1000 })).toEqual({
      runs: [],
      skipped: [],
    });
  });

  it("omits a terminal run older than the window but keeps an older active run", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "runs-window-"));
    const root = path.join(tmp, "pi-subagents-test", "async-subagent-runs");
    writeStatus(
      path.join(root, "old-done"),
      validStatus({
        runId: "old-done",
        state: "complete",
        lastUpdate: NOW - 3600_000,
      }),
    );
    writeStatus(
      path.join(root, "old-live"),
      validStatus({
        runId: "old-live",
        state: "running",
        lastUpdate: NOW - 3600_000,
      }),
    );

    const result = discoverRuns({ tmp, now: NOW, maxAgeMs: 60_000 });

    expect(result.runs.map((r) => r.runId)).toEqual(["old-live"]);
    expect(result.skipped.map((s) => s.reason)).toContain("outside-window");
  });

  it("lists newest first by last update, runId breaking ties", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "runs-order-"));
    const root = path.join(tmp, "pi-subagents-test", "async-subagent-runs");
    writeStatus(
      path.join(root, "run-old"),
      validStatus({ runId: "run-old", lastUpdate: NOW - 5000 }),
    );
    writeStatus(
      path.join(root, "run-new"),
      validStatus({ runId: "run-new", lastUpdate: NOW - 1000 }),
    );
    writeStatus(
      path.join(root, "run-tie-b"),
      validStatus({ runId: "run-tie-b", lastUpdate: NOW - 1000 }),
    );
    writeStatus(
      path.join(root, "run-tie-a"),
      validStatus({ runId: "run-tie-a", lastUpdate: NOW - 1000 }),
    );

    const result = discoverRuns({ tmp, now: NOW, maxAgeMs: 60_000 });

    expect(result.runs.map((r) => r.runId)).toEqual([
      "run-new",
      "run-tie-a",
      "run-tie-b",
      "run-old",
    ]);
  });

  it("parses the written steer file only through the reader, not by hand", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "runs-roundtrip-"));
    const root = path.join(tmp, "pi-subagents-test", "async-subagent-runs");
    const runDir = path.join(root, "run-9");
    writeStatus(runDir, validStatus({ runId: "run-9" }));
    const result = discoverRuns({ tmp, now: NOW, maxAgeMs: 60_000 });
    expect(result.runs).toHaveLength(1);
    const raw = JSON.parse(
      readFileSync(path.join(runDir, "status.json"), "utf8"),
    ) as {
      runId: string;
    };
    expect(result.runs[0]?.runId).toBe(raw.runId);
  });
});
