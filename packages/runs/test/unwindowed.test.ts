// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { findRunDirsById, readRunState } from "../src/index.js";

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
    startedAt: NOW - 60_000,
    lastUpdate: NOW - 10_000,
    ...overrides,
  };
}

describe("findRunDirsById (M8-8 unwindowed lookup)", () => {
  it("finds an old terminal artifact outside the listing window", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "runs-unwindowed-"));
    const old = NOW - 30 * 24 * 60 * 60 * 1000;
    writeStatus(
      path.join(tmp, "pi-subagents-a", "async-subagent-runs", "old-dir"),
      validStatus({ runId: "run-old", state: "complete", lastUpdate: old }),
    );
    expect(findRunDirsById(tmp, "run-old")).toHaveLength(1);
    expect(findRunDirsById(tmp, "run-missing")).toEqual([]);
  });

  it("returns both dirs for an ambiguous id, sorted", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "runs-ambiguous-"));
    writeStatus(
      path.join(tmp, "pi-subagents-b", "async-subagent-runs", "dir-b"),
      validStatus({ runId: "run-dup" }),
    );
    writeStatus(
      path.join(tmp, "pi-subagents-a", "async-subagent-runs", "dir-a"),
      validStatus({ runId: "run-dup" }),
    );
    const matches = findRunDirsById(tmp, "run-dup");
    expect(matches).toHaveLength(2);
    expect(matches).toEqual([...matches].sort());
  });

  it("skips malformed and missing artifacts without throwing", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "runs-unwindowed-skip-"));
    const badDir = path.join(
      tmp,
      "pi-subagents-a",
      "async-subagent-runs",
      "bad",
    );
    mkdirSync(badDir, { recursive: true });
    writeFileSync(path.join(badDir, "status.json"), "{not json");
    expect(() => findRunDirsById(tmp, "run-1")).not.toThrow();
    expect(findRunDirsById(tmp, "run-1")).toEqual([]);
    expect(findRunDirsById("", "run-1")).toEqual([]);
  });
});

describe("readRunState (M8-8 fresh status read)", () => {
  it("reads an active state and reports I/O vs unrecognised distinctly", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "runs-readstate-"));
    const runDir = path.join(
      tmp,
      "pi-subagents-a",
      "async-subagent-runs",
      "run-1",
    );
    writeStatus(runDir, validStatus({ state: "paused" }));
    expect(readRunState(runDir)).toEqual({ ok: true, state: "paused" });

    const missing = path.join(
      tmp,
      "pi-subagents-a",
      "async-subagent-runs",
      "nope",
    );
    const io = readRunState(missing);
    expect(io.ok).toBe(false);
    if (!io.ok) expect(io.kind).toBe("io");

    const weirdDir = path.join(
      tmp,
      "pi-subagents-a",
      "async-subagent-runs",
      "weird",
    );
    writeStatus(weirdDir, { hello: "world" });
    const weird = readRunState(weirdDir);
    expect(weird.ok).toBe(false);
    if (!weird.ok) expect(weird.kind).toBe("unrecognised");
  });
});
