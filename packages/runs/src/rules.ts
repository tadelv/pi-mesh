// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Threshold evaluation over discovered runs: the five rules the upstream
 * overseer extension uses (ADR 0021 context).
 *
 * Pure function, no I/O: findings carry what produced them but re-arm and
 * delivery state lives in the caller's volatile evaluator map
 * (ADR 0021 decision 4), not here.
 */

import {
  isActiveRunState,
  type Finding,
  type RulesConfig,
  type RunRecord,
} from "./types.js";

export const DEFAULT_RULES: RulesConfig = {
  staleMs: 5 * 60 * 1000,
  longMs: 30 * 60 * 1000,
  maxCostUsd: 5,
  maxTokens: 2_000_000,
  failureStreak: 3,
};

function staleAgeMs(run: RunRecord, now: number): number {
  return Math.max(0, now - (run.lastUpdate ?? run.startedAt));
}

/**
 * Evaluate every rule over `runs` at `now`. A run that is not active can
 * still trip the budget rules, but never the stale/long rules; an active
 * run's age is reported, never rendered as failure by the caller.
 */
export function evaluateRules(
  runs: RunRecord[],
  config: RulesConfig,
  now: number,
): Finding[] {
  const findings: Finding[] = [];
  for (const run of runs) {
    const active = isActiveRunState(run.state);
    if (active) {
      const ageMs = staleAgeMs(run, now);
      if (ageMs > config.staleMs) {
        findings.push({
          rule: "run-stale",
          runId: run.runId,
          summary:
            `Run ${run.runId} has not updated for ${Math.round(ageMs / 1000)}s ` +
            `(stale after ${Math.round(config.staleMs / 1000)}s).`,
          observedAt: now,
          actual: ageMs,
          threshold: config.staleMs,
        });
      }
      const runAgeMs = Math.max(0, now - run.startedAt);
      if (runAgeMs > config.longMs) {
        findings.push({
          rule: "run-long",
          runId: run.runId,
          summary:
            `Run ${run.runId} has been active for ${Math.round(runAgeMs / 60000)}min ` +
            `(long after ${Math.round(config.longMs / 60000)}min).`,
          observedAt: now,
          actual: runAgeMs,
          threshold: config.longMs,
        });
      }
    }
    if (run.costUsd !== undefined && run.costUsd > config.maxCostUsd) {
      findings.push({
        rule: "run-budget-usd",
        runId: run.runId,
        summary:
          `Run ${run.runId} cost $${run.costUsd.toFixed(2)} ` +
          `(budget $${config.maxCostUsd.toFixed(2)}).`,
        observedAt: now,
        actual: run.costUsd,
        threshold: config.maxCostUsd,
      });
    }
    if (run.tokens !== undefined && run.tokens.total > config.maxTokens) {
      findings.push({
        rule: "run-budget-tokens",
        runId: run.runId,
        summary:
          `Run ${run.runId} used ${run.tokens.total} tokens ` +
          `(budget ${config.maxTokens}).`,
        observedAt: now,
        actual: run.tokens.total,
        threshold: config.maxTokens,
      });
    }
  }
  // Session failure streak: per parent session, trailing consecutive
  // failures in start-time order. Any non-failed run breaks the streak;
  // a failed observation (missing data) never counts as clearing.
  const bySession = new Map<string, RunRecord[]>();
  for (const run of runs) {
    if (run.parentSessionFile === undefined) {
      continue;
    }
    const group = bySession.get(run.parentSessionFile) ?? [];
    group.push(run);
    bySession.set(run.parentSessionFile, group);
  }
  const sessions = [...bySession.keys()].sort();
  for (const sessionFile of sessions) {
    const group = (bySession.get(sessionFile) ?? []).sort((a, b) =>
      a.startedAt === b.startedAt
        ? a.runId < b.runId
          ? -1
          : a.runId > b.runId
            ? 1
            : 0
        : a.startedAt - b.startedAt,
    );
    let streak = 0;
    for (let index = group.length - 1; index >= 0; index -= 1) {
      if (group[index]?.state === "failed") {
        streak += 1;
      } else {
        break;
      }
    }
    if (streak >= config.failureStreak) {
      findings.push({
        rule: "session-failure-streak",
        sessionFile,
        summary:
          `Session ${sessionFile} has ${streak} consecutive failed runs ` +
          `(streak ${config.failureStreak}).`,
        observedAt: now,
        actual: streak,
        threshold: config.failureStreak,
      });
    }
  }
  return findings;
}
