// SPDX-License-Identifier: GPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  createLogger,
  ErrorCode,
  PiMeshError,
  type Logger,
} from "@pi-mesh/shared";

const DEFAULT_MAX_JOBS = 4;
const DEFAULT_UNACKNOWLEDGED_TTL_MS = 30_000;
const DEFAULT_MAX_RETAINED_OUTPUT_LINES = 200;
const DEFAULT_PEER_START_LIMIT = 6;
const DEFAULT_PEER_START_WINDOW_MS = 60_000;
/**
 * Backstop around `JobHandle.close()`.
 *
 * This is not the escalation ladder - the handle owns that (PiRpcClient's
 * `close()` is stdin EOF -> SIGTERM -> SIGKILL, each stage bounded). This only
 * stops a *misbehaving* spawner from hanging the manager forever. It must
 * therefore exceed any real handle's own budget: at 1s it fired spuriously
 * against a perfectly healthy Pi whose staged shutdown was simply slower than
 * the guess, and logged a warning about a job that was shutting down correctly.
 */
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

type StopPromise = Promise<void>;

export type JobState = "starting" | "running" | "stopping" | "exited";

export interface JobSpec {
  readonly peerId: string;
  readonly project: string;
  readonly cwd: string;
  readonly name: string;
}

export interface JobExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly at: number;
}

export interface JobRecord {
  readonly id: string;
  readonly peerId: string;
  readonly pid: number | undefined;
  readonly startedAt: number;
  readonly argv: readonly string[];
  readonly project: string;
  readonly cwd: string;
  state: JobState;
  acknowledged: boolean;
  exit?: JobExit;
  stdioClosed: boolean;
  /** Learned by the spawner once the child is ready; absent until then. */
  sessionId?: string;
}

export interface JobReporter {
  output(line: string): void;
  session(sessionId: string): void;
  exited(status: { code: number | null; signal: string | null }): void;
}

export interface JobHandle {
  readonly pid: number | undefined;
  readonly argv: readonly string[];
  readonly stdioClosed: boolean;
  close(): Promise<void>;
}

export type JobSpawner = (spec: JobSpec, report: JobReporter) => JobHandle;

export interface JobManagerOptions {
  spawnJob: JobSpawner;
  maxJobs?: number;
  unacknowledgedTtlMs?: number;
  maxRetainedOutputLines?: number;
  perPeerStartLimit?: { limit: number; windowMs: number };
  stopTimeoutMs?: number;
  logger?: Logger;
  now?: () => number;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

/** The in-memory lifecycle table for locally spawned jobs. */
export class JobManager {
  private readonly spawnJob: JobSpawner;
  private readonly maxJobs: number;
  private readonly unacknowledgedTtlMs: number;
  private readonly maxRetainedOutputLines: number;
  private readonly peerStartLimit: number;
  private readonly peerStartWindowMs: number;
  private readonly stopTimeoutMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly handles = new Map<string, JobHandle>();
  private readonly deliveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly stopPromises = new Map<string, StopPromise>();
  private readonly retainedOutput = new Map<string, string[]>();
  private readonly peerStarts = new Map<string, number[]>();

  constructor(options: JobManagerOptions) {
    this.spawnJob = options.spawnJob;
    this.maxJobs = positiveInteger(
      options.maxJobs ?? DEFAULT_MAX_JOBS,
      "maxJobs",
    );
    this.unacknowledgedTtlMs = positiveInteger(
      options.unacknowledgedTtlMs ?? DEFAULT_UNACKNOWLEDGED_TTL_MS,
      "unacknowledgedTtlMs",
    );
    this.maxRetainedOutputLines = nonNegativeInteger(
      options.maxRetainedOutputLines ?? DEFAULT_MAX_RETAINED_OUTPUT_LINES,
      "maxRetainedOutputLines",
    );
    const peerLimit = options.perPeerStartLimit ?? {
      limit: DEFAULT_PEER_START_LIMIT,
      windowMs: DEFAULT_PEER_START_WINDOW_MS,
    };
    this.peerStartLimit = positiveInteger(
      peerLimit.limit,
      "perPeerStartLimit.limit",
    );
    this.peerStartWindowMs = positiveInteger(
      peerLimit.windowMs,
      "perPeerStartLimit.windowMs",
    );
    this.stopTimeoutMs = positiveInteger(
      options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      "stopTimeoutMs",
    );
    this.logger = options.logger ?? createLogger({ name: "jobs" });
    this.now = options.now ?? Date.now;
  }

