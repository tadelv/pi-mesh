// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Delegation, not duplication: the package's rule path must run the
 * module's own engine. These tests import `@pi-mesh/runs` and compare, so
 * a copied implementation that drifts cannot pass them. The fixture
 * exercises all five rules, so a stub (or a `return []` mutation) fails
 * the coverage clause by name.
 */

import { describe, expect, it } from "vitest";

import {
  evaluateRules as evaluateModuleRules,
  type Finding as ModuleFinding,
  type RunRecord as ModuleRunRecord,
} from "@pi-mesh/runs";
import type { Fleet, RunRecord } from "../discovery.js";
import {
  DEFAULT_RULES,
  evaluateModuleFindings,
  evaluateRules,
  toModuleConfig,
} from "../rules.js";

const NOW = 1_800_000_000_000;

function modRun(
  overrides: Partial<ModuleRunRecord> & { runId: string },
): ModuleRunRecord {
  return {
    runDir: `/tmp/overseer-delegation/${overrides.runId}`,
    state: "running",
    startedAt: NOW - 60_000,
    lastUpdate: NOW - 1_000,
    statusAgeMs: 1_000,
    steps: [],
    ...overrides,
  };
}

function fixtures(): ModuleRunRecord[] {
  const session = "/sessions/parent.jsonl";
  return [
    modRun({
      runId: "stale",
      lastUpdate: NOW - 10 * 60_000,
      statusAgeMs: 10 * 60_000,
    }),
    modRun({
      runId: "long",
      startedAt: NOW - 60 * 60_000,
    }),
    modRun({ runId: "usd", state: "complete", costUsd: 12.5 }),
    modRun({
      runId: "tokens",
      state: "complete",
      tokens: { input: 1_600_000, output: 800_000, total: 2_400_000 },
    }),
    modRun({
      runId: "f1",
      state: "failed",
      parentSessionFile: session,
      startedAt: NOW - 3_000,
    }),
    modRun({
      runId: "f2",
      state: "failed",
      parentSessionFile: session,
      startedAt: NOW - 2_000,
    }),
    modRun({
      runId: "f3",
      state: "failed",
      parentSessionFile: session,
      startedAt: NOW - 1_000,
    }),
    modRun({ runId: "quiet" }),
  ];
}

function toPackageFleet(modRuns: ModuleRunRecord[], now: number): Fleet {
  const runs: RunRecord[] = modRuns.map((m) => ({
    runId: m.runId,
    dir: m.runDir,
    state: m.state,
    live: false,
    liveness: { state: "unknown", reason: "no-pid", probedAt: now },
    pid: m.pid,
    parentSessionFile: m.parentSessionFile,
    agent: m.agent,
    startedAt: m.startedAt,
    lastActivityAt: m.lastUpdate,
    totalTokens: m.tokens?.total,
    totalCost: m.costUsd,
  }));
  return {
    generatedAt: now,
    sessions: [],
    runs,
    liveSessions: [],
    liveRuns: [],
    runsBySession: new Map(),
    externalRuns: [],
    totals: { tokens: 0, cost: 0 },
  };
}

describe("delegation, not duplication", () => {
  it("evaluates the fleet through the module's own rule engine", () => {
    const modRuns = fixtures();
    const fleet = toPackageFleet(modRuns, NOW);
    const viaPackage: ModuleFinding[] = evaluateModuleFindings(
      fleet,
      DEFAULT_RULES,
    );
    const direct: ModuleFinding[] = evaluateModuleRules(
      modRuns,
      toModuleConfig(DEFAULT_RULES),
      NOW,
    );
    expect(viaPackage).toEqual(direct);
  });

  it("covers all five rules, so a stub cannot pass it", () => {
    const found = evaluateModuleFindings(
      toPackageFleet(fixtures(), NOW),
      DEFAULT_RULES,
    )
      .map((f) => f.rule)
      .sort();
    expect(found).toEqual([
      "run-budget-tokens",
      "run-budget-usd",
      "run-long",
      "run-stale",
      "session-failure-streak",
    ]);
  });

  it("presents module findings without changing detection", () => {
    const findings = evaluateRules(
      toPackageFleet(fixtures(), NOW),
      DEFAULT_RULES,
    );
    expect(findings).toHaveLength(5);
    expect(findings.every((f) => f.action === "notify")).toBe(true);
  });

  it("a disabled config detects nothing", () => {
    expect(
      evaluateModuleFindings(toPackageFleet(fixtures(), NOW), {
        ...DEFAULT_RULES,
        enabled: false,
      }),
    ).toEqual([]);
  });
});
