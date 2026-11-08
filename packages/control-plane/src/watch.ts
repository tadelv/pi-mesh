// SPDX-License-Identifier: GPL-3.0-or-later

import type {
  SessionSummary,
  WatchFinding,
  WatchFindingsCoverage,
  WatchFrame,
  WatchJob,
  WatchRun,
} from "@pi-mesh/protocol";
import type { AgentTarget } from "./client.js";
import { streamAgent } from "./client.js";
import type { ControlStore, PairedAgent } from "./db.js";

/** How a browser SSE subscriber is told the mirror changed. */
export interface WatchListener {
  onWatchEvent(agentId: string): void;
}

/** Open one inventory stream for an agent; tests inject a hand-driven fake. */
export type WatchOpener = (
  target: AgentTarget,
  signal: AbortSignal,
) => AsyncGenerator<WatchFrame>;

export interface WatchManagerOptions {
  store: ControlStore;
  controlId: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Re-list one agent through the existing sync code path. */
  resyncAgent: (agentId: string) => Promise<unknown>;
  opener?: WatchOpener;
  /** First reconnect delay; doubles per attempt up to maxMs, plus jitter. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Fraction of the delay added as uniform jitter (0 disables it). */
  jitterRatio?: number;
  random?: () => number;
  /** Injectable clock so a test observes the backoff without waiting it out. */
  sleep?: (ms: number) => Promise<void>;
  listener?: WatchListener;
}

function watchTarget(agent: PairedAgent): AgentTarget {
  return {
    peerId: agent.peer_id,
    host: agent.host,
    port: agent.port,
    credential: agent.credential,
  };
}

function isWatchFrame(value: unknown): value is WatchFrame {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "snapshot" ||
    type === "added" ||
    type === "updated" ||
    type === "removed" ||
    type === "job" ||
    type === "job-removed" ||
    type === "run" ||
    type === "run-removed" ||
    type === "findings" ||
    type === "dropped"
  );
}

const DEFAULT_BASE_MS = 250;
const DEFAULT_MAX_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.25;

/**
 * One `mesh.watch` subscription per agent per control-plane process (ADR 0022),
 * shared by every browser and every request that needs it - the shape ADR 0018
 * already uses for session streams. The first frame is a snapshot applied as a
 * COMPLETE listing; every later frame is an explicit per-row operation, never
 * routed through `upsertSessions` (which would prune the agent's other rows).
 */
export class WatchManager {
  private readonly store: ControlStore;
  private readonly controlId: string;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;
  private readonly now: () => number;
  private readonly resyncAgent: (agentId: string) => Promise<unknown>;
  private readonly opener: WatchOpener;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly listener: WatchListener | undefined;
  private readonly upstreams = new Map<string, WatchUpstream>();
  private readonly stale = new Set<string>();

  constructor(options: WatchManagerOptions) {
    this.store = options.store;
    this.controlId = options.controlId;
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
    this.resyncAgent = options.resyncAgent;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_MAX_MS;
    this.jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    this.random = options.random ?? Math.random;
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.listener = options.listener;
    const fetchImpl = this.fetchImpl;
    const controlId = this.controlId;
    this.opener =
      options.opener ??
      async function* (
        target: AgentTarget,
        signal: AbortSignal,
      ): AsyncGenerator<WatchFrame> {
        const frames = streamAgent(
          target,
          "mesh.watch",
          {},
          {
            controlId,
            ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
          },
          signal,
        );
        for await (const frame of frames) {
          if (frame.kind === "task") continue;
          if (!isWatchFrame(frame.value)) {
            throw new Error("Agent sent a malformed mesh.watch frame");
          }
          yield frame.value;
        }
      };
  }

