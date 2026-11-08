// SPDX-License-Identifier: GPL-3.0-or-later

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type {
  Event,
  SessionSummary,
  WatchFinding,
  WatchFindingsCoverage,
  WatchRun,
} from "@pi-mesh/protocol";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/**
 * Rows kept per agent in the jobs mirror.
 *
 * 64 is the agent's DEFAULT retention limit (DEFAULT_MAX_RETAINED_JOBS in
 * packages/agent/src/jobs.ts), and it bounds the rows THIS control plane writes.
 * A smaller bound made the control plane silently drop jobs the agent still
 * reported, so "from the agent" listed fewer rows than the agent had. An agent
 * configured with a larger maxRetainedJobs can report more, and replaceJobs
 * stores what it is told: a mirror is never truncated silently, and a later
 * trimming write withdraws the freshness claim rather than leaving a short list
 * labelled current.
 */
const MAX_JOBS_PER_AGENT = 64;

export interface PairedAgent {
  peer_id: string;
  name: string;
  host: string;
  port: number;
  credential: string;
  paired_at: string;
}

export interface CachedSession {
  agent_id: string;
  session_id: string;
  project: string;
  name: string | null;
  started_at: string;
  updated_at: string;
  synced_at: string;
}

export interface CachedEvent {
  agent_id: string;
  session_id: string;
  entry_id: string;
  type: string;
  timestamp: string;
  data: string;
}

export interface CachedJob {
  agent_id: string;
  job_id: string;
  session_id: string | null;
  pid: number | null;
  project: string;
  created_at: string;
  state: string;
}

/** One mirrored subagent run (M8-7). `steps` and `tokens` are JSON, like events data. */
export interface CachedRun {
  agent_id: string;
  run_id: string;
  state: string;
  liveness_state: string;
  liveness_reason: string;
  probed_at: string;
  status_age_ms: number;
  pid: number | null;
  parent_session: string | null;
  child_session: string | null;
  agent: string | null;
  mode: string | null;
  started_at: string;
  ended_at: string | null;
  last_update: string | null;
  steps: string;
  tokens: string | null;
  cost_usd: number | null;
  error: string | null;
  /** Mirror write time: the freshness stamp. A row without it is never current. */
  synced_at: string;
}

/** One mirrored finding (M8-7). The set is replaced wholesale per pass. */
export interface CachedFinding {
  agent_id: string;
  key: string;
  rule: string;
  run_id: string | null;
  session_file: string | null;
  summary: string;
  observed_at: string;
  actual: number | null;
  threshold: number | null;
}

/** The evaluation pass a mirrored findings set came from (M8-7). */
export interface CachedFindingsSnapshot {
  agent_id: string;
  evaluated_at: string;
  layout_recognised: boolean;
  last_success: string | null;
  last_error: string | null;
  /** Mirror write time: the freshness stamp. No snapshot row, no currency. */
  synced_at: string;
}

export class ControlStore {
  private readonly db: DatabaseSyncType;
  private readonly now: () => number;
  /**
   * Called after an agent row is removed. The control server installs this to
   * close that agent's live streams, so unpairing cannot leave an upstream
   * running (ADR 0018 §5).
   */
  onAgentRemoved: ((peerId: string) => void) | undefined;

