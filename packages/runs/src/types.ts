// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Shared record shapes for subagent-run oversight.
 *
 * These mirror the fields pi-subagents already writes into each run's
 * `status.json` (ADR 0021 facts 2-3). Nothing here imports the mesh or Pi:
 * this package is pure fs reads plus pure functions.
 */

/** Terminal states: the runner will not update this run again. */
export const TERMINAL_RUN_STATES = [
  "complete",
  "failed",
  "partial",
  "stopped",
  "rejected",
] as const;

export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

/** States in which the runner may still update the run. */
export const ACTIVE_RUN_STATES = ["queued", "running", "paused"] as const;

export type ActiveRunState = (typeof ACTIVE_RUN_STATES)[number];

export type RunState = ActiveRunState | TerminalRunState;

/** States pi-subagents writes; anything else is an unrecognised layout. */
export const KNOWN_RUN_STATES: readonly string[] = [
  ...ACTIVE_RUN_STATES,
  ...TERMINAL_RUN_STATES,
];

export function isRunState(value: unknown): value is RunState {
  return (
    typeof value === "string" &&
    (KNOWN_RUN_STATES as readonly string[]).includes(value)
  );
}

export function isActiveRunState(state: RunState): boolean {
  return (ACTIVE_RUN_STATES as readonly string[]).includes(state);
}

export interface RunStepSummary {
  index: number;
  agent: string;
  status: string;
  sessionFile?: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  total: number;
}

/**
 * One discovered subagent run, mapped from `<runDir>/status.json`.
 *
 * `parentSessionFile` is upstream's `sessionId` (the parent transcript) and
 * `childSessionFile` is upstream's `sessionFile` (the child transcript);
 * both are recorded verbatim, never resolved or created here.
 */
export interface RunRecord {
  runId: string;
  /** Absolute path of the run directory holding `status.json`. */
  runDir: string;
  state: RunState;
  pid?: number;
  parentSessionFile?: string;
  childSessionFile?: string;
  /**
   * Whether the child transcript sits inside the sessions root the caller
   * passed to discovery. Present only when a root was given and a child
   * file was recorded.
   */
  childSessionInRoot?: boolean;
  /** Agent of the first recorded step, when the run has steps. */
  agent?: string;
  mode?: string;
  startedAt: number;
  endedAt?: number;
  lastUpdate?: number;
  /** `now - (lastUpdate ?? startedAt)` at discovery time, floored at 0. */
  statusAgeMs: number;
  steps: RunStepSummary[];
  tokens?: TokenTotals;
  costUsd?: number;
  error?: string;
}

export type LivenessState = "alive" | "dead" | "unknown";

export type LivenessReason =
  | "pid-alive"
  | "pid-dead"
  | "permission-denied"
  | "no-pid"
  | "zombie"
  | "namespace-unmatched"
  | "probe-failed";

/**
 * Tri-state liveness with its evidence. There is deliberately no boolean
 * `live`: a successful `kill(pid, 0)` proves a process exists, never that it
 * is this run's runner (ADR 0021 decision 1).
 */
export interface Liveness {
  state: LivenessState;
  reason: LivenessReason;
  probedAt: number;
}

export type FindingRule =
  | "run-stale"
  | "run-long"
  | "run-budget-usd"
  | "run-budget-tokens"
  | "session-failure-streak";

export interface RulesConfig {
  /** An active run older than this without an update is stale. */
  staleMs: number;
  /** An active run older than this since start is long. */
  longMs: number;
  /** Cost in USD above which a run is a finding. */
  maxCostUsd: number;
  /** Total tokens above which a run is a finding. */
  maxTokens: number;
  /** Consecutive failures on one parent session that raise a finding. */
  failureStreak: number;
}

export interface Finding {
  rule: FindingRule;
  /** Set for per-run rules; absent for `session-failure-streak`. */
  runId?: string;
  /** Parent session file; set for `session-failure-streak`. */
  sessionFile?: string;
  summary: string;
  observedAt: number;
  /** The measured value that crossed the threshold, when applicable. */
  actual?: number;
  /** The threshold it crossed, when applicable. */
  threshold?: number;
}
