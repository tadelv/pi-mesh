// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile, stat } from "node:fs/promises";
import type { SessionSummary, WatchFrame, WatchJob } from "@pi-mesh/protocol";
import type { JobManager } from "./jobs.js";
import {
  defaultSessionsRoot,
  parseSession,
  sessionFiles,
  summarizeParsed,
  SessionStore,
  type SessionParseError,
} from "./sessions.js";

export interface SessionWatchOptions {
  /** Override the normal ~/.pi/agent/sessions directory, principally for tests. */
  sessionsRoot?: string;
  onError?: (error: SessionParseError) => void;
  /**
   * Fast-path interval: stat the enumerated session files and reparse only
   * the paths whose metadata differs. Polling, not fs.watch: fs.watch is
   * platform-inconsistent and can miss events, which a standing subscription
   * cannot tolerate (the same reason session.stream polls).
   */
  pollIntervalMs?: number;
  /**
   * Slow-path interval: a full re-list while connected, which repairs a
   * change the fast path silently missed (same-size rewrite inside one
   * timestamp tick, a dropped stat). Reconciliation on close alone cannot
   * repair a miss that never closes.
   */
  reconcileIntervalMs?: number;
  /**
   * Bound on queued frames. When a burst overflows the buffer the oldest
   * frame is dropped and a `{ type: "dropped", reason, dropped }` marker is
   * queued in its place, so a gap is stated, never silent. A subscriber that
   * stops reading is disconnected by the transport rather than buffered
   * without bound.
   */
  maxBufferedFrames?: number;
  /** Optional jobs plane: job state changes are inventory facts too. */
  jobs?: JobManager;
  /**
   * Injectable stat for tests: return stale metadata to simulate a change the
   * index missed, then let the reconciliation pass repair it. Defaults to the
   * filesystem.
   */
  stat?: (path: string) => Promise<{ mtimeMs: number; size: number }>;
}

interface Waiter {
  resolve: (result: IteratorResult<WatchFrame>) => void;
}

interface PathState {
  mtimeMs: number;
  size: number;
  /** Last successfully summarized id at this path; retained across a skippable read. */
  id: string;
  summary: SessionSummary;
}

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_RECONCILE_MS = 15_000;
const DEFAULT_MAX_BUFFERED = 128;

export const WATCH_DROPPED_REASON =
  "watch buffer overflow: oldest frames were dropped; re-list to converge";

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function summariesEqual(a: SessionSummary, b: SessionSummary): boolean {
  return (
    a.id === b.id &&
    a.project === b.project &&
    (a.name ?? undefined) === (b.name ?? undefined) &&
    a.started_at === b.started_at &&
    a.updated_at === b.updated_at
  );
}

function jobSummary(value: {
  id: string;
  sessionId?: string | null | undefined;
  state: string;
}): WatchJob {
  return {
    job_id: value.id,
    session_id: value.sessionId ?? null,
    state: value.state,
  };
}

function jobsEqual(a: WatchJob, b: WatchJob): boolean {
  return (
    a.job_id === b.job_id &&
    a.session_id === b.session_id &&
    a.state === b.state
  );
}

/**
 * A read-only, independently stoppable inventory subscription over one
 * machine's session files (plus, when a JobManager is provided, its jobs).
 *
 * Frames carry inventory facts only - added / updated / removed sessions and
 * job state changes - and never transcript entries. The subscription starts
 * with one complete listing produced by the same `SessionStore.list()` code
 * as sync, then emits deltas: the fast path stats the enumerated session
 * files and reparses only changed paths, while a slower pass re-lists in
 * full to repair a silently missed change.
 */
