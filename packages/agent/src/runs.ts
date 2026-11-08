// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The runs plane: read-only views over pi-subagents async runs on this
 * machine, served as the ungated peer skills `run.list` and `run.findings`
 * (ADR 0021 decisions 1 and 4).
 *
 * Layout detection is evaluated once, when the skill registry is created
 * (agent startup): a machine with no pi-subagents run directory at all
 * serves neither skill until it is restarted. `docs/PROTOCOL.md` states the
 * restart rule rather than leaving it to be discovered.
 *
 * State: the plane holds no database and nothing on disk. It keeps the last
 * observation outcome (for `coverage`) and a bounded volatile suppression
 * map (notify once per finding per epoch, re-arm after it clears) - the one
 * in-memory map AGENTS.md permits. A restart is a new epoch and may notify
 * again; that is expected, not a bug.
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import { PiMeshError } from "@pi-mesh/shared";
import {
  DEFAULT_RULES,
  discoverRuns,
  evaluateRules,
  probeLiveness,
  type Finding as ModuleFinding,
  type Liveness,
  type ProbeLivenessDeps,
  type RunRecord,
  type RulesConfig,
} from "@pi-mesh/runs";

/** Terminal runs older than this (by status age) are omitted from listings. */
export const RUNS_LIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Upper bound on suppressed-finding keys held in one epoch. */
export const MAX_SUPPRESSED_FINDINGS = 1_000;

const RUNS_SCOPE_PREFIX = "pi-subagents-";
const RUNS_DIR_NAME = "async-subagent-runs";

/**
 * The temp root scanned for pi-subagents run directories. Overridable for
 * tests so no test depends on machine state; production always uses the
 * real temp directory.
 */
export function defaultRunsTmp(): string {
  return process.env.PI_MESH_RUNS_TMP ?? tmpdir();
}

/** `~/.pi-mesh/rules.json`: the operator's threshold overrides, when present. */
export function defaultRulesPath(): string {
  return join(homedir(), ".pi-mesh", "rules.json");
}

/**
 * Whether this machine shows a recognised run layout: at least one
 * `<tmp>/pi-subagents-<scope>/async-subagent-runs` directory exists.
 * Never throws: an unreadable temp root is "no layout", not a crash.
 */