  constructor(path: string, options: { now?: () => number } = {}) {
    if (path !== ":memory:") {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    // This database is a cache, never authority (ADR 0015), and the watch now
    // writes a row per change. The default journal mode fsyncs twice per
    // statement, which on a slow disk puts the whole process in D state: the
    // control plane blocked in a journal commit and answered nothing until it
    // was restarted. WAL with synchronous=NORMAL syncs at a checkpoint instead
    // of per commit - the worst case is losing the last few mirror rows, which
    // the next listing repairs.
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    this.now = options.now ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS agents (peer_id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, credential TEXT NOT NULL, paired_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (agent_id TEXT NOT NULL, session_id TEXT NOT NULL, project TEXT NOT NULL, name TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT NOT NULL, PRIMARY KEY(agent_id, session_id)) STRICT;
      CREATE TABLE IF NOT EXISTS events (agent_id TEXT NOT NULL, session_id TEXT NOT NULL, entry_id TEXT NOT NULL, type TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(agent_id, session_id, entry_id)) STRICT;
      CREATE TABLE IF NOT EXISTS jobs (agent_id TEXT NOT NULL, job_id TEXT NOT NULL, session_id TEXT, pid INTEGER, project TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(agent_id, job_id)) STRICT;
      CREATE TABLE IF NOT EXISTS runs (agent_id TEXT NOT NULL, run_id TEXT NOT NULL, state TEXT NOT NULL, liveness_state TEXT NOT NULL, liveness_reason TEXT NOT NULL, probed_at TEXT NOT NULL, status_age_ms INTEGER NOT NULL, pid INTEGER, parent_session TEXT, child_session TEXT, agent TEXT, mode TEXT, started_at TEXT NOT NULL, ended_at TEXT, last_update TEXT, steps TEXT NOT NULL, tokens TEXT, cost_usd REAL, error TEXT, synced_at TEXT NOT NULL, PRIMARY KEY(agent_id, run_id)) STRICT;
      CREATE TABLE IF NOT EXISTS findings (agent_id TEXT NOT NULL, key TEXT NOT NULL, rule TEXT NOT NULL, run_id TEXT, session_file TEXT, summary TEXT NOT NULL, observed_at TEXT NOT NULL, actual REAL, threshold REAL, PRIMARY KEY(agent_id, key)) STRICT;
      CREATE TABLE IF NOT EXISTS findings_snapshots (agent_id TEXT PRIMARY KEY, evaluated_at TEXT NOT NULL, layout_recognised INTEGER NOT NULL, last_success TEXT, last_error TEXT, synced_at TEXT NOT NULL) STRICT;
    `);
    this.db.exec("DROP TABLE IF EXISTS agent_caps");
    // Prune on open as well as on write: a database written by an earlier
    // version can already hold more than the retention limit, and waiting for
    // the next spawn would leave it unbounded until then. Per agent, matching
    // upsertJob.
    this.db.exec(
      `DELETE FROM jobs WHERE rowid NOT IN (SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY created_at DESC, rowid DESC) AS rn FROM jobs) WHERE rn <= ${MAX_JOBS_PER_AGENT})`,
    );
    if (path !== ":memory:") {
      // chmod after opening also tightens permissions on a pre-existing database.
      chmodSync(path, 0o600);
    }
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
        { value: string } | undefined
    )?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  controlId(): string {
    const existing = this.getMeta("control_id");
    if (existing !== undefined) return existing;
    const id = randomUUID();
    this.setMeta("control_id", id);
    return id;
  }

  controlName(fallback: string): string {
    const existing = this.getMeta("control_name");
    if (existing !== undefined) return existing;
    this.setMeta("control_name", fallback);
    return fallback;
  }

  dashboardToken(): string {
    const existing = this.getMeta("dashboard_token");
    if (existing !== undefined) return existing;
    const token = randomBytes(32).toString("base64");
    this.setMeta("dashboard_token", token);
    return token;
  }

  listAgents(): PairedAgent[] {
    return this.db
      .prepare(
        "SELECT peer_id, name, host, port, credential, paired_at FROM agents ORDER BY peer_id",
      )
      .all() as unknown as PairedAgent[];
  }

  getAgent(peerId: string): PairedAgent | undefined {
    return this.db
      .prepare(
        "SELECT peer_id, name, host, port, credential, paired_at FROM agents WHERE peer_id = ?",
      )
      .get(peerId) as PairedAgent | undefined;
  }

  upsertAgent(agent: PairedAgent): void {
    this.db
      .prepare(
        "INSERT INTO agents(peer_id,name,host,port,credential,paired_at) VALUES(?,?,?,?,?,?) ON CONFLICT(peer_id) DO UPDATE SET name=excluded.name, host=excluded.host, port=excluded.port, credential=excluded.credential, paired_at=excluded.paired_at",
      )
      .run(
        agent.peer_id,
        agent.name,
        agent.host,
        agent.port,
        agent.credential,
        agent.paired_at,
      );
  }

  removeAgent(peerId: string): void {
    // Unpairing evicts the whole mirror for that peer, not just the agent
    // row: the jobs mirror is replaced wholesale on every sync (see
    // replaceJobs), and the session mirror is pruned to the latest listing
    // (see upsertSessions), so rows the agent no longer vouches for must not
    // linger in the dashboard after the pairing is gone. Runs, findings and
    // their snapshot meta go the same way: an unpaired agent is unobserved,
    // and its last evaluation must not render as anyone's current state.
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM agents WHERE peer_id = ?").run(peerId);
      this.db.prepare("DELETE FROM jobs WHERE agent_id = ?").run(peerId);
      this.db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(peerId);
      this.db.prepare("DELETE FROM runs WHERE agent_id = ?").run(peerId);
      this.db.prepare("DELETE FROM findings WHERE agent_id = ?").run(peerId);
      this.db
        .prepare("DELETE FROM findings_snapshots WHERE agent_id = ?")
        .run(peerId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.onAgentRemoved?.(peerId);
  }

  listSessions(agentId?: string): CachedSession[] {
    const sql =
      "SELECT agent_id, session_id, project, name, started_at, updated_at, synced_at FROM sessions";
    return (agentId === undefined
      ? this.db.prepare(`${sql} ORDER BY agent_id, session_id`).all()
      : this.db
          .prepare(`${sql} WHERE agent_id = ? ORDER BY session_id`)
          .all(agentId)) as unknown as CachedSession[];
  }

  upsertSession(
    agentId: string,
    session: SessionSummary,
    syncedAt: string,
  ): void {
    // A single inventory delta (ADR 0022): exactly one row, never a prune.
    // Routing a delta through upsertSessions would treat it as a complete
    // listing and delete every other mirrored session for this agent.
    this.db
      .prepare(
        "INSERT INTO sessions(agent_id,session_id,project,name,started_at,updated_at,synced_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id,session_id) DO UPDATE SET project=excluded.project,name=excluded.name,started_at=excluded.started_at,updated_at=excluded.updated_at,synced_at=excluded.synced_at",
      )
      .run(
        agentId,
        session.id,
        session.project,
        session.name ?? null,
        session.started_at,
        session.updated_at,
        syncedAt,
      );
  }

  removeSession(agentId: string, sessionId: string): void {
    // The removal half of a delta: exactly one row for this agent.
    this.db
      .prepare("DELETE FROM sessions WHERE agent_id = ? AND session_id = ?")
      .run(agentId, sessionId);
  }

  removeJob(agentId: string, jobId: string): void {
    // The removal half of a job delta: exactly one row for this agent.
    this.db
      .prepare("DELETE FROM jobs WHERE agent_id = ? AND job_id = ?")
      .run(agentId, jobId);
  }

  /**
   * Apply one run fact (M8-7): exactly one row, never a prune. A run delta
   * routed through `replaceRuns` would treat it as a complete listing and
   * delete every other mirrored run for this agent - the data-loss trap ADR
   * 0022 §4 names for sessions, repeated here for runs.
   */
  upsertRun(agentId: string, run: WatchRun, syncedAt: string): void {
    this.db
      .prepare(
        "INSERT INTO runs(agent_id,run_id,state,liveness_state,liveness_reason,probed_at,status_age_ms,pid,parent_session,child_session,agent,mode,started_at,ended_at,last_update,steps,tokens,cost_usd,error,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,run_id) DO UPDATE SET state=excluded.state,liveness_state=excluded.liveness_state,liveness_reason=excluded.liveness_reason,probed_at=excluded.probed_at,status_age_ms=excluded.status_age_ms,pid=excluded.pid,parent_session=excluded.parent_session,child_session=excluded.child_session,agent=excluded.agent,mode=excluded.mode,started_at=excluded.started_at,ended_at=excluded.ended_at,last_update=excluded.last_update,steps=excluded.steps,tokens=excluded.tokens,cost_usd=excluded.cost_usd,error=excluded.error,synced_at=excluded.synced_at",
      )
      .run(
        agentId,
        run.run_id,
        run.state,
        run.liveness.state,
        run.liveness.reason,
        run.liveness.probed_at,
        run.liveness.status_age_ms,
        run.pid ?? null,
        run.parent_session ?? null,
        run.child_session ?? null,
        run.agent ?? null,
        run.mode ?? null,
        run.started_at,
        run.ended_at ?? null,
        run.last_update ?? null,
        JSON.stringify(run.steps),
        run.tokens === undefined ? null : JSON.stringify(run.tokens),
        run.cost_usd ?? null,
        run.error ?? null,
        syncedAt,
      );
  }

  /** The removal half of a run delta: exactly one row for this agent. */
  removeRun(agentId: string, runId: string): void {
    this.db
      .prepare("DELETE FROM runs WHERE agent_id = ? AND run_id = ?")
      .run(agentId, runId);
  }

  /**
   * Apply a complete run listing (watch bootstrap, sync): runs absent from
   * it are pruned, exactly like `replaceJobs`. Only complete listings may
   * pass through here - never a delta.
   */
  replaceRuns(
    agentId: string,
    runs: readonly WatchRun[],
    syncedAt: string,
  ): void {
    const statement = this.db.prepare(
      "INSERT INTO runs(agent_id,run_id,state,liveness_state,liveness_reason,probed_at,status_age_ms,pid,parent_session,child_session,agent,mode,started_at,ended_at,last_update,steps,tokens,cost_usd,error,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM runs WHERE agent_id = ?").run(agentId);
      for (const run of runs) {
        statement.run(
          agentId,
          run.run_id,
          run.state,
          run.liveness.state,
          run.liveness.reason,
          run.liveness.probed_at,
          run.liveness.status_age_ms,
          run.pid ?? null,
          run.parent_session ?? null,
          run.child_session ?? null,
          run.agent ?? null,
          run.mode ?? null,
          run.started_at,
          run.ended_at ?? null,
          run.last_update ?? null,
          JSON.stringify(run.steps),
          run.tokens === undefined ? null : JSON.stringify(run.tokens),
          run.cost_usd ?? null,
          run.error ?? null,
          syncedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listRuns(agentId?: string): CachedRun[] {
    const sql =
      "SELECT agent_id, run_id, state, liveness_state, liveness_reason, probed_at, status_age_ms, pid, parent_session, child_session, agent, mode, started_at, ended_at, last_update, steps, tokens, cost_usd, error, synced_at FROM runs";
    return (agentId === undefined
      ? this.db.prepare(`${sql} ORDER BY agent_id, run_id`).all()
      : this.db
          .prepare(`${sql} WHERE agent_id = ? ORDER BY run_id`)
          .all(agentId)) as unknown as CachedRun[];
  }

  /**
   * The freshness stamp for one agent's run mirror: the newest mirror write,
   * or null when nothing was ever mirrored. The panel renders rows as current
   * only with this stamp (and a live watch); without it a cached row is
   * stale, never current.
   */
  runsSyncedAt(agentId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT MAX(synced_at) AS synced_at FROM runs WHERE agent_id = ?",
      )
      .get(agentId) as { synced_at: string | null };
    return row.synced_at;
  }

  /**
   * Apply one evaluation pass (M8-7): the set is replaced wholesale, because
   * findings are derived from a single pass and a partial input must never
   * be read as "these are all the findings". `evaluated_at` and coverage
   * are stored with the set so the panel can state age and coverage; a
   * present-but-empty set means "evaluated, none firing".
   */
  replaceFindings(
    agentId: string,
    set: {
      findings: readonly WatchFinding[];
      evaluated_at: string;
      coverage: WatchFindingsCoverage;
    },
    syncedAt: string,
  ): void {
    const statement = this.db.prepare(
      "INSERT INTO findings(agent_id,key,rule,run_id,session_file,summary,observed_at,actual,threshold) VALUES(?,?,?,?,?,?,?,?,?)",
    );
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM findings WHERE agent_id = ?").run(agentId);
      for (const finding of set.findings) {
        statement.run(
          agentId,
          `${finding.rule}\0${finding.run_id ?? finding.session_file ?? ""}`,
          finding.rule,
          finding.run_id ?? null,
          finding.session_file ?? null,
          finding.summary,
          finding.observed_at,
          finding.actual ?? null,
          finding.threshold ?? null,
        );
      }
      this.db
        .prepare(
          "INSERT INTO findings_snapshots(agent_id,evaluated_at,layout_recognised,last_success,last_error,synced_at) VALUES(?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET evaluated_at=excluded.evaluated_at,layout_recognised=excluded.layout_recognised,last_success=excluded.last_success,last_error=excluded.last_error,synced_at=excluded.synced_at",
        )
        .run(
          agentId,
          set.evaluated_at,
          set.coverage.layout_recognised ? 1 : 0,
          set.coverage.last_success,
          set.coverage.last_error,
          syncedAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listFindings(agentId?: string): CachedFinding[] {
    const sql =
      "SELECT agent_id, key, rule, run_id, session_file, summary, observed_at, actual, threshold FROM findings";
    return (agentId === undefined
      ? this.db.prepare(`${sql} ORDER BY agent_id, key`).all()
      : this.db
          .prepare(`${sql} WHERE agent_id = ? ORDER BY key`)
          .all(agentId)) as unknown as CachedFinding[];
  }

  /**
   * The pass a mirrored findings set came from, or undefined when no pass
   * was ever observed. Absence is not "no findings" - the panel says so.
   */
  getFindingsSnapshot(agentId: string): CachedFindingsSnapshot | undefined {
    const row = this.db
      .prepare(
        "SELECT agent_id, evaluated_at, layout_recognised, last_success, last_error, synced_at FROM findings_snapshots WHERE agent_id = ?",
      )
      .get(agentId) as
      | {
          agent_id: string;
          evaluated_at: string;
          layout_recognised: number;
          last_success: string | null;
          last_error: string | null;
          synced_at: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      agent_id: row.agent_id,
      evaluated_at: row.evaluated_at,
      layout_recognised: row.layout_recognised === 1,
      last_success: row.last_success,
      last_error: row.last_error,
      synced_at: row.synced_at,
    };
  }

  /**
   * Apply one inventory job fact (ADR 0022) without inferring absence.
   * A watched job carries identity and lifecycle state only (WatchJob), not
   * the full row sync reports, so an unknown job is inserted with the
   * columns sync owns left blank for the next listing to fill in - and a
   * known job keeps the columns the watch cannot see. Absence from a delta
   * is never a removal signal: only `replaceJobs` and `replaceWatchJobs`
   * treat their input as complete.
   */
  applyWatchJob(
    agentId: string,
    job: { job_id: string; session_id: string | null; state: string },
    createdAtFallback: string,
  ): void {
    const existing = this.db
      .prepare(
        "SELECT project, pid, created_at FROM jobs WHERE agent_id = ? AND job_id = ?",
      )
      .get(agentId, job.job_id) as
      { project: string; pid: number | null; created_at: string } | undefined;
    if (existing === undefined) {
      this.db
        .prepare(
          "INSERT INTO jobs(agent_id,job_id,session_id,pid,project,created_at,state) VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id,job_id) DO UPDATE SET session_id=excluded.session_id,state=excluded.state",
        )
        .run(
          agentId,
          job.job_id,
          job.session_id,
          null,
          "",
          createdAtFallback,
          job.state,
        );
    } else {
      this.db
        .prepare(
          "UPDATE jobs SET session_id = ?, state = ? WHERE agent_id = ? AND job_id = ?",
        )
        .run(job.session_id, job.state, agentId, job.job_id);
    }
    // Per AGENT, matching upsertJob: the mirror never grows past the agent's
    // own retention by way of this control plane's writes.
    this.db
      .prepare(
        `DELETE FROM jobs WHERE agent_id = ? AND rowid NOT IN (SELECT rowid FROM jobs WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_JOBS_PER_AGENT})`,
      )
      .run(agentId, agentId);
  }

  /**
   * Apply a watch snapshot's job list as a COMPLETE listing (ADR 0022
   * bootstrap): jobs absent from it are removed, exactly like `replaceJobs`.
   * Columns the watch cannot see are carried over from the rows being
   * replaced, so a snapshot never blanks what only sync reports.
   */
  replaceWatchJobs(
    agentId: string,
    jobs: ReadonlyArray<{
      job_id: string;
      session_id: string | null;
      state: string;
    }>,
    createdAtFallback: string,
  ): void {
    const known = new Map<
      string,
      { pid: number | null; project: string; created_at: string }
    >();
    for (const row of this.db
      .prepare(
        "SELECT job_id, pid, project, created_at FROM jobs WHERE agent_id = ?",
      )
      .all(agentId) as Array<{
      job_id: string;
      pid: number | null;
      project: string;
      created_at: string;
    }>) {
      known.set(row.job_id, {
        pid: row.pid,
        project: row.project,
        created_at: row.created_at,
      });
    }
    const statement = this.db.prepare(
      "INSERT INTO jobs(agent_id,job_id,session_id,pid,project,created_at,state) VALUES(?,?,?,?,?,?,?)",
    );
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM jobs WHERE agent_id = ?").run(agentId);
      for (const job of jobs) {
        const prior = known.get(job.job_id);
        statement.run(
          agentId,
          job.job_id,
          job.session_id,
          prior?.pid ?? null,
          prior?.project ?? "",
          prior?.created_at ?? createdAtFallback,
          job.state,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertSessions(
    agentId: string,
    sessions: readonly SessionSummary[],
    syncedAt: string,
  ): void {
    const statement = this.db.prepare(
      "INSERT INTO sessions(agent_id,session_id,project,name,started_at,updated_at,synced_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id,session_id) DO UPDATE SET project=excluded.project,name=excluded.name,started_at=excluded.started_at,updated_at=excluded.updated_at,synced_at=excluded.synced_at",
    );
    this.db.exec("BEGIN");
    try {
      for (const session of sessions)
        statement.run(
          agentId,
          session.id,
          session.project,
          session.name ?? null,
          session.started_at,
          session.updated_at,
          syncedAt,
        );
      // The listing is the agent's full session list, so a mirrored row whose
      // id is absent no longer exists there and is pruned. Only ids outside
      // this listing are removed, and only for this agent: a session the
      // agent still lists is never deleted. There is deliberately no lifecycle
      // state on the row (see SessionSummary.updated_at in
      // packages/protocol/src/types.ts); absence from the listing is the
      // removal signal, the same way replaceJobs treats the jobs mirror.
      if (sessions.length === 0) {
        this.db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agentId);
      } else {
        const placeholders = sessions.map(() => "?").join(",");
        this.db
          .prepare(
            `DELETE FROM sessions WHERE agent_id = ? AND session_id NOT IN (${placeholders})`,
          )
          .run(agentId, ...sessions.map((session) => session.id));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertJob(job: CachedJob): void {
    this.db
      .prepare(
        "INSERT INTO jobs(agent_id,job_id,session_id,pid,project,created_at,state) VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id,job_id) DO UPDATE SET session_id=excluded.session_id,pid=excluded.pid,project=excluded.project,created_at=excluded.created_at,state=excluded.state",
      )
      .run(
        job.agent_id,
        job.job_id,
        job.session_id,
        job.pid,
        job.project,
        job.created_at,
        job.state,
      );
    // Per AGENT, not global. A global bound let one agent's spawn evict
    // another agent's mirrored rows while that agent's freshness mark stayed
    // set, so the dashboard showed a "from the agent" list with rows missing.
    this.db
      .prepare(
        `DELETE FROM jobs WHERE agent_id = ? AND rowid NOT IN (SELECT rowid FROM jobs WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_JOBS_PER_AGENT})`,
      )
      .run(job.agent_id, job.agent_id);
  }

  replaceJobs(
    agentId: string,
    rows: readonly Omit<CachedJob, "agent_id">[],
  ): void {
    const statement = this.db.prepare(
      "INSERT INTO jobs(agent_id,job_id,session_id,pid,project,created_at,state) VALUES(?,?,?,?,?,?,?)",
    );
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM jobs WHERE agent_id = ?").run(agentId);
      for (const row of rows) {
        statement.run(
          agentId,
          row.job_id,
          row.session_id,
          row.pid,
          row.project,
          row.created_at,
          row.state,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listJobs(agentId?: string): CachedJob[] {
    const sql =
      "SELECT agent_id, job_id, session_id, pid, project, created_at, state FROM jobs";
    return (agentId === undefined
      ? this.db.prepare(`${sql} ORDER BY agent_id, job_id`).all()
      : this.db
          .prepare(`${sql} WHERE agent_id = ? ORDER BY job_id`)
          .all(agentId)) as unknown as CachedJob[];
  }

  /**
   * Returns whether a row actually changed. A stop for a job this cache has
   * never seen updates nothing, and must not count as a write: the caller uses
   * that answer to decide whether the mirror is still the agent's.
   */
  setJobState(agentId: string, jobId: string, state: string): boolean {
    const result = this.db
      .prepare("UPDATE jobs SET state = ? WHERE agent_id = ? AND job_id = ?")
      .run(state, agentId, jobId);
    return result.changes > 0;
  }

  countEvents(agentId: string, sessionId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE agent_id = ? AND session_id = ?",
        )
        .get(agentId, sessionId) as { count: number }
    ).count;
  }

  listEvents(agentId: string, sessionId: string): CachedEvent[] {
    return this.db
      .prepare(
        "SELECT agent_id, session_id, entry_id, type, timestamp, data FROM events WHERE agent_id = ? AND session_id = ? ORDER BY rowid",
      )
      .all(agentId, sessionId) as unknown as CachedEvent[];
  }

  listEventPage(
    agentId: string,
    sessionId: string,
    limit: number,
    before?: string,
  ): { events: CachedEvent[]; hasEarlier: boolean } {
    const rows =
      before === undefined
        ? this.db
            .prepare(
              "SELECT agent_id, session_id, entry_id, type, timestamp, data FROM events WHERE agent_id = ? AND session_id = ? ORDER BY rowid DESC LIMIT ?",
            )
            .all(agentId, sessionId, limit + 1)
        : this.db
            .prepare(
              "SELECT agent_id, session_id, entry_id, type, timestamp, data FROM events WHERE agent_id = ? AND session_id = ? AND rowid < (SELECT rowid FROM events WHERE agent_id = ? AND session_id = ? AND entry_id = ?) ORDER BY rowid DESC LIMIT ?",
            )
            .all(agentId, sessionId, agentId, sessionId, before, limit + 1);
    const hasEarlier = rows.length > limit;
    const events = rows.slice(0, limit).reverse() as unknown as CachedEvent[];
    return { events, hasEarlier };
  }

  upsertEvents(
    agentId: string,
    sessionId: string,
    events: readonly Event[],
  ): void {
    const statement = this.db.prepare(
      // DO NOTHING, not DO UPDATE. Session entries are append-only (AGENTS.md);
      // rewriting a cached entry would mutate history the source never mutated.
      "INSERT INTO events(agent_id,session_id,entry_id,type,timestamp,data) VALUES(?,?,?,?,?,?) ON CONFLICT(agent_id,session_id,entry_id) DO NOTHING",
    );
    this.db.exec("BEGIN");
    try {
      for (const event of events)
        statement.run(
          agentId,
          sessionId,
          event.entryId,
          event.type,
          event.timestamp,
          JSON.stringify(event.data),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