export class SessionWatch implements AsyncIterableIterator<WatchFrame> {
  private readonly sessionsRoot: string;
  private readonly store: SessionStore;
  private readonly onError: ((error: SessionParseError) => void) | undefined;
  private readonly pollIntervalMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly maxBufferedFrames: number;
  private readonly jobs: JobManager | undefined;
  private readonly statFn: (
    path: string,
  ) => Promise<{ mtimeMs: number; size: number }>;
  private readonly queue: WatchFrame[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly ready: Promise<void>;
  /** Last metadata seen per path. Compared for INEQUALITY, not increase: a clock that steps backwards is still a change. */
  private readonly index = new Map<string, { mtimeMs: number; size: number }>();
  private readonly paths = new Map<string, PathState>();
  /** The sessions truth last emitted, by id. Both the fast path and the reconciliation pass converge on it. */
  private readonly byId = new Map<string, SessionSummary>();
  private readonly jobsById = new Map<string, WatchJob>();
  private dropped = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private pollPromise: Promise<void> | undefined;
  private stopped = false;

  constructor(options: SessionWatchOptions = {}) {
    this.sessionsRoot = options.sessionsRoot ?? defaultSessionsRoot();
    this.store = new SessionStore({
      sessionsRoot: this.sessionsRoot,
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
    this.onError = options.onError;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error("pollIntervalMs must be a positive finite number");
    }
    this.reconcileIntervalMs =
      options.reconcileIntervalMs ?? DEFAULT_RECONCILE_MS;
    if (
      !Number.isFinite(this.reconcileIntervalMs) ||
      this.reconcileIntervalMs <= 0
    ) {
      throw new Error("reconcileIntervalMs must be a positive finite number");
    }
    this.maxBufferedFrames =
      options.maxBufferedFrames ?? DEFAULT_MAX_BUFFERED;
    if (
      !Number.isFinite(this.maxBufferedFrames) ||
      this.maxBufferedFrames < 1
    ) {
      throw new Error("maxBufferedFrames must be a finite number >= 1");
    }
    this.jobs = options.jobs;
    this.statFn =
      options.stat ??
      (async (path: string) => {
        const value = await stat(path);
        return { mtimeMs: value.mtimeMs, size: value.size };
      });
    this.ready = this.initialize();
    // A consumer need not attach until a later tick, and an unhandled
    // rejection here would be process-fatal.
    this.ready.catch(() => undefined);
  }

  /**
   * Bootstrap: one complete listing through the existing SessionStore.list()
   * path, then the per-path index over the enumerated files. The listing is
   * the frame; the index is the baseline the first delta compares against,
   * so nothing present at connect is ever reported as added.
   */
  private async initialize(): Promise<void> {
    const sessions = await this.store.list();
    if (this.stopped) return;
    for (const summary of sessions) this.byId.set(summary.id, summary);
    for (const job of this.currentJobs()) this.jobsById.set(job.job_id, job);
    await this.rebuildIndex();
    if (this.stopped) return;
    this.enqueue({
      type: "snapshot",
      sessions: [...this.byId.values()],
      jobs: [...this.jobsById.values()],
    });
    this.schedule();
  }

  private currentJobs(): WatchJob[] {
    if (this.jobs === undefined) return [];
    return this.jobs
      .list()
      .map((job) =>
        jobSummary({ id: job.id, sessionId: job.sessionId, state: job.state }),
      );
  }

  /** Stat every enumerated file and record the generation the deltas compare against. */
  private async rebuildIndex(): Promise<void> {
    let files: string[];
    try {
      files = await sessionFiles(this.sessionsRoot);
    } catch {
      files = [];
    }
    this.index.clear();
    for (const file of files) {
      try {
        this.index.set(file, await this.statFn(file));
      } catch {
        // A file that disappears mid-bootstrap is a removal or a retry, never
        // a crash: the first poll observes whatever it finds.
        continue;
      }
    }
    this.paths.clear();
    for (const file of files) {
      // Silent: the bootstrap listing above already reported every skip
      // through the store, and double-reporting would read as two problems.
      const summarized = await this.summarizeFile(file, false);
      if (summarized !== undefined) this.paths.set(file, summarized);
    }
  }

  /**
   * Read and reduce one session file. A file that disappears mid-read is
   * undefined (a removal or a retry, never a crash); a file with no complete
   * header or an unaddressable id is skipped with a stated reason, never
   * emitted as an empty session.
   */
  private async summarizeFile(
    file: string,
    report = true,
  ): Promise<
    { mtimeMs: number; size: number; id: string; summary: SessionSummary } | undefined
  > {
    let meta: { mtimeMs: number; size: number };
    try {
      meta = await this.statFn(file);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let raw: Awaited<ReturnType<typeof readFile>>;
    try {
      raw = await readFile(file);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const reduced = summarizeParsed(parseSession(raw, file), file);
    if ("skipped" in reduced) {
      if (report) {
        this.onError?.({ line: 1, message: reduced.skipped, path: file });
      }
      return undefined;
    }
    return { ...meta, id: reduced.summary.id, summary: reduced.summary };
  }

  private enqueue(frame: WatchFrame): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: frame, done: false });
      return;
    }
    this.queue.push(frame);
    if (this.queue.length > this.maxBufferedFrames) {
      // Drop the oldest non-marker frame first: the marker describes the gap,
      // so evicting it would make the truncation silent again.
      let evict = this.queue.findIndex((entry) => entry.type !== "dropped");
      if (evict === -1) evict = 0;
      this.queue.splice(evict, 1);
      this.dropped += 1;
      const marker: WatchFrame = {
        type: "dropped",
        reason: WATCH_DROPPED_REASON,
        dropped: this.dropped,
      };
      if (this.queue[0]?.type === "dropped") this.queue[0] = marker;
      else this.queue.unshift(marker);
      // The marker counts against the bound: evict from behind it, never the
      // frame just described, and never the marker itself while real frames
      // remain to describe.
      while (this.queue.length > this.maxBufferedFrames) {
        const next = this.queue.findIndex(
          (_entry, position) => position > 0 && _entry.type !== "dropped",
        );
        if (next === -1) break;
        this.queue.splice(next, 1);
      }
    }
  }

