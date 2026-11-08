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
 *     state, pid, cwd, startedAt, lastUpdate, endedAt, steps, totals
 *
 * Run detection belongs to `@pi-mesh/runs`: which runs exist, their
 * windowing and ordering, and pid liveness all come from the module, so this
 * package never carries a second copy of that logic. Session scanning stays
 * here - the module reads run artifacts only. Plain node:fs otherwise - no
 * pi imports - so it is testable without the runtime and safe to call from
 * any process.
 */

import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_RUN_STATES,
  discoverRuns as discoverModuleRuns,
  probeLiveness,
  type Liveness,
  type RunRecord as ModuleRunRecord,
} from "@pi-mesh/runs";

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
  /**
   * Derived from the module: the run's state is active and its pid probe
   * came back `alive`. Anything else - dead, terminal, or `unknown` - is
   * not live, but it is still listed.
   */
  live: boolean;
  /** Tri-state pid liveness with its evidence (ADR 0021 decision 1). */
  liveness: Liveness;
  pid?: number;
  cwd?: string;
  /** parent session transcript (status.json.sessionId) */
  parentSessionFile?: string;
  /** child session transcript (status.json.sessionFile) */
  childSessionFile?: string;
  agent?: string;
  mode?: string;
  startedAt?: number;
  /** module `lastUpdate`, falling back to a legacy `lastActivityAt` */
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

function readSessionHeader(
  file: string,
): { id: string; cwd: string; timestamp?: string } | undefined {
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
  const h = parsed as {
    type?: string;
    id?: unknown;
    cwd?: unknown;
    timestamp?: unknown;
  };
  if (h?.type !== "session" || typeof h.id !== "string") return undefined;
  return {
    id: h.id,
    cwd: typeof h.cwd === "string" ? h.cwd : "",
    ...(typeof h.timestamp === "string" ? { timestamp: h.timestamp } : {}),
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
        // exactOptionalPropertyTypes: an absent value is an omitted key, never
        // an explicit undefined.
        ...(header.timestamp === undefined
          ? {}
          : { startedAt: header.timestamp }),
        lastActiveAt: mtimeMs,
        live: age <= LIVE_WINDOW_MS,
      });
    }
  }

  out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return out;
}

/**
 * Display-only extras the module does not map: the working directory and
 * the latest-window token count are presentation, not detection, so they
 * are read here best-effort and never influence which runs exist.
 * Candidate for the module if it ever passes display fields through.
 */
function readRunExtras(dir: string): {
  cwd?: string;
  contextWindow?: number;
  lastActivityAt?: number;
} {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
  const tokens = s.totalTokens as
    { window?: unknown; total?: unknown } | undefined;
  return {
    ...(typeof s.cwd === "string" ? { cwd: s.cwd } : {}),
    ...(typeof tokens?.window === "number"
      ? { contextWindow: tokens.window }
      : {}),
    ...(typeof s.lastActivityAt === "number"
      ? { lastActivityAt: s.lastActivityAt }
      : {}),
  };
}

/**
 * Active (possibly still updating) runs whose pid probe was inconclusive:
 * neither provably this run's runner nor provably gone. The panel shows
 * these beside the live runs instead of dropping them silently.
 */
export function isUnresolvedRun(run: RunRecord): boolean {
  return (
    !run.live &&
    run.liveness.state === "unknown" &&
    (ACTIVE_RUN_STATES as readonly string[]).includes(run.state)
  );
}

/** Runs needing operator attention first: live, then unresolved, in order. */
export function attentionRuns(fleet: Fleet): RunRecord[] {
  return fleet.runs.filter((r) => r.live || isUnresolvedRun(r));
}

function toPackageRun(mod: ModuleRunRecord): RunRecord {
  const liveness = probeLiveness(mod.pid);
  const extras = readRunExtras(mod.runDir);
  const active = (ACTIVE_RUN_STATES as readonly string[]).includes(mod.state);
  return {
    runId: mod.runId,
    dir: mod.runDir,
    state: mod.state,
    live: active && liveness.state === "alive",
    liveness,
    ...(mod.pid === undefined ? {} : { pid: mod.pid }),
    ...(extras.cwd === undefined ? {} : { cwd: extras.cwd }),
    ...(mod.parentSessionFile === undefined
      ? {}
      : { parentSessionFile: mod.parentSessionFile }),
    ...(mod.childSessionFile === undefined
      ? {}
      : { childSessionFile: mod.childSessionFile }),
    ...(mod.agent === undefined ? {} : { agent: mod.agent }),
    ...(mod.mode === undefined ? {} : { mode: mod.mode }),
    ...(mod.startedAt === undefined ? {} : { startedAt: mod.startedAt }),
    ...(mod.lastUpdate === undefined && extras.lastActivityAt === undefined
      ? {}
      : { lastActivityAt: mod.lastUpdate ?? extras.lastActivityAt }),
    ...(mod.endedAt === undefined ? {} : { endedAt: mod.endedAt }),
    ...(mod.tokens?.total === undefined
      ? {}
      : { totalTokens: mod.tokens.total }),
    ...(mod.costUsd === undefined ? {} : { totalCost: mod.costUsd }),
    ...(extras.contextWindow === undefined
      ? {}
      : { contextWindow: extras.contextWindow }),
    stepCount: mod.steps.length,
  };
}

/**
 * Async subagent runs (any foreground/background mode), newest first.
 * Detection, windowing (terminal runs only) and ordering come from
 * `@pi-mesh/runs`; this function only attaches liveness and the
 * display-only extras above.
 */
export function discoverRuns(opts: DiscoveryOptions = {}): RunRecord[] {
  const tmp = opts.tmp ?? tmpdir();
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DAY_MS;
  const { runs } = discoverModuleRuns({ tmp, now, maxAgeMs });
  return runs.map(toPackageRun);
}

/**
 * Direct lookup by run id regardless of age, for control actions. The
 * window is unbounded here because a terminal run is still stoppable in
 * the idempotent sense - the module still decides which directories are
 * runs.
 */
export function findRun(
  runId: string,
  opts: DiscoveryOptions = {},
): RunRecord | undefined {
  const tmp = opts.tmp ?? tmpdir();
  const now = opts.now ?? Date.now();
  const { runs } = discoverModuleRuns({
    tmp,
    now,
    maxAgeMs: Number.MAX_SAFE_INTEGER,
  });
  const mod = runs.find((r) => r.runId === runId);
  return mod ? toPackageRun(mod) : undefined;
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
