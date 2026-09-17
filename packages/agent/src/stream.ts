// SPDX-License-Identifier: GPL-3.0-or-later

import { open, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Event } from "@pi-mesh/protocol";
import { JsonlDecoder } from "./jsonl.js";
import {
  type SessionFileEntry,
  type SessionReadRequest,
  type SessionStoreOptions,
  SessionStore,
  parseSession,
} from "./sessions.js";

export interface SessionStreamOptions extends SessionStoreOptions {
  /** Polling is used instead of fs.watch because fs.watch is platform-
   * inconsistent and can miss events, which is unacceptable for replay. */
  pollIntervalMs?: number;
}

interface StreamSnapshot {
  events: Event[];
}

interface Waiter {
  resolve: (result: IteratorResult<Event>) => void;
}

function event(entry: SessionFileEntry): Event {
  return {
    entryId: entry.id,
    type: entry.type,
    timestamp: entry.timestamp,
    data: entry,
  };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function sameFile(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** A read-only, independently stoppable tail of one Pi session file. */
export class SessionStream implements AsyncIterableIterator<Event> {
  private readonly request: SessionReadRequest;
  private readonly store: SessionStore;
  private readonly sessionsRoot: string;
  private readonly pollIntervalMs: number;
  private readonly queue: Event[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly ready: Promise<void>;
  private cursor: string | undefined;
  private path: string | undefined;
  private handle: FileHandle | undefined;
  private identity: { dev: number; ino: number } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pollPromise: Promise<void> | undefined;
  private stopped = false;

  constructor(request: SessionReadRequest, options: SessionStreamOptions = {}) {
    this.request = request;
    this.store = new SessionStore(options);
    this.sessionsRoot = options.sessionsRoot ?? SessionStream.defaultRoot();
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error("pollIntervalMs must be a positive finite number");
    }
    this.ready = this.initialize();
  }

  private static defaultRoot(): string {
    return join(homedir(), ".pi", "agent", "sessions");
  }

  private async initialize(): Promise<void> {
    const initial = await this.store.read(this.request);
    if (this.stopped) return;
    const path = await this.store.findSessionPath(this.request.id);
    if (path === undefined) {
      throw new Error(`Unknown session id: ${this.request.id}`);
    }
    this.path = path;
    await this.openCurrentFile();
    if (this.stopped) return;

    // session.read establishes the replay boundary. Reparse only to discard a
    // final unterminated line, since its complete-document decoder accepts one.
    const complete = await this.readSnapshot();
    const completeIds = new Set(complete.events.map((item) => item.entryId));
    const replay = initial.filter((item) => completeIds.has(item.entryId));
    this.cursor = replay.at(-1)?.entryId ?? this.request.since;
    this.enqueue(replay);
    this.schedule();
  }

  private async openCurrentFile(): Promise<void> {
    if (this.path === undefined) throw new Error("Session path is unavailable");
    const pathStat = await stat(this.path);
    if (
      this.handle !== undefined &&
      this.identity !== undefined &&
      sameFile(this.identity, pathStat)
    ) {
      return;
    }
    await this.closeHandle();
    this.handle = await open(this.path, "r");
    const handleStat = await this.handle.stat();
    this.identity = { dev: handleStat.dev, ino: handleStat.ino };
  }

  private async readSnapshot(): Promise<StreamSnapshot> {
    if (this.handle === undefined) return { events: [] };
    const size = (await this.handle.stat()).size;
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
    const document = records.length === 0 ? "" : `${records.join("\n")}\n`;
    const parsed = parseSession(document, this.path);
    return { events: parsed.entries.map(event) };
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
      void this.pollNow().finally(() => this.schedule());
    }, this.pollIntervalMs);
  }

  /** Run one poll immediately; useful for deterministic tests and callers. */
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
      const snapshot = await this.readSnapshot();
      const start =
        this.cursor === undefined
          ? -1
          : snapshot.events.findIndex((item) => item.entryId === this.cursor);

      // A missing cursor means truncation or replacement. Start at the new
      // tail rather than replaying old data or retrying a broken offset.
      if (this.cursor !== undefined && start === -1) {
        this.cursor = snapshot.events.at(-1)?.entryId;
        return;
      }
      const fresh = snapshot.events.slice(start + 1);
      this.enqueue(fresh);
      this.cursor = fresh.at(-1)?.entryId ?? this.cursor;
    } catch (error) {
      if (isMissing(error)) await this.closeHandle();
      // Files can briefly disappear during replacement. Keep the subscription
      // alive and let the next poll observe the replacement.
    }
  }

  async next(): Promise<IteratorResult<Event>> {
    await this.ready;
    const item = this.queue.shift();
    if (item !== undefined) return { value: item, done: false };
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