  private emitSessionDeltas(current: Map<string, SessionSummary>): void {
    for (const [id, summary] of current) {
      const previous = this.byId.get(id);
      if (previous === undefined) {
        this.byId.set(id, summary);
        this.enqueue({ type: "added", session: summary });
      } else if (!summariesEqual(previous, summary)) {
        this.byId.set(id, summary);
        this.enqueue({ type: "updated", session: summary });
      }
    }
    for (const id of [...this.byId.keys()]) {
      if (!current.has(id)) {
        this.byId.delete(id);
        this.enqueue({ type: "removed", id });
      }
    }
  }

  private emitJobDeltas(): void {
    if (this.jobs === undefined) return;
    const current = new Map<string, WatchJob>();
    for (const job of this.currentJobs()) current.set(job.job_id, job);
    for (const [id, job] of current) {
      const previous = this.jobsById.get(id);
      if (previous === undefined || !jobsEqual(previous, job)) {
        this.jobsById.set(id, job);
        this.enqueue({ type: "job", job });
      }
    }
    for (const id of [...this.jobsById.keys()]) {
      if (!current.has(id)) {
        this.jobsById.delete(id);
        this.enqueue({ type: "job-removed", job_id: id });
      }
    }
  }

  /**
   * One fast-path pass: stat the enumerated files, reparse only the paths
   * whose metadata differs (compared for inequality, so a backwards clock is
   * a change), and reconcile the path set by session id (so a rename is not
   * a false delete). Two writes inside one poll coalesce to a single frame.
   */
  async poll(): Promise<void> {
    await this.ready;
    await this.pollNow();
  }

