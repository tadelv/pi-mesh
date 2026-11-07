// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Run discovery: read `<tmp>/pi-subagents-<scope>/async-subagent-runs/.../status.json`
 * and map the fields ADR 0021 lists (runId, state, pid, parent and child
 * session files, agent, mode, timings, steps, tokens, cost).
 *
 * Fail-closed: a missing root, an unreadable directory, a malformed
 * `status.json` or an unrecognised shape is skipped and recorded - never
 * thrown, never a fabricated run, never a write.
 *
 * Windowing: `maxAgeMs` bounds only terminal runs. An active run older than
 * the window is still listed (ADR 0021 decision 1: no window drops live
 * work), and its age is reported, never rendered as failure.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  isActiveRunState,
  isRunState,
  type RunRecord,
  type RunState,
  type RunStepSummary,
  type TokenTotals,
} from "./types.js";

export interface DiscoverRunsOptions {
  /** Temp root to scan, e.g. `os.tmpdir()`. */
  tmp: string;
  /** Current time in ms since epoch, passed in so tests use fixtures. */
  now: number;
  /** Terminal runs older than this (by status age) are omitted. */
  maxAgeMs: number;
  /** Sessions root, used only to check child-transcript containment. */
  sessionRoot?: string;
}

export interface SkippedRun {
  runDir: string;
  reason: string;
}

export interface DiscoverRunsResult {
  runs: RunRecord[];
  skipped: SkippedRun[];
}

const RUNS_SCOPE_PREFIX = "pi-subagents-";
const RUNS_DIR_NAME = "async-subagent-runs";
const STATUS_FILE = "status.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readDirEntries(dir: string): string[] | undefined {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return undefined;
  }
}

function readStatusFile(runDir: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(runDir, STATUS_FILE), "utf8");
  } catch {
    return { __unreadable: true };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { __malformed: true };
  }
}

function mapTokens(value: unknown): TokenTotals | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const input = toNumber(value["input"]);
  const output = toNumber(value["output"]);
  const total = toNumber(value["total"]);
  if (input === undefined || output === undefined || total === undefined) {
    return undefined;
  }
  return { input, output, total };
}

function mapSteps(value: unknown): RunStepSummary[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const steps: RunStepSummary[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!isRecord(raw)) {
      return undefined;
    }
    const agent = toNonEmptyString(raw["agent"]);
    const status = toNonEmptyString(raw["status"]);
    if (agent === undefined || status === undefined) {
      return undefined;
    }
    const step: RunStepSummary = { index, agent, status };
    const sessionFile = toNonEmptyString(raw["sessionFile"]);
    if (sessionFile !== undefined) {
      step.sessionFile = sessionFile;
    }
    steps.push(step);
  }
  return steps;
}

function childInsideRoot(
  childSessionFile: string,
  sessionRoot: string,
): boolean | undefined {
  try {
    const resolvedRoot = path.resolve(sessionRoot);
    const resolvedChild = path.isAbsolute(childSessionFile)
      ? path.normalize(childSessionFile)
      : path.resolve(resolvedRoot, childSessionFile);
    const relative = path.relative(resolvedRoot, resolvedChild);
    return (
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    );
  } catch {
    return undefined;
  }
}

function mapRun(
  runDir: string,
  status: Record<string, unknown>,
  options: DiscoverRunsOptions,
): RunRecord | { skip: string } {
  const runId = toNonEmptyString(status["runId"]);
  const state = status["state"];
  const startedAt = toNumber(status["startedAt"]);
  if (runId === undefined || !isRunState(state) || startedAt === undefined) {
    return { skip: "unrecognised-shape" };
  }
  const runState: RunState = state;
  const lastUpdate = toNumber(status["lastUpdate"]);
  const endedAt = toNumber(status["endedAt"]);
  const statusAgeMs = Math.max(0, options.now - (lastUpdate ?? startedAt));
  if (!isActiveRunState(runState) && statusAgeMs > options.maxAgeMs) {
    return { skip: "outside-window" };
  }
  const stepsRaw = status["steps"];
  let steps: RunStepSummary[] = [];
  if (stepsRaw !== undefined) {
    const mapped = mapSteps(stepsRaw);
    if (mapped === undefined) {
      return { skip: "unrecognised-shape" };
    }
    steps = mapped;
  }
  const record: RunRecord = {
    runId,
    runDir,
    state: runState,
    statusAgeMs,
    steps,
    startedAt,
  };
  const pid = status["pid"];
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
    record.pid = pid;
  }
  // ADR 0021: `sessionId` is the parent transcript, `sessionFile` the child.
  const parentSessionFile = toNonEmptyString(status["sessionId"]);
  if (parentSessionFile !== undefined) {
    record.parentSessionFile = parentSessionFile;
  }
  const childSessionFile = toNonEmptyString(status["sessionFile"]);
  if (childSessionFile !== undefined) {
    record.childSessionFile = childSessionFile;
    if (options.sessionRoot !== undefined) {
      const inside = childInsideRoot(childSessionFile, options.sessionRoot);
      if (inside !== undefined) {
        record.childSessionInRoot = inside;
      }
    }
  }
  const firstAgent = steps.length > 0 ? steps[0]?.agent : undefined;
  if (firstAgent !== undefined) {
    record.agent = firstAgent;
  }
  const mode = toNonEmptyString(status["mode"]);
  if (mode !== undefined) {
    record.mode = mode;
  }
  if (endedAt !== undefined) {
    record.endedAt = endedAt;
  }
  if (lastUpdate !== undefined) {
    record.lastUpdate = lastUpdate;
  }
  const tokens = mapTokens(status["totalTokens"]);
  if (tokens !== undefined) {
    record.tokens = tokens;
  }
  const totalCost = status["totalCost"];
  if (isRecord(totalCost)) {
    const costUsd = toNumber(totalCost["costUsd"]);
    if (costUsd !== undefined) {
      record.costUsd = costUsd;
    }
  }
  const error = toNonEmptyString(status["error"]);
  if (error !== undefined) {
    record.error = error;
  }
  return record;
}

