// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Overseer discovery - reads the on-disk evidence every pi process leaves
 * behind, so one session can see all the others no matter which folder they
 * run in.
 *
 * Two sources, joined on the parent session file path:
 *   ~/.pi/agent/sessions/--<munged-cwd>--/<iso>_<uuid>.jsonl
 *     line 1: {"type":"session","version":3,"id":..,"timestamp":..,"cwd":..}
 *   <tmp>/pi-subagents-<scope>/async-subagent-runs/<runId>/status.json
 *     runId, sessionId (parent session *file*), sessionFile (child session),
 *     state, pid, cwd, startedAt, lastActivityAt, endedAt, steps, totals
 *
 * Plain node:fs only - no pi imports - so it is testable without the runtime
 * and safe to call from any process.
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const SESSION_ROOT = join(homedir(), ".pi/agent/sessions");

/** A session is "live" when its transcript was written this recently. */
export const LIVE_WINDOW_MS = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionRecord {
  id: string;
  file: string;
  cwd: string;
  startedAt?: string;
  /** transcript mtime */
  lastActiveAt: number;
  live: boolean;
}

export interface RunRecord {
  runId: string;
  dir: string;
  state: string;
  live: boolean;
  pid?: number;
  cwd?: string;
  /** parent session transcript (status.json.sessionId) */
  parentSessionFile?: string;
  /** child session transcript (status.json.sessionFile) */
  childSessionFile?: string;
  agent?: string;
  mode?: string;
  startedAt?: number;
  lastActivityAt?: number;
  endedAt?: number;
  /** totalTokens.total */
  totalTokens?: number;
  /** totalCost.costUsd */
  totalCost?: number;
  /** latest-window input+output when the run reports it */
  contextWindow?: number;
  stepCount?: number;
}

export interface Fleet {
  generatedAt: number;
  sessions: SessionRecord[];
  runs: RunRecord[];
  liveSessions: SessionRecord[];
  liveRuns: RunRecord[];
  /** runs grouped by the parent session that spawned them */
  runsBySession: Map<string, RunRecord[]>;
  /** runs whose parent session is outside the scan window */
  externalRuns: RunRecord[];
  totals: { tokens: number; cost: number };
}

export interface DiscoveryOptions {
  sessionRoot?: string;
  tmp?: string;
  now?: number;
  maxAgeMs?: number;
}

/** Read the first `bytes` of a file without loading the whole transcript. */
function readHead(file: string, bytes = 8192): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** True when the pid exists (signal 0 probe; EPERM still means alive). */
export function isAlive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readSessionHeader(file: string): { id: string; cwd: string; timestamp?: string } | undefined {
  let first: string;
  try {
    first = readHead(file).split("\n", 1)[0] ?? "";
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(first);
  } catch {
    return undefined;
  }
  const h = parsed as { type?: string; id?: unknown; cwd?: unknown; timestamp?: unknown };
  if (h?.type !== "session" || typeof h.id !== "string") return undefined;
  return {
    id: h.id,
    cwd: typeof h.cwd === "string" ? h.cwd : "",
    timestamp: typeof h.timestamp === "string" ? h.timestamp : undefined,
  };
}

/** Sessions whose transcript was touched within `maxAgeMs`, newest first. */
export function discoverSessions(opts: DiscoveryOptions = {}): SessionRecord[] {
  const root = opts.sessionRoot ?? SESSION_ROOT;
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DAY_MS;
  const out: SessionRecord[] = [];

  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }

  for (const dir of dirs) {
    if (!dir.startsWith("--")) continue;
    let files: string[];
    try {
      files = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(root, dir, name);
      let mtimeMs: number;
      try {
        const st = statSync(file);
        if (!st.isFile()) continue;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      const age = now - mtimeMs;
      if (age > maxAgeMs) continue;
      const header = readSessionHeader(file);
      if (!header) continue;
      out.push({
        id: header.id,
        file,
        cwd: header.cwd,
        startedAt: header.timestamp,
        lastActiveAt: mtimeMs,
        live: age <= LIVE_WINDOW_MS,
      });
    }
  }

  out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return out;
}

function subagentScopeDirs(tmp: string): string[] {
  try {
    return readdirSync(tmp)
      .filter((name) => name.startsWith("pi-subagents-"))
      .map((name) => join(tmp, name, "async-subagent-runs"));
  } catch {
    return [];
  }
}

