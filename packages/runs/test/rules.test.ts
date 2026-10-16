// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { DEFAULT_RULES, evaluateRules, type RunRecord } from "../src/index.js";

const NOW = 1_800_000_000_000;

function run(overrides: Partial<RunRecord> & { runId: string }): RunRecord {
  return {
    runDir: `/tmp/x/${overrides.runId}`,
    state: "running",
    startedAt: NOW - 60_000,
    lastUpdate: NOW - 1000,
    statusAgeMs: 1000,
    steps: [],
    ...overrides,
  };
}

describe("DEFAULT_RULES", () => {
  it("carries the upstream overseer thresholds", () => {
    expect(DEFAULT_RULES).toEqual({
      staleMs: 5 * 60 * 1000,
      longMs: 30 * 60 * 1000,
      maxCostUsd: 5,
      maxTokens: 2_000_000,
      failureStreak: 3,
    });
  });
});

describe("evaluateRules", () => {
  it("flags a stale active run and clears a fresh one", () => {
    const stale = run({ runId: "s", lastUpdate: NOW - 10 * 60 * 1000 });
    const fresh = run({ runId: "f", lastUpdate: NOW - 1000 });
    const findings = evaluateRules([stale, fresh], DEFAULT_RULES, NOW);
    expect(
      findings.filter((f) => f.rule === "run-stale").map((f) => f.runId),
    ).toEqual(["s"]);
  });

  it("flags a long active run", () => {
    const findings = evaluateRules(
      [
        run({
          runId: "l",
          startedAt: NOW - 60 * 60 * 1000,
          lastUpdate: NOW - 1000,
        }),
      ],
      DEFAULT_RULES,
      NOW,
    );
    expect(findings.map((f) => f.rule)).toContain("run-long");
  });

  it("flags budget crossings even on terminal runs", () => {
    const findings = evaluateRules(
      [
        run({
          runId: "b",
          state: "complete",
          costUsd: 12.5,
          tokens: { input: 1_500_000, output: 900_000, total: 2_400_000 },
        }),
      ],
      DEFAULT_RULES,
      NOW,
    );
    expect(findings.map((f) => f.rule).sort()).toEqual([
      "run-budget-tokens",
      "run-budget-usd",
    ]);
  });

  it("raises session-failure-streak only on consecutive trailing failures", () => {
    const session = "/sessions/p.jsonl";
    const failed = (id: string, at: number): RunRecord =>
      run({
        runId: id,
        state: "failed",
        parentSessionFile: session,
        startedAt: at,
      });
    expect(
      evaluateRules(
        [failed("a", 1), failed("b", 2), failed("c", 3)],
        DEFAULT_RULES,
        NOW,
      ).map((f) => f.rule),
    ).toContain("session-failure-streak");
    // A success after the failures breaks the streak.
    const broken = evaluateRules(
      [
        failed("a", 1),
        failed("b", 2),
        run({
          runId: "ok",
          state: "complete",
          parentSessionFile: session,
          startedAt: 3,
        }),
      ],
      DEFAULT_RULES,
      NOW,
    );
    expect(broken.map((f) => f.rule)).not.toContain("session-failure-streak");
    // Two is below the streak of three.
    const short = evaluateRules(
      [failed("a", 1), failed("b", 2)],
      DEFAULT_RULES,
      NOW,
    );
    expect(short.map((f) => f.rule)).not.toContain("session-failure-streak");
  });

  it("a quiet fleet produces no findings", () => {
    expect(evaluateRules([run({ runId: "q" })], DEFAULT_RULES, NOW)).toEqual(
      [],
    );
  });
});
