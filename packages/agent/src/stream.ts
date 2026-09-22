// SPDX-License-Identifier: GPL-3.0-or-later

import { open, stat, type FileHandle } from "node:fs/promises";
import type { Event } from "@pi-mesh/protocol";
import { JsonlDecoder } from "./jsonl.js";
import {
  type SessionFileEntry,
  type SessionParseError,
  type SessionReadRequest,
  type SessionStoreOptions,
  SessionStore,
  parseSession,
} from "./sessions.js";

export interface SessionStreamOptions extends SessionStoreOptions {
  /** Polling is used instead of fs.watch because fs.watch is platform-
   * inconsistent and can miss events, which replay cannot tolerate. */
  pollIntervalMs?: number;
}

interface Waiter {
  resolve: (result: IteratorResult<Event>) => void;
}

/** A complete-only view of the file: a half-written trailing line is omitted. */
interface Snapshot {
  entries: SessionFileEntry[];
  size: number;
}

function event(entry: SessionFileEntry): Event {
  return {
    entryId: entry.id,
    type: entry.type,
    timestamp: entry.timestamp,
    data: { ...entry, source: "file" },
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Missing or unreadable right now: worth retrying, not worth failing on. */
function isRetryable(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "EACCES" || code === "EBADF";
}

/**
 * A read-only, independently stoppable tail of one Pi session file.
 *
 * Known limitations, deliberately deferred:
 *
 * - The queue is unbounded, so a subscriber that stops calling next()
 *   accumulates events for as long as the session keeps growing. Bounding it
 *   is the task-TTL/session-lifecycle concern, not the tailer's; it must be
 *   owned where the stream is wired to a peer.
 * - Each append re-reads and re-parses the whole file, so a long session costs
 *   O(file) per append. Idle polls are skipped (the common case by far), and a
 *   byte-offset tail is the fix if a session ever gets large enough to matter.
 * - Truncation or replacement drops entries the subscriber has not seen rather
 *   than re-emitting seen ones. Pi's sessions are append-only, so this is a
 *   defensive path, and re-emitting would be worse.
 */
export class SessionStream implements AsyncIterableIterator<Event> {
  private readonly request: SessionReadRequest;
  private readonly store: SessionStore;
  private readonly onError: ((error: SessionParseError) => void) | undefined;
  private readonly pollIntervalMs: number;
  private readonly queue: Event[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly ready: Promise<void>;
  private cursor: string | undefined;
  private path: string | undefined;
  private handle: FileHandle | undefined;
  private identity: { dev: number; ino: number } | undefined;
  private lastSize = -1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pollPromise: Promise<void> | undefined;
  private failure: Error | undefined;
  private stopped = false;

  constructor(request: SessionReadRequest, options: SessionStreamOptions = {}) {
    this.request = request;
    this.store = new SessionStore(options);
    this.onError = options.onError;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error("pollIntervalMs must be a positive finite number");
    }
    this.ready = this.initialize();
    // A consumer need not attach until a later tick, and an unhandled
    // rejection here would be process-fatal. The original rejection still
    // surfaces to whoever awaits `ready`.
    this.ready.catch(() => undefined);
  }

  /**
   * Establish the path and the replay boundary from a SINGLE parse.
   *
   * An earlier version read the file with the store and then re-read it here
   * to filter the half-written trailing line, which left a window between the
   * two reads where an append could be missed or replayed, and cost two walks
   * of the session corpus per stream plus three parses of the target file.
   */
  private async initialize(): Promise<void> {
    try {
      const found = await this.store.findSessionPath(this.request.id);
      if (found === undefined) {
        throw new Error(`Unknown session id: ${this.request.id}`);
      }
      this.path = found.path;

      // `since` is validated against the parse we already have, so an unknown
      // id fails here rather than silently replaying everything.
      const requested = this.request.since;
      if (requested !== undefined) {
        const known = found.parsed.entries.some(
          (entry) => entry.id === requested,
        );
        if (!known) throw new Error(`Unknown session entry id: ${requested}`);
      }

      await this.openCurrentFile();
      if (this.stopped) return;

      const snapshot = await this.readSnapshot();

      // Three cases, and they are not the same case:
      //  - no `since`: replay everything and sit at the tail.
      //  - `since` present: replay strictly after it, and sit at the last
      //    replayed entry so the next poll does not re-deliver it.
      //  - `since` given but its line is still unterminated: replay NOTHING and
      //    keep it as the cursor, so strictly-after still holds once its LF
      //    lands. Replaying everything here would re-send entries the caller
      //    already has.
      let replay: SessionFileEntry[];
      if (requested === undefined) {
        replay = snapshot.entries;
        this.cursor = replay.at(-1)?.id;
      } else {
        const start = snapshot.entries.findIndex(
          (entry) => entry.id === requested,
        );
        replay = start === -1 ? [] : snapshot.entries.slice(start + 1);
        this.cursor = replay.at(-1)?.id ?? requested;
      }

      this.enqueue(replay.map(event));
      this.lastSize = snapshot.size;
      this.schedule();
    } catch (error) {
      await this.closeHandle();
      throw error;
    }
  }

  private async openCurrentFile(): Promise<void> {
    if (this.path === undefined) throw new Error("Session path is unavailable");
    const pathStat = await stat(this.path);
    if (
      this.handle !== undefined &&
      this.identity !== undefined &&
      this.identity.dev === pathStat.dev &&
      this.identity.ino === pathStat.ino
    ) {
      return;
    }
    await this.closeHandle();
    const handle = await open(this.path, "r");
    if (this.stopped) {
      // A concurrent stop() already closed what it could see. Close this one
      // ourselves or nothing ever will: no further poll is scheduled.
      await handle.close();
      return;
    }
    const handleStat = await handle.stat();
    this.handle = handle;
    this.identity = { dev: handleStat.dev, ino: handleStat.ino };
  }

  /** Read complete records only; a half-written trailing line is withheld. */
  private async readSnapshot(): Promise<Snapshot> {
    if (this.handle === undefined) return { entries: [], size: 0 };
    const size = (await this.handle.stat()).size;

    // Idle sessions are polled continuously; re-reading and re-parsing an
    // unchanged multi-megabyte file ten times a second per subscriber was the
    // dominant cost of this feature.
    if (size === this.lastSize) return { entries: [], size };

    const content = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await this.handle.read(
        content,
        offset,
        size - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }

    const decoder = new JsonlDecoder();
    const records = decoder.push(content.subarray(0, offset));
    if (records.length === 0) return { entries: [], size };

    // Rejoining complete records keeps a partial trailing line out of the
    // parse entirely, which parseSession cannot do on its own.
    const parsed = parseSession(`${records.join("\n")}\n`, this.path);
    for (const error of parsed.errors) this.onError?.(error);
    return { entries: parsed.entries, size };
  }

  private enqueue(events: Event[]): void {
    for (const item of events) {
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter.resolve({ value: item, done: false });
      else this.queue.push(item);
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // pollFile's own catch classifies retryable errors; anything reaching
      // here is unexpected and must not become an unhandled rejection.
      void this.pollNow()
        .finally(() => this.schedule())
        .catch(() => undefined);
    }, this.pollIntervalMs);
    // A stream should not be what keeps a daemon's event loop alive.
    this.timer.unref?.();
  }

  /** Run one poll immediately; for deterministic tests and eager callers. */
  async poll(): Promise<void> {
    await this.ready;
    await this.pollNow();
  }

  private pollNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pollPromise !== undefined) return this.pollPromise;
    this.pollPromise = this.pollFile().finally(() => {
      this.pollPromise = undefined;
    });
    return this.pollPromise;
  }

  private async pollFile(): Promise<void> {
    if (this.path === undefined || this.stopped) return;
    try {
      await this.openCurrentFile();
      if (this.stopped) return;

      const snapshot = await this.readSnapshot();
      const start =
        this.cursor === undefined
          ? -1
          : snapshot.entries.findIndex((item) => item.id === this.cursor);
      const previousSize = this.lastSize;
      this.lastSize = snapshot.size;

      if (start === -1 && this.cursor !== undefined) {
        // The cursor is not among the complete entries. Two cases:
        if (snapshot.size < previousSize) {
          // The file was truncated or rewritten. Resume at the new tail rather
          // than replaying entries the subscriber has already seen. Only move
          // the cursor when there IS a tail: clearing it would make the next
          // poll treat this as "start from the beginning" and re-deliver
          // everything, which is precisely the duplicate this guards against.
          const tail = snapshot.entries.at(-1)?.id;
          if (tail !== undefined) this.cursor = tail;
          return;
        }
        // Otherwise its line is simply unterminated right now. Leave the
        // cursor untouched; this is the read-to-stream boundary case, and
        // resetting it would re-deliver the boundary entry.
        return;
      }

      const fresh = snapshot.entries.slice(start + 1).map(event);
      this.enqueue(fresh);
      this.cursor = fresh.at(-1)?.entryId ?? this.cursor;
    } catch (error) {
      if (isRetryable(error)) {
        // A file can vanish briefly during replacement. Keep the subscription
        // alive and let the next poll observe the replacement.
        if (errorCode(error) === "ENOENT" || errorCode(error) === "EBADF") {
          await this.closeHandle();
        }
        return;
      }
      this.failure = error instanceof Error ? error : new Error(String(error));
      for (const waiter of this.waiters.splice(0)) {
        waiter.resolve({ value: undefined, done: true });
      }
    }
  }

  async next(): Promise<IteratorResult<Event>> {
    await this.ready;
    const item = this.queue.shift();
    if (item !== undefined) return { value: item, done: false };
    if (this.failure !== undefined) throw this.failure;
    if (this.stopped) return { value: undefined, done: true };
    return new Promise<IteratorResult<Event>>((resolve) => {
      this.waiters.push({ resolve });
    });
  }

  async return(): Promise<IteratorResult<Event>> {
    await this.stop();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Event> {
    return this;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      await this.ready.catch(() => undefined);
      return;
    }
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
    await this.ready.catch(() => undefined);
    // Let an in-flight poll finish first. Otherwise it can be parked inside
    // open() when we close, then reopen the handle afterwards, and no later
    // poll runs to notice the leak.
    await this.pollPromise?.catch(() => undefined);
    await this.closeHandle();
  }

  private async closeHandle(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    this.identity = undefined;
    if (handle !== undefined) await handle.close();
  }
}

export function sessionStream(
  request: SessionReadRequest,
  options?: SessionStreamOptions,
): SessionStream {
  return new SessionStream(request, options);
}