/** Parse one run directory. `maxAgeMs` filters discovery; omit it for lookup by id. */
function readRun(dir: string, fallbackId: string, now: number, maxAgeMs?: number): RunRecord | undefined {
  const statusFile = join(dir, "status.json");
  try {
    if (maxAgeMs !== undefined && now - statSync(statusFile).mtimeMs > maxAgeMs) return undefined;
  } catch {
    return undefined;
  }
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(readFileSync(statusFile, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const pid = typeof s.pid === "number" ? s.pid : undefined;
  const state = String(s.state ?? "unknown");
  const running = state === "running" || state === "queued" || state === "starting";
  const steps = Array.isArray(s.steps) ? (s.steps as Array<{ agent?: string }>) : undefined;
  // status.json reports these as objects, not scalars.
  const tokens = s.totalTokens as { total?: number; window?: number } | undefined;
  const cost = s.totalCost as { costUsd?: number } | undefined;

  return {
    runId: typeof s.runId === "string" ? s.runId : fallbackId,
    dir,
    state,
    live: running && (pid === undefined || isAlive(pid)),
    pid,
    cwd: typeof s.cwd === "string" ? s.cwd : undefined,
    parentSessionFile: typeof s.sessionId === "string" ? s.sessionId : undefined,
    childSessionFile: typeof s.sessionFile === "string" ? s.sessionFile : undefined,
    agent: steps?.[0]?.agent,
    mode: typeof s.mode === "string" ? s.mode : undefined,
    startedAt: typeof s.startedAt === "number" ? s.startedAt : undefined,
    lastActivityAt: typeof s.lastActivityAt === "number" ? s.lastActivityAt : undefined,
    endedAt: typeof s.endedAt === "number" ? s.endedAt : undefined,
    totalTokens: typeof tokens?.total === "number" ? tokens.total : undefined,
    totalCost: typeof cost?.costUsd === "number" ? cost.costUsd : undefined,
    contextWindow: typeof tokens?.window === "number" ? tokens.window : undefined,
    stepCount: steps?.length,
  };
}

/** Async subagent runs (any foreground/background mode), newest activity first. */
export function discoverRuns(opts: DiscoveryOptions = {}): RunRecord[] {
  const tmp = opts.tmp ?? tmpdir();
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DAY_MS;
  const out: RunRecord[] = [];

  for (const runsDir of subagentScopeDirs(tmp)) {
    let ids: string[];
    try {
      ids = readdirSync(runsDir);
    } catch {
      continue;
    }
    for (const id of ids) {
      const run = readRun(join(runsDir, id), id, now, maxAgeMs);
      if (run) out.push(run);
    }
  }

  out.sort((a, b) => (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0));
  return out;
}

/** Direct lookup by run id regardless of age, for control actions. */
export function findRun(runId: string, opts: DiscoveryOptions = {}): RunRecord | undefined {
  const tmp = opts.tmp ?? tmpdir();
  const now = opts.now ?? Date.now();
  for (const runsDir of subagentScopeDirs(tmp)) {
    const run = readRun(join(runsDir, runId), runId, now);
    if (run) return run;
  }
  return undefined;
}

/** Join both planes into the single view the panel, rules and tool all read. */
export function buildFleet(opts: DiscoveryOptions = {}): Fleet {
  const sessions = discoverSessions(opts);
  const runs = discoverRuns(opts);
  const known = new Set(sessions.map((s) => s.file));
  const runsBySession = new Map<string, RunRecord[]>();
  const externalRuns: RunRecord[] = [];

  for (const run of runs) {
    const key = run.parentSessionFile;
    if (!key || !known.has(key)) {
      externalRuns.push(run);
      continue;
    }
    const list = runsBySession.get(key) ?? [];
    list.push(run);
    runsBySession.set(key, list);
  }

  let tokens = 0;
  let cost = 0;
  for (const run of runs) {
    tokens += run.totalTokens ?? 0;
    cost += run.totalCost ?? 0;
  }

  return {
    generatedAt: opts.now ?? Date.now(),
    sessions,
    runs,
    liveSessions: sessions.filter((s) => s.live),
    liveRuns: runs.filter((r) => r.live),
    runsBySession,
    externalRuns,
    totals: { tokens, cost },
  };
}
