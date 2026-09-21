// SPDX-License-Identifier: GPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  createLogger,
  ErrorCode,
  PiMeshError,
  type Logger,
} from "@pi-mesh/shared";

/**
 * Concurrent jobs per agent. A Pi session is a full model-backed process, so
 * this is a resource bound rather than a queue depth: four is what a 2 GB
 * Raspberry Pi (the smallest target this project runs on) survives while still
 * leaving room for the agent itself.
 */
const DEFAULT_MAX_JOBS = 4;
/**
 * How long a job may exist before the peer that asked for it has learned its
 * id. Must exceed the spawn-readiness bound: acknowledgement can only happen
 * after the skill resolves, and M2-5's handler awaits the child being ready
 * (`rpc.ready`, then `get_state`). If readiness ever takes longer than this,
 * the job is reaped before its response is written - so raising one without the
 * other is the way to break this.
 */
const DEFAULT_UNACKNOWLEDGED_TTL_MS = 30_000;
const DEFAULT_MAX_RETAINED_OUTPUT_LINES = 200;
/** Bytes, not just lines: one stderr chunk can be tens of KB. */
const DEFAULT_MAX_RETAINED_OUTPUT_BYTES = 32_768;
/**
 * Exited records are kept so a peer can still ask what happened to a job it
 * started (`process.stop` on an already-stopped job must succeed, AGENTS.md),
 * and evicted oldest-first beyond this so the table cannot grow without bound.
 */
const DEFAULT_MAX_RETAINED_JOBS = 64;
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

/**
 * `starting` is deliberately absent: the record cannot be observed in that
 * state, because it is created and promoted to `running` in one synchronous
 * block. A state no caller can see is a state that only misleads readers.
 */
export type JobState = "running" | "stopping" | "exited";

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
  /**
   * Whether the child's stdio has closed, meaningful only after `close()`.
   * False means "unreaped": the wait was given up on, not that the process
   * survived.
   */
  readonly stdioClosed: boolean;
  close(): Promise<void>;
}

/**
 * A spawner MUST call `report.exited` when the child terminates. That report is
 * the only evidence the table accepts that a child is gone, because inferring
 * termination from a quiet handle is how a live process gets forgotten.
 *
 * The consequence of breaking it is worth stating: a record whose exit is never
 * reported stays in `stopping` forever and keeps consuming a `maxJobs` slot, so
 * enough silent handles block every future spawn. M2-5 should make that
 * unreachable (PiRpcClient always emits `exit` after SIGKILL) and M2-6 should
 * decide what `process.stop` reports for a job stuck in `stopping`.
 */
export type JobSpawner = (spec: JobSpec, report: JobReporter) => JobHandle;

export interface JobManagerOptions {
  spawnJob: JobSpawner;
  maxJobs?: number;
  unacknowledgedTtlMs?: number;
  maxRetainedOutputLines?: number;
  maxRetainedOutputBytes?: number;
  maxRetainedJobs?: number;
  perPeerStartLimit?: { limit: number; windowMs: number };
  stopTimeoutMs?: number;
  logger?: Logger;
  now?: () => number;
}

/**
 * Resolve when `promise` settles, or after `ms` - whichever comes first.
 * Resolving early leaves the original promise running; callers must therefore
 * treat "resolved" as "gave up waiting", not as "done".
 */