  start(spec: JobSpec): JobRecord {
    this.reapExited();
    const active = [...this.jobs.values()].filter(
      (job) => job.state !== "exited",
    ).length;
    if (active >= this.maxJobs) {
      throw new PiMeshError(
        ErrorCode.TooManyJobs,
        "Maximum concurrent jobs exceeded",
      );
    }

    const now = this.now();
    const starts = (this.peerStarts.get(spec.peerId) ?? []).filter(
      (at) => at + this.peerStartWindowMs > now,
    );
    if (starts.length >= this.peerStartLimit) {
      throw new PiMeshError(
        ErrorCode.TooManyJobs,
        "Per-peer job start rate exceeded",
      );
    }

    const id = randomUUID();
    const current: { record?: JobRecord } = {};
    let earlyExit: { code: number | null; signal: string | null } | undefined;
    const report: JobReporter = {
      output: (line) => {
        const record = current.record;
        if (record === undefined) return;
        const lines = this.retainedOutput.get(record.id);
        if (lines === undefined || this.maxRetainedOutputLines === 0) return;
        lines.push(line);
        if (lines.length > this.maxRetainedOutputLines) lines.shift();
      },
      session: (sessionId) => {
        const record = current.record;
        if (record === undefined) return;
        record.sessionId = sessionId;
      },
      exited: (status) => {
        const record = current.record;
        if (record === undefined) {
          earlyExit = status;
          return;
        }
        this.markExited(record, status);
      },
    };

    const handle = this.spawnJob(spec, report);
    const record: JobRecord = {
      id,
      peerId: spec.peerId,
      pid: handle.pid,
      startedAt: now,
      argv: handle.argv,
      project: spec.project,
      cwd: spec.cwd,
      state: "starting",
      acknowledged: false,
      stdioClosed: false,
    };
    current.record = record;
    this.jobs.set(id, record);
    this.handles.set(id, handle);
    this.retainedOutput.set(id, []);
    starts.push(now);
    this.peerStarts.set(spec.peerId, starts);
    record.state = "running";
    if (earlyExit !== undefined) this.markExited(record, earlyExit);

    if (earlyExit === undefined) {
      const timer = setTimeout(() => {
        this.deliveryTimers.delete(id);
        if (!record?.acknowledged && record?.state !== "exited") {
          void this.stop(id).catch((error: unknown) => {
            this.logger.error("Unable to reap unacknowledged job", {
              id,
              error: String(error),
            });
          });
        }
      }, this.unacknowledgedTtlMs);
      timer.unref();
      this.deliveryTimers.set(id, timer);
    }
    return record;
  }

  acknowledge(id: string): boolean {
    const record = this.jobs.get(id);
    if (record === undefined) return false;
    record.acknowledged = true;
    this.clearDeliveryTimer(id);
    return true;
  }

  acknowledgeResult(result: unknown): void {
    for (const id of jobIdsIn(result)) this.acknowledge(id);
  }

  /**
   * Retained output for a job, oldest first, capped at
   * `maxRetainedOutputLines`. This is what lets a failed spawn be explained
   * with the child's own words instead of a generic error.
   */
  output(id: string): readonly string[] {
    return this.retainedOutput.get(id) ?? [];
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].reverse();
  }

