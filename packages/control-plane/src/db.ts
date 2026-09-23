// SPDX-License-Identifier: GPL-3.0-or-later

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { Event, SessionSummary } from "@pi-mesh/protocol";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

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

export class ControlStore {
  private readonly db: DatabaseSyncType;
  private readonly now: () => number;

  constructor(path: string, options: { now?: () => number } = {}) {
    if (path !== ":memory:") {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    this.now = options.now ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS agents (peer_id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, credential TEXT NOT NULL, paired_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (agent_id TEXT NOT NULL, session_id TEXT NOT NULL, project TEXT NOT NULL, name TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT NOT NULL, PRIMARY KEY(agent_id, session_id)) STRICT;
      CREATE TABLE IF NOT EXISTS events (agent_id TEXT NOT NULL, session_id TEXT NOT NULL, entry_id TEXT NOT NULL, type TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(agent_id, session_id, entry_id)) STRICT;
    `);
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
    this.db.prepare("DELETE FROM agents WHERE peer_id = ?").run(peerId);
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
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listEvents(agentId: string, sessionId: string): CachedEvent[] {
    return this.db
      .prepare(
        "SELECT agent_id, session_id, entry_id, type, timestamp, data FROM events WHERE agent_id = ? AND session_id = ? ORDER BY rowid",
      )
      .all(agentId, sessionId) as unknown as CachedEvent[];
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