function boundBy(
  promise: Promise<void>,
  ms: number,
  onTimeout: () => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      onTimeout();
      resolve();
    }, ms);
    timer.unref();
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
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
  private readonly maxRetainedOutputBytes: number;
  private readonly maxRetainedJobs: number;
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
  private readonly retainedOutputBytes = new Map<string, number>();
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
    this.maxRetainedOutputBytes = nonNegativeInteger(
      options.maxRetainedOutputBytes ?? DEFAULT_MAX_RETAINED_OUTPUT_BYTES,
      "maxRetainedOutputBytes",
    );
    this.maxRetainedJobs = positiveInteger(
      options.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS,
      "maxRetainedJobs",
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
    this.evictExited();
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
    if (starts.length === 0) this.peerStarts.delete(spec.peerId);
    // Containment, not anti-abuse: `peerId` is a routing label that any member
    // can claim or rotate (ADR 0008 decision 3), so this bounds a runaway
    // loop's churn, not a determined peer. `maxJobs` is what actually bounds
    // concurrency.
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
        if (lines === undefined) return;
        if (
          this.maxRetainedOutputLines === 0 ||
          this.maxRetainedOutputBytes === 0
        )
          return;
        lines.push(line);
        let bytes =
          (this.retainedOutputBytes.get(record.id) ?? 0) + line.length;
        while (
          lines.length > this.maxRetainedOutputLines ||
          (bytes > this.maxRetainedOutputBytes && lines.length > 1)
        ) {
          bytes -= (lines.shift() ?? "").length;
        }
        this.retainedOutputBytes.set(record.id, Math.max(bytes, 0));
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
      state: "running",
      acknowledged: false,
      stdioClosed: false,
    };
    current.record = record;
    this.jobs.set(id, record);
    this.handles.set(id, handle);
    this.retainedOutput.set(id, []);
    this.retainedOutputBytes.set(id, 0);
    starts.push(now);
    this.peerStarts.set(spec.peerId, starts);
    if (earlyExit !== undefined) this.markExited(record, earlyExit);

    if (earlyExit === undefined) {
      const timer = setTimeout(() => {
        this.deliveryTimers.delete(id);
        if (!record.acknowledged && record.state !== "exited") {
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
    let timedOut = false;
    // The BOUNDED promise is what gets stored. Storing the raw close() here is
    // the bug this replaced: every other caller reaches the handle through this
    // map, so an unbounded promise made the first stop() return on time while
    // leaving the second stop() - and shutdown() with it - waiting forever on a
    // handle that never settles. That is the same shape as M1's server.stop()
    // hang, and it is exactly the case stopTimeoutMs claims to cover.
    const bounded = boundBy(close, this.stopTimeoutMs, () => {
      timedOut = true;
    });
    this.stopPromises.set(id, bounded);
    await bounded;
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
    // Say so when this was not clean. Resolving silently would let "shutdown
    // finished" and "two children are still running" look identical to the
    // caller, and the DoD reads better than it deserves. The honest scope is
    // "no direct child": a descendant that inherited an fd survives regardless
    // (ADR 0008, Consequences).
    const survivors = [...this.jobs.values()]
      .filter((record) => record.state !== "exited")
      .map((record) => ({ id: record.id, pid: record.pid }));
    if (survivors.length > 0) {
      this.logger.warn("Jobs still running after shutdown", {
        jobs: survivors,
      });
    }
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
  /**
   * Drop the oldest exited records once the table is at its retention bound.
   *
   * Exited records are kept rather than dropped immediately, because
   * `process.stop` on a job that has already stopped must succeed rather than
   * reporting that a job the peer really did start never existed (AGENTS.md:
   * idempotent control commands). Eviction is oldest-first, and only ever of
   * records that have already exited, so it can never orphan a live child.
   *
   * An exited-but-unreported job is NOT evicted and NOT counted as finished:
   * the sole evidence that a child is gone is the spawner's exit report, and
   * treating a quiet handle as dead is how a live process gets forgotten.
   */
  private evictExited(): void {
    while (this.jobs.size >= this.maxRetainedJobs) {
      const oldest = [...this.jobs.values()].find(
        (record) => record.state === "exited",
      );
      if (oldest === undefined) return;
      this.jobs.delete(oldest.id);
      this.handles.delete(oldest.id);
      this.stopPromises.delete(oldest.id);
      this.retainedOutput.delete(oldest.id);
      this.retainedOutputBytes.delete(oldest.id);
      this.clearDeliveryTimer(oldest.id);
    }
  }
}

export function jobIdsIn(result: unknown): string[] {
  const ids: string[] = [];
  // The documented output of `process.spawn` is `{ job_id, pid, session_id }`
  // (docs/PROTOCOL.md, skill table). Accepting anything else - a `{ job: { id } }`
  // convention that no document declares - is how a DELIVERED spawn result goes
  // unacknowledged: the job is then reaped at its deadline while every test
  // still passes, because the disconnect test expects reaping. One shape, the
  // documented one, pinned by a test.
  const fromSkillOutput = (value: unknown): void => {
    const jobId = asObject(value)?.job_id;
    if (typeof jobId === "string" && jobId.length > 0) ids.push(jobId);
  };
  fromSkillOutput(result);
  // The unary path wraps a skill's output in an A2A message, so a real response
  // carries it at message.parts[].data.result rather than at the top level.
  const message = asObject(asObject(result)?.message);
  const parts = message?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      fromSkillOutput(asObject(asObject(part)?.data)?.result);
    }
  }
  return [...new Set(ids)];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
