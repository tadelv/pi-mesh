// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Overseer rules - deterministic thresholds evaluated against the fleet.
 *
 * Detection belongs to `@pi-mesh/runs`: this module maps the package
 * config onto the module's rules config, feeds it the fleet as module
 * records, and presents the module's findings with package severity and
 * delivery. A rule only names a problem and suggests an action. Whether
 * "steer" or "stop" is actually executed is the caller's decision (config
 * `action`), so the same engine drives notify-only and auto-steer modes.
 */

import {
  DEFAULT_RULES as MODULE_DEFAULT_RULES,
  evaluateRules as evaluateModuleRules,
  type Finding as ModuleFinding,
  type RunRecord as ModuleRunRecord,
  type RunState,
  type RulesConfig as ModuleRulesConfig,
} from "@pi-mesh/runs";
import type { Fleet, RunRecord } from "./discovery.ts";
import { baseName } from "./format.js";

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

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Package config -> module rules config. `maxRuntimeMs` is the module's
 * `longMs`; `enabled` and `action` have no module equivalent and stay
 * package-side (delivery, not detection).
 */
export function toModuleConfig(config: RulesConfig): ModuleRulesConfig {
  return {
    staleMs: num(config.staleMs, MODULE_DEFAULT_RULES.staleMs),
    longMs: num(config.maxRuntimeMs, MODULE_DEFAULT_RULES.longMs),
    maxCostUsd: num(config.maxCostUsd, MODULE_DEFAULT_RULES.maxCostUsd),
    maxTokens: num(config.maxTokens, MODULE_DEFAULT_RULES.maxTokens),
    failureStreak: num(
      config.failureStreak,
      MODULE_DEFAULT_RULES.failureStreak,
    ),
  };
}

/**
 * Fleet runs -> module records. Only rule-relevant fields cross the
 * boundary; presentation fields (cwd, liveness, window) stay here.
 */
export function toModuleRuns(fleet: Fleet, now: number): ModuleRunRecord[] {
  return fleet.runs.map((run: RunRecord): ModuleRunRecord => {
    const startedAt = typeof run.startedAt === "number" ? run.startedAt : now;
    const lastUpdate =
      typeof run.lastActivityAt === "number" ? run.lastActivityAt : undefined;
    const record: ModuleRunRecord = {
      runId: run.runId,
      runDir: run.dir,
      state: run.state as RunState,
      startedAt,
      statusAgeMs: Math.max(0, now - (lastUpdate ?? startedAt)),
      steps: [],
    };
    if (run.pid !== undefined) record.pid = run.pid;
    if (run.parentSessionFile !== undefined) {
      record.parentSessionFile = run.parentSessionFile;
    }
    if (run.childSessionFile !== undefined) {
      record.childSessionFile = run.childSessionFile;
    }
    if (run.agent !== undefined) record.agent = run.agent;
    if (run.mode !== undefined) record.mode = run.mode;
    if (run.endedAt !== undefined) record.endedAt = run.endedAt;
    if (lastUpdate !== undefined) record.lastUpdate = lastUpdate;
    if (run.totalTokens !== undefined) {
      record.tokens = { input: 0, output: 0, total: run.totalTokens };
    }
    if (run.totalCost !== undefined) record.costUsd = run.totalCost;
    return record;
  });
}

/**
 * The package's rule path, detection only: the fleet through the module's
 * own `evaluateRules`, imported - not copied - so a drifted duplicate
 * cannot satisfy the delegation test.
 */
export function evaluateModuleFindings(
  fleet: Fleet,
  config: RulesConfig,
): ModuleFinding[] {
  if (!config.enabled) return [];
  const now = fleet.generatedAt;
  return evaluateModuleRules(
    toModuleRuns(fleet, now),
    toModuleConfig(config),
    now,
  );
}

/** Severity is presentation and stays package-side. */
function severityFor(finding: ModuleFinding, config: RulesConfig): Severity {
  if (finding.rule === "session-failure-streak") return "critical";
  if (
    finding.rule === "run-stale" &&
    (finding.actual ?? 0) >= config.staleMs * 3
  ) {
    return "critical";
  }
  return "warn";
}

function toPackageFinding(
  finding: ModuleFinding,
  fleet: Fleet,
  config: RulesConfig,
): Finding {
  const agents = new Map(fleet.runs.map((r) => [r.runId, r.agent]));
  if (finding.runId !== undefined) {
    const runId = finding.runId;
    const agent = agents.get(runId) ?? "agent";
    return {
      rule: finding.rule,
      severity: severityFor(finding, config),
      kind: "run",
      id: runId,
      label: `${agent} ${runId.slice(0, 8)}`,
      message: finding.summary,
      action: config.action,
    };
  }
  const sessionFile = finding.sessionFile ?? "?";
  return {
    rule: finding.rule,
    severity: severityFor(finding, config),
    kind: "session",
    id: sessionFile,
    label: baseName(sessionFile),
    message: finding.summary,
    action: config.action,
  };
}

export function evaluateRules(fleet: Fleet, config: RulesConfig): Finding[] {
  if (!config.enabled) return [];
  return evaluateModuleFindings(fleet, config).map((f) =>
    toPackageFinding(f, fleet, config),
  );
}