  /** Subscribe only when the advertisement includes `mesh.watch` (ADR 0022 §7). */
  ensureAgent(agent: PairedAgent, skills: readonly string[] | null): void {
    if (!skills?.includes("mesh.watch")) {
      // No capability, no subscription. A withdrawn capability closes the
      // stream the same way an unpair does, but the rows stay: the listing is
      // still the agent's, only the live feed is gone. The entry is removed
      // so a re-advertised capability starts a fresh subscription, and the
      // stale mark goes with it: "off" means no feed, not a feed owed.
      this.upstreams.get(agent.peer_id)?.close(true);
      this.upstreams.delete(agent.peer_id);
      this.stale.delete(agent.peer_id);
      return;
    }
    let upstream = this.upstreams.get(agent.peer_id);
    if (upstream === undefined) {
      upstream = new WatchUpstream(
        agent,
        this.store,
        this.opener,
        {
          now: this.now,
          resync: () => this.resyncAgent(agent.peer_id),
          markStale: () => this.stale.add(agent.peer_id),
          markLive: () => {
            this.stale.delete(agent.peer_id);
            this.listener?.onWatchEvent(agent.peer_id);
          },
          notify: () => this.listener?.onWatchEvent(agent.peer_id),
        },
        {
          baseMs: this.backoffBaseMs,
          maxMs: this.backoffMaxMs,
          jitterRatio: this.jitterRatio,
          random: this.random,
          sleep: this.sleep,
        },
      );
      this.upstreams.set(agent.peer_id, upstream);
      upstream.start();
    } else {
      upstream.retarget(agent);
    }
  }

  /** Explicit close: unpair evicts the mirror, so there is nothing to re-list. */
  closeAgent(peerId: string): void {
    this.upstreams.get(peerId)?.close(true);
    this.upstreams.delete(peerId);
    this.stale.delete(peerId);
  }

  /** Explicit close: shutdown takes every subscription down with the process. */
  closeAll(): void {
    for (const upstream of this.upstreams.values()) upstream.close(true);
    this.upstreams.clear();
    this.stale.clear();
  }

  /** A close marked this agent's mirror stale and a re-list is (or was) due. */
  isStale(peerId: string): boolean {
    return this.stale.has(peerId);
  }

  /** The subscription state the dashboard reports per agent (ADR 0022 §7). */
  status(peerId: string): "live" | "stale" | "off" {
    if (!this.upstreams.has(peerId)) return "off";
    return this.stale.has(peerId) ? "stale" : "live";
  }

  get size(): number {
    return this.upstreams.size;
  }
}

interface UpstreamCallbacks {
  now: () => number;
  resync: () => Promise<unknown>;
  markStale: () => void;
  markLive: () => void;
  notify: () => void;
}

interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  jitterRatio: number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** The held socket for one agent: snapshot, then deltas, then backoff. */
class WatchUpstream {
  private agent: PairedAgent;
  private readonly store: ControlStore;
  private readonly opener: WatchOpener;
  private readonly callbacks: UpstreamCallbacks;
  private readonly backoff: BackoffOptions;
  private abort: AbortController | undefined;
  private running: Promise<void> | undefined;
  private closed = false;
  private attempts = 0;

  constructor(
    agent: PairedAgent,
    store: ControlStore,
    opener: WatchOpener,
    callbacks: UpstreamCallbacks,
    backoff: BackoffOptions,
  ) {
    this.agent = agent;
    this.store = store;
    this.opener = opener;
    this.callbacks = callbacks;
    this.backoff = backoff;
  }

  retarget(agent: PairedAgent): void {
    this.agent = agent;
  }

  start(): void {
    if (this.closed || this.running !== undefined) return;
    this.running = this.loop();
    // A rejection here is process-fatal; the loop itself never rejects.
    this.running.catch(() => undefined);
  }

  /** Explicit close (unpair, shutdown, capability withdrawn): no reconnect. */
  close(explicit: boolean): void {
    if (explicit) this.closed = true;
    this.abort?.abort();
  }

  private delayMs(): number {
    const exponential = Math.min(
      this.backoff.maxMs,
      this.backoff.baseMs * 2 ** this.attempts,
    );
    return exponential * (1 + this.backoff.jitterRatio * this.backoff.random());
  }

