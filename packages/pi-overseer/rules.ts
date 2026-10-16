// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Overseer rules - deterministic thresholds evaluated against the fleet.
 *
 * A rule only names a problem and suggests an action. Whether "steer" or "stop"
 * is actually executed is the caller's decision (config `action`), so the same
 * engine drives notify-only and auto-steer modes.
 */

import type { Fleet } from "./discovery.ts";
import { fmtDuration, fmtTokens, fmtUsd } from "./format.ts";

export type Action = "notify" | "steer" | "stop";
export type Severity = "info" | "warn" | "critical";

export interface RulesConfig {
  enabled: boolean;
  /** live run with no new activity for this long is "stuck" */
  staleMs: number;
  /** live run older than this is "long" */
  maxRuntimeMs: number;
  maxCostUsd: number;
  maxTokens: number;
  /** consecutive non-complete runs in one session before flagging */
  failureStreak: number;
  /** what a fired rule asks for; the caller may still downgrade to notify */
  action: Action;
}

export const DEFAULT_RULES: RulesConfig = {
  enabled: true,
  staleMs: 5 * 60_000,
  maxRuntimeMs: 30 * 60_000,
  maxCostUsd: 5,
  maxTokens: 2_000_000,
  failureStreak: 3,
  action: "notify",
};

export interface Finding {
  rule: string;
  severity: Severity;
  kind: "run" | "session";
  id: string;
  label: string;
  message: string;
  action: Action;
}

const FAILED_STATES = new Set(["failed", "timeout", "stopped", "error"]);

export function evaluateRules(fleet: Fleet, config: RulesConfig): Finding[] {
  const findings: Finding[] = [];
  if (!config.enabled) return findings;
  const now = fleet.generatedAt;

  for (const run of fleet.liveRuns) {
    const label = `${run.agent ?? "agent"} ${run.runId.slice(0, 8)}`;
    const base = { kind: "run" as const, id: run.runId, label, action: config.action };

    const idleMs = now - (run.lastActivityAt ?? run.startedAt ?? now);
    if (idleMs >= config.staleMs) {
      findings.push({
        ...base,
        rule: "run-stale",
        severity: idleMs >= config.staleMs * 3 ? "critical" : "warn",
        message: `no activity for ${fmtDuration(idleMs)}`,
      });
    }

    if (run.startedAt !== undefined && now - run.startedAt >= config.maxRuntimeMs) {
      findings.push({
        ...base,
        rule: "run-long",
        severity: "warn",
        message: `running for ${fmtDuration(now - run.startedAt)}`,
      });
    }

    if ((run.totalCost ?? 0) >= config.maxCostUsd) {
      findings.push({
        ...base,
        rule: "run-budget-usd",
        severity: "warn",
        message: `cost ${fmtUsd(run.totalCost)} ≥ ${fmtUsd(config.maxCostUsd)}`,
      });
    }

    if ((run.totalTokens ?? 0) >= config.maxTokens) {
      findings.push({
        ...base,
        rule: "run-budget-tokens",
        severity: "warn",
        message: `${fmtTokens(run.totalTokens)} tokens ≥ ${fmtTokens(config.maxTokens)}`,
      });
    }
  }

  for (const [sessionFile, runs] of fleet.runsBySession) {
    const failed = runs.filter((r) => FAILED_STATES.has(r.state));
    if (failed.length >= config.failureStreak) {
      findings.push({
        rule: "session-failure-streak",
        severity: "critical",
        kind: "session",
        id: sessionFile,
        label: sessionFile.split("/").pop() ?? sessionFile,
        message: `${failed.length} non-complete runs in this session`,
        action: config.action,
      });
    }
  }

  return findings;
}