  async stop(id: string): Promise<JobRecord> {
    const record = this.jobs.get(id);
    if (record === undefined) {
      throw new PiMeshError(ErrorCode.UnknownJob, `Unknown job: ${id}`);
    }
    if (record.state === "exited") return record;
    const existing = this.stopPromises.get(id);
    if (existing !== undefined) {
      await existing;
      return record;
    }

    record.state = "stopping";
    this.clearDeliveryTimer(id);
    const handle = this.handles.get(id);
    if (handle === undefined) return record;
    const close = Promise.resolve()
      .then(() => handle.close())
      .then(
        () => {
          record.stdioClosed = handle.stdioClosed;
        },
        (error: unknown) => {
          this.logger.error("Job close failed", { id, error: String(error) });
        },
      );
    this.stopPromises.set(id, close);
    let timer: NodeJS.Timeout | undefined;
    let timedOut = true;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.stopTimeoutMs);
      timer.unref();
    });
    await Promise.race([
      close.then(() => {
        timedOut = false;
      }),
      timeout,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
      // A close that finishes after this bound still updates stdioClosed above.
      // Keeping the record in stopping is intentional: only the reporter's exit
      // event is evidence that the child terminated.
      this.logger.warn("Job close exceeded stop deadline", {
        id,
        pid: record.pid,
      });
    }
    return record;
  }

  async shutdown(): Promise<void> {
    for (const timer of this.deliveryTimers.values()) clearTimeout(timer);
    this.deliveryTimers.clear();
    await Promise.all(
      [...this.jobs.values()]
        .filter((record) => record.state !== "exited")
        .map((record) => this.stop(record.id)),
    );
  }

  private markExited(
    record: JobRecord,
    status: { code: number | null; signal: string | null },
  ): void {
    record.state = "exited";
    record.exit = { code: status.code, signal: status.signal, at: this.now() };
    this.clearDeliveryTimer(record.id);
    const handle = this.handles.get(record.id);
    if (handle !== undefined) record.stdioClosed = handle.stdioClosed;
  }

  private clearDeliveryTimer(id: string): void {
    const timer = this.deliveryTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.deliveryTimers.delete(id);
    }
  }

  /**
   * Drop records for jobs that have already exited, so the table cannot grow
   * without bound over a long-lived agent.
   *
   * Consequence worth knowing: once a new job starts, a previously exited job
   * is gone and `stop()` on its id reports UnknownJob rather than "already
   * exited". M2-6's `process.stop` should decide whether that distinction
   * matters to a peer before relying on it.
   */
  private reapExited(): void {
    for (const [id, record] of this.jobs) {
      if (record.state !== "exited") continue;
      this.jobs.delete(id);
      this.handles.delete(id);
      this.stopPromises.delete(id);
      this.retainedOutput.delete(id);
      this.clearDeliveryTimer(id);
    }
  }
}

export function jobIdsIn(result: unknown): string[] {
  const ids: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return;
    const object = value as Record<string, unknown>;
    const job = object.job;
    if (typeof job === "object" && job !== null && !Array.isArray(job)) {
      const id = (job as Record<string, unknown>).id;
      if (typeof id === "string") ids.push(id);
    }
    if (Array.isArray(object.jobs)) {
      for (const item of object.jobs) {
        if (typeof item !== "object" || item === null || Array.isArray(item))
          continue;
        const id = (item as Record<string, unknown>).id;
        if (typeof id === "string") ids.push(id);
      }
    }
    const message = object.message;
    if (
      typeof message === "object" &&
      message !== null &&
      !Array.isArray(message)
    ) {
      const parts = (message as Record<string, unknown>).parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (typeof part !== "object" || part === null || Array.isArray(part))
            continue;
          const data = (part as Record<string, unknown>).data;
          if (typeof data !== "object" || data === null || Array.isArray(data))
            continue;
          collect((data as Record<string, unknown>).result);
        }
      }
    }
  };
  collect(result);
  return [...new Set(ids)];
}