  private applySnapshot(frame: {
    sessions: SessionSummary[];
    jobs: WatchJob[];
    runs?: WatchRun[];
    findings?: {
      findings: WatchFinding[];
      evaluated_at: string;
      coverage: WatchFindingsCoverage;
    };
  }): void {
    const at = new Date(this.callbacks.now()).toISOString();
    // COMPLETE listing through the existing path: rows absent from the
    // snapshot are pruned, exactly as a sync would prune them. Runs and
    // findings ride the same bootstrap (M8-7) - but only when present:
    // absent means this agent does not report them (older version), and
    // must leave the mirror alone rather than read as "none".
    this.store.upsertSessions(this.agent.peer_id, frame.sessions, at);
    this.store.replaceWatchJobs(this.agent.peer_id, frame.jobs, at);
    if (frame.runs !== undefined) {
      this.store.replaceRuns(this.agent.peer_id, frame.runs, at);
    }
    if (frame.findings !== undefined) {
      this.store.replaceFindings(this.agent.peer_id, frame.findings, at);
    }
  }

  private applyDelta(frame: WatchFrame): void {
    const at = new Date(this.callbacks.now()).toISOString();
    // Explicit per-row operations: a delta is NEVER a complete listing, so it
    // must never pass through upsertSessions (db.ts prunes absence there).
    switch (frame.type) {
      case "snapshot":
        this.applySnapshot(frame);
        break;
      case "added":
      case "updated":
        this.store.upsertSession(this.agent.peer_id, frame.session, at);
        break;
      case "removed":
        this.store.removeSession(this.agent.peer_id, frame.id);
        break;
      case "job":
        this.store.applyWatchJob(this.agent.peer_id, frame.job, at);
        break;
      case "job-removed":
        this.store.removeJob(this.agent.peer_id, frame.job_id);
        break;
      case "run":
        // Explicit per-row operation, never replaceRuns: a delta is not a
        // complete listing (the data-loss trap ADR 0022 §4 names).
        this.store.upsertRun(this.agent.peer_id, frame.run, at);
        break;
      case "run-removed":
        this.store.removeRun(this.agent.peer_id, frame.run_id);
        break;
      case "findings":
        // One evaluation pass replaces the previous set wholesale: a
        // partial input must never read as "these are all the findings".
        this.store.replaceFindings(
          this.agent.peer_id,
          {
            findings: frame.findings,
            evaluated_at: frame.evaluated_at,
            coverage: frame.coverage,
          },
          at,
        );
        break;
      case "dropped":
        // A stated gap, never a silent one: re-list once to converge while the
        // stream itself stays open.
        void this.callbacks.resync().catch(() => undefined);
        break;
    }
  }

  private async loop(): Promise<void> {
    for (;;) {
      if (this.closed) return;
      this.abort = new AbortController();
      const signal = this.abort.signal;
      // Assigned on every path below: a clean stream end in try, any throw
      // in catch. The initial value would never survive to the read.
      let sawClose: boolean;
      try {
        let first = true;
        for await (const frame of this.opener(
          watchTarget(this.agent),
          signal,
        )) {
          if (this.closed || signal.aborted) break;
          if (first) {
            first = false;
            // The subscription starts with one complete listing. Anything else
            // first is a protocol violation, not a delta: close and re-list.
            if (frame.type !== "snapshot") break;
          }
          this.applyDelta(frame);
          this.attempts = 0;
          this.callbacks.markLive();
        }
        sawClose = !this.closed && !signal.aborted;
      } catch {
        sawClose = !this.closed;
      }
      if (this.closed) return;
      // Any close - clean, error, backoff, capability withdrawn - marks the
      // mirror stale and re-lists once through the existing sync code path.
      this.callbacks.markStale();
      this.callbacks.notify();
      try {
        await this.callbacks.resync();
      } catch {
        // The re-list failing must not take the reconnect down with it.
      }
      if (this.closed) return;
      if (!sawClose) return;
      const delay = this.delayMs();
      this.attempts += 1;
      await this.backoff.sleep(delay);
    }
  }
}