  private pollNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pollPromise !== undefined) return this.pollPromise;
    this.pollPromise = this.pollFiles().finally(() => {
      this.pollPromise = undefined;
    });
    return this.pollPromise;
  }

  private async pollFiles(): Promise<void> {
    if (this.stopped) return;
    let files: string[];
    try {
      files = await sessionFiles(this.sessionsRoot);
    } catch {
      return;
    }
    const present = new Set(files);
    // A path absent from the enumeration is gone even if it was never
    // statted: drop its cached state so the id diff below reports it.
    for (const path of [...this.paths.keys()]) {
      if (!present.has(path)) this.paths.delete(path);
    }
    for (const file of files) {
      let meta: { mtimeMs: number; size: number } | undefined;
      try {
        meta = await this.statFn(file);
      } catch (error) {
        if (isMissing(error)) {
          // A stat/read race: the file disappeared mid-read. Drop the cached
          // state; the id diff reports a removal only if no other path still
          // carries the id (which is exactly the rename case).
          this.paths.delete(file);
          this.index.delete(file);
          continue;
        }
        throw error;
      }
      const previous = this.index.get(file);
      if (
        previous !== undefined &&
        previous.mtimeMs === meta.mtimeMs &&
        previous.size === meta.size
      ) {
        continue;
      }
      this.index.set(file, meta);
      const summarized = await this.summarizeFile(file);
      if (summarized === undefined) {
        // Skipped (no complete header, unaddressable id) or vanished
        // mid-read: retain the previously emitted summary rather than
        // reporting a removal for a file that may be mid-rewrite. The
        // reconciliation pass re-lists in full and converges if the file
        // stays unreadable.
        continue;
      }
      this.paths.set(file, summarized);
    }
    const current = new Map<string, SessionSummary>();
    for (const state of this.paths.values()) {
      current.set(state.id, state.summary);
    }
    this.emitSessionDeltas(current);
    this.emitJobDeltas();
  }

  /**
   * The slow path, run periodically WHILE CONNECTED: a full re-list that
   * repairs a change the index silently missed. Never infers absence from a
   * partial input on its own - it diffs the complete listing against the
   * emitted truth, which is exactly what a re-list is.
   */
  async reconcile(): Promise<void> {
    await this.ready;
    if (this.stopped) return;
    const sessions = await this.store.list();
    if (this.stopped) return;
    const current = new Map<string, SessionSummary>();
    for (const summary of sessions) current.set(summary.id, summary);
    this.emitSessionDeltas(current);
    // Repair the index too, so the next fast pass does not refire what the
    // re-list just converged.
    await this.rebuildIndex();
    this.emitJobDeltas();
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.pollTimer === undefined) {
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        void this.pollNow()
          .finally(() => this.schedule())
          .catch(() => undefined);
      }, this.pollIntervalMs);
      this.pollTimer.unref?.();
    }
    if (this.reconcileTimer === undefined) {
      this.reconcileTimer = setTimeout(() => {
        this.reconcileTimer = undefined;
        void this.reconcile()
          .finally(() => this.schedule())
          .catch(() => undefined);
      }, this.reconcileIntervalMs);
      this.reconcileTimer.unref?.();
    }
  }

  async next(): Promise<IteratorResult<WatchFrame>> {
    await this.ready;
    const item = this.queue.shift();
    if (item !== undefined) return { value: item, done: false };
    if (this.stopped) return { value: undefined, done: true };
    return new Promise<IteratorResult<WatchFrame>>((resolve) => {
      this.waiters.push({ resolve });
    });
  }

  async return(): Promise<IteratorResult<WatchFrame>> {
    await this.stop();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<WatchFrame> {
    return this;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      await this.ready.catch(() => undefined);
      return;
    }
    this.stopped = true;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    if (this.reconcileTimer !== undefined) clearTimeout(this.reconcileTimer);
    this.pollTimer = undefined;
    this.reconcileTimer = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
    await this.ready.catch(() => undefined);
    await this.pollPromise?.catch(() => undefined);
  }
}

export function sessionWatch(options?: SessionWatchOptions): SessionWatch {
  return new SessionWatch(options);
}