export function hasRecognisedRunLayout(tmp: string): boolean {
  try {
    if (typeof tmp !== "string" || tmp === "") return false;
    const scopes = fs.readdirSync(tmp, { withFileTypes: true });
    for (const scope of scopes) {
      if (!scope.isDirectory() || !scope.name.startsWith(RUNS_SCOPE_PREFIX)) {
        continue;
      }
      try {
        const stat = fs.statSync(join(tmp, scope.name, RUNS_DIR_NAME));
        if (stat.isDirectory()) return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export interface WireLiveness {
  state: Liveness["state"];
  reason: Liveness["reason"];
  probed_at: string;
  status_age_ms: number;
}

export interface WireRun {
  run_id: string;
  state: RunRecord["state"];
  liveness: WireLiveness;
  pid?: number;
  parent_session?: string;
  child_session?: string;
  agent?: string;
  mode?: string;
  started_at: string;
  ended_at?: string;
  last_update?: string;
  status_age_ms: number;
  steps: RunRecord["steps"];
  tokens?: RunRecord["tokens"];
  cost_usd?: number;
  error?: string;
}

export interface RunCoverage {
  layout_recognised: boolean;
  last_success: string | null;
  last_error: string | null;
}

export interface WireFinding {
  rule: ModuleFinding["rule"];
  run_id?: string;
  session_file?: string;
  summary: string;
  observed_at: string;
  actual?: number;
  threshold?: number;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function wireRun(record: RunRecord, livenessDeps: ProbeLivenessDeps): WireRun {
  const liveness = probeLiveness(record.pid, livenessDeps);
  const run: WireRun = {
    run_id: record.runId,
    state: record.state,
    liveness: {
      state: liveness.state,
      reason: liveness.reason,
      probed_at: toIso(liveness.probedAt),
      status_age_ms: record.statusAgeMs,
    },
    started_at: toIso(record.startedAt),
    status_age_ms: record.statusAgeMs,
    steps: record.steps,
  };
  if (record.pid !== undefined) run.pid = record.pid;
  if (record.parentSessionFile !== undefined) {
    run.parent_session = record.parentSessionFile;
  }
  if (record.childSessionFile !== undefined) {
    run.child_session = record.childSessionFile;
  }
  if (record.agent !== undefined) run.agent = record.agent;
  if (record.mode !== undefined) run.mode = record.mode;
  if (record.endedAt !== undefined) run.ended_at = toIso(record.endedAt);
  if (record.lastUpdate !== undefined) {
    run.last_update = toIso(record.lastUpdate);
  }
  if (record.tokens !== undefined) run.tokens = record.tokens;
  if (record.costUsd !== undefined) run.cost_usd = record.costUsd;
  if (record.error !== undefined) run.error = record.error;
  return run;
}

function wireFinding(finding: ModuleFinding): WireFinding {
  const wire: WireFinding = {
    rule: finding.rule,
    summary: finding.summary,
    observed_at: toIso(finding.observedAt),
  };
  if (finding.runId !== undefined) wire.run_id = finding.runId;
  if (finding.sessionFile !== undefined) {
    wire.session_file = finding.sessionFile;
  }
  if (finding.actual !== undefined) wire.actual = finding.actual;
  if (finding.threshold !== undefined) wire.threshold = finding.threshold;
  return wire;
}

function suppressionKey(finding: ModuleFinding): string {
  return `${finding.rule}\0${finding.runId ?? finding.sessionFile ?? ""}`;
}

const NUMERIC_RULE_KEYS = [
  "staleMs",
  "longMs",
  "maxCostUsd",
  "maxTokens",
  "failureStreak",
] as const;

/**
 * The agent's own rules config: `~/.pi-mesh/rules.json` when present, the
 * module's defaults when absent. A present-but-malformed file refuses with a
 * stated reason - never a silent fall back to defaults, which would report
 * an operator's thresholds as evaluated when they were not.
 */
export function loadRulesConfig(rulesPath: string): {
  config: RulesConfig;
  source: "file" | "defaults";
} {
  let raw: string;
  try {
    raw = fs.readFileSync(rulesPath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return { config: { ...DEFAULT_RULES }, source: "defaults" };
    }
    throw new PiMeshError(
      -32603,
      `run.findings refused: cannot read rules file ${rulesPath} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PiMeshError(
      -32603,
      `run.findings refused: rules file ${rulesPath} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PiMeshError(
      -32603,
      `run.findings refused: rules file ${rulesPath} must be a JSON object of threshold overrides`,
    );
  }
  const overrides = parsed as Record<string, unknown>;
  // The pi-overseer extension names the long-run threshold `maxRuntimeMs`;
  // the module names it `longMs`. Both spellings are accepted, `longMs`
  // winning when both are present; anything else on the extension's shape
  // (`enabled`, `action`) is delivery, not detection, and stays unread here.
  for (const key of [...NUMERIC_RULE_KEYS, "maxRuntimeMs"] as const) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new PiMeshError(
        -32603,
        `run.findings refused: rules file ${rulesPath} sets ${key} to a non-numeric value (thresholds must be finite numbers >= 0)`,
      );
    }
  }
  const config: RulesConfig = { ...DEFAULT_RULES };
  if (typeof overrides.staleMs === "number") config.staleMs = overrides.staleMs;
  if (typeof overrides.longMs === "number") {
    config.longMs = overrides.longMs;
  } else if (typeof overrides.maxRuntimeMs === "number") {
    config.longMs = overrides.maxRuntimeMs;
  }
  if (typeof overrides.maxCostUsd === "number") {
    config.maxCostUsd = overrides.maxCostUsd;
  }
  if (typeof overrides.maxTokens === "number") {
    config.maxTokens = overrides.maxTokens;
  }
  if (typeof overrides.failureStreak === "number") {
    config.failureStreak = overrides.failureStreak;
  }
  return { config, source: "file" };
}

export interface RunsPlaneOptions {
  tmp: string;
  maxAgeMs?: number;
  sessionRoot?: string;
  rulesPath?: string;
  layoutRecognised: boolean;
  now?: () => number;
  livenessDeps?: ProbeLivenessDeps;
}

export interface RunsPlane {
  listRuns(): {
    runs: WireRun[];
    coverage: RunCoverage;
    evaluated_at: string;
  };
  evaluateFindings(): {
    findings: WireFinding[];
    config: RulesConfig;
    coverage: RunCoverage;
    evaluated_at: string;
  };
  /**
   * The full currently-firing set, WITHOUT suppression side effects: no
   * key is recorded and nothing is re-armed. The inventory watch (M8-7)
   * mirrors through this, because a findings frame replaces the previous
   * set wholesale and a suppressed (new-only) answer would wipe still-firing
   * findings from the mirror. `evaluateFindings` stays the notify path.
   */
  peekFindings(): {
    findings: WireFinding[];
    config: RulesConfig;
    coverage: RunCoverage;
    evaluated_at: string;
  };
}

/**
 * One evaluator epoch: coverage and suppression live exactly as long as the
 * returned plane, which the skill registry owns. A new plane (a restarted
 * agent) is a new epoch and may notify again.
 */
export function createRunsPlane(options: RunsPlaneOptions): RunsPlane {
  const maxAgeMs = options.maxAgeMs ?? RUNS_LIST_WINDOW_MS;
  const rulesPath = options.rulesPath ?? defaultRulesPath();
  const clock = options.now ?? Date.now;
  let lastSuccess: string | null = null;
  let lastError: string | null = null;
  const suppressed = new Map<string, number>();

  const coverage = (): RunCoverage => ({
    layout_recognised: options.layoutRecognised,
    last_success: lastSuccess,
    last_error: lastError,
  });

  const observe = (): RunRecord[] => {
    const now = clock();
    let discovered;
    try {
      discovered = discoverRuns({
        tmp: options.tmp,
        now,
        maxAgeMs,
        ...(options.sessionRoot === undefined
          ? {}
          : { sessionRoot: options.sessionRoot }),
      });
    } catch (error) {
      // A failed observation never counts as clearing: the suppression map
      // below is untouched on this path, and the error is recorded in
      // coverage rather than rendered as healthy-empty.
      lastError = toIso(now);
      throw new PiMeshError(
        -32603,
        `run observation refused: cannot read runs under ${options.tmp} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    lastSuccess = toIso(now);
    return discovered.runs;
  };

  return {
    listRuns() {
      const now = clock();
      const runs = observe();
      const livenessDeps: ProbeLivenessDeps = {
        ...options.livenessDeps,
        now: () => now,
      };
      return {
        runs: runs.map((record) => wireRun(record, livenessDeps)),
        coverage: coverage(),
        evaluated_at: toIso(now),
      };
    },

    evaluateFindings() {
      // The config load comes first: a malformed file refuses before any
      // finding is computed, so a bad file can never read as "no findings".
      const { config } = loadRulesConfig(rulesPath);
      const now = clock();
      const runs = observe();
      const current = evaluateRules(runs, config, now);
      const currentKeys = new Set(current.map(suppressionKey));
      // Re-arm: a finding that no longer fires clears, so the next crossing
      // notifies again. This is the only removal path - a failed observation
      // throws above and never reaches it.
      for (const key of suppressed.keys()) {
        if (!currentKeys.has(key)) suppressed.delete(key);
      }
      const firing = current.filter((finding) => {
        const key = suppressionKey(finding);
        if (suppressed.has(key)) return false;
        suppressed.set(key, now);
        // Bounded: forget the oldest suppression first, so an unbounded set
        // of distinct findings cannot grow memory without limit.
        while (suppressed.size > MAX_SUPPRESSED_FINDINGS) {
          const oldest = suppressed.keys().next().value;
          if (oldest === undefined) break;
          suppressed.delete(oldest);
        }
        return true;
      });
      return {
        findings: firing.map(wireFinding),
        config,
        coverage: coverage(),
        evaluated_at: toIso(now),
      };
    },

    peekFindings() {
      // Same refusal order as evaluateFindings: a malformed file refuses
      // before any finding is computed, so a bad file can never read as
      // "no findings". No suppression side effect: the map above is
      // neither read nor written, so the returned set is the whole
      // currently-firing set - the only shape a wholesale mirror may take.
      const { config } = loadRulesConfig(rulesPath);
      const now = clock();
      const runs = observe();
      const current = evaluateRules(runs, config, now);
      return {
        findings: current.map(wireFinding),
        config,
        coverage: coverage(),
        evaluated_at: toIso(now),
      };
    },
  };
}