function isSkip(
  value: RunRecord | { skip: string },
): value is { skip: string } {
  return (value as { skip?: unknown }).skip !== undefined;
}

/**
 * Discover runs under `tmp`. Never throws and never writes: every failure
 * becomes a `skipped` entry or an empty result. Runs are returned
 * newest-first by `lastUpdate ?? startedAt`, with `runId` breaking ties.
 */
export function discoverRuns(options: DiscoverRunsOptions): DiscoverRunsResult {
  const result: DiscoverRunsResult = { runs: [], skipped: [] };
  try {
    if (
      typeof options.tmp !== "string" ||
      options.tmp === "" ||
      typeof options.now !== "number" ||
      !Number.isFinite(options.now) ||
      typeof options.maxAgeMs !== "number" ||
      !Number.isFinite(options.maxAgeMs) ||
      options.maxAgeMs < 0
    ) {
      return result;
    }
    const scopes = readDirEntries(options.tmp);
    if (scopes === undefined) {
      return result;
    }
    for (const scope of scopes) {
      if (!scope.startsWith(RUNS_SCOPE_PREFIX)) {
        continue;
      }
      const runsRoot = path.join(options.tmp, scope, RUNS_DIR_NAME);
      const entries = readDirEntries(runsRoot);
      if (entries === undefined) {
        continue;
      }
      for (const entry of entries) {
        const runDir = path.join(runsRoot, entry);
        const raw = readStatusFile(runDir);
        if (!isRecord(raw)) {
          result.skipped.push({ runDir, reason: "malformed-status.json" });
          continue;
        }
        if ("__unreadable" in raw || "__malformed" in raw) {
          result.skipped.push({
            runDir,
            reason:
              "__malformed" in raw
                ? "malformed-status.json"
                : "missing-status.json",
          });
          continue;
        }
        const mapped = mapRun(runDir, raw, options);
        if (isSkip(mapped)) {
          result.skipped.push({ runDir, reason: mapped.skip });
          continue;
        }
        result.runs.push(mapped);
      }
    }
    // Newest first by last update (falling back to start), runId breaking
    // ties so the order is stable.
    result.runs.sort((a, b) => {
      const aKey = a.lastUpdate ?? a.startedAt;
      const bKey = b.lastUpdate ?? b.startedAt;
      if (aKey !== bKey) {
        return bKey - aKey;
      }
      return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
    });
    return result;
  } catch {
    return result;
  }
}

/**
 * UNWINDOWED run-id lookup (M8-8). Discovery omits old terminal runs
 * (`outside-window`), so a windowed lookup would answer -32108 for a run
 * that plainly exists. A retained artifact outside the listing window is
 * still a known run: this scans every `<tmp>/pi-subagents-...` run
 * directory, reads its `status.json` and returns every directory whose
 * `runId` equals the requested id - with no age filter. Never throws and
 * never writes: unreadable or malformed artifacts are skipped, never
 * fabricated. Sorted so ambiguity is deterministic.
 */
export function findRunDirsById(tmp: string, runId: string): string[] {
  const matches: string[] = [];
  try {
    if (
      typeof tmp !== "string" ||
      tmp === "" ||
      typeof runId !== "string" ||
      runId === ""
    ) {
      return matches;
    }
    const scopes = readDirEntries(tmp);
    if (scopes === undefined) {
      return matches;
    }
    for (const scope of scopes) {
      if (!scope.startsWith(RUNS_SCOPE_PREFIX)) {
        continue;
      }
      const runsRoot = path.join(tmp, scope, RUNS_DIR_NAME);
      const entries = readDirEntries(runsRoot);
      if (entries === undefined) {
        continue;
      }
      for (const entry of entries) {
        const runDir = path.join(runsRoot, entry);
        const raw = readStatusFile(runDir);
        if (!isRecord(raw)) {
          continue;
        }
        if ("__unreadable" in raw || "__malformed" in raw) {
          continue;
        }
        const id = toNonEmptyString((raw as Record<string, unknown>)["runId"]);
        if (id === runId) {
          matches.push(runDir);
        }
      }
    }
    matches.sort();
    return matches;
  } catch {
    return matches;
  }
}

export type ReadRunStateResult =
  | { ok: true; state: RunState }
  | { ok: false; kind: "io"; message: string }
  | { ok: false; kind: "unrecognised"; message: string };

/**
 * Fresh status read for control (M8-8): after authorisation, before either
 * writer. I/O failures (`missing-status.json`, unreadable file) are `io`
 * (-32603); a malformed file or an unknown state is `unrecognised`
 * (-32109, the per-run shape). Never throws.
 */
export function readRunState(runDir: string): ReadRunStateResult {
  try {
    if (typeof runDir !== "string" || runDir === "") {
      return { ok: false, kind: "io", message: "missing run directory" };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(runDir, STATUS_FILE), "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, kind: "io", message };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, kind: "unrecognised", message };
    }
    if (!isRecord(parsed)) {
      return {
        ok: false,
        kind: "unrecognised",
        message: "status.json is not an object",
      };
    }
    const state = parsed["state"];
    if (!isRunState(state)) {
      return {
        ok: false,
        kind: "unrecognised",
        message: "unrecognised run state",
      };
    }
    return { ok: true, state };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: "io", message };
  }
}
