// SPDX-License-Identifier: GPL-3.0-or-later

import type { AgentStreamFrame } from "./client.js";

/**
 * How much the replay ring - and each subscriber's unread queue - may hold
 * before frames are dropped or the subscriber is cut off. These mirror the
 * agent's own live ring (ADR 0009 §4): the control plane must not reintroduce
 * the unbounded queue the agent already bounded (ADR 0018 §5).
 */
const MAX_QUEUE_EVENTS = 256;
const MAX_QUEUE_BYTES = 64 * 1024;

/** Where an upstream got its frames, or why it has none. */
export type UpstreamKind = "live" | "file" | "error" | "ended";

export interface UpstreamReady {
  kind: UpstreamKind;
  reason?: string;
}

export type SubscriberFrame =
  { kind: "frame"; data: unknown } | { kind: "end"; reason: string };

export interface StreamSubscriber {
  /**
   * Resolves once the agent has accepted the stream (its first frame landed);
   * rejects when the agent refused, was unreachable, or the view closed first.
   * Separates "can we stream at all" from "is the source live" so an HTTP
   * answer can be sent before the first delta.
   */
  readonly connected: Promise<void>;
  /** Resolves once the upstream is classified - before any frame is trusted. */
  readonly ready: Promise<UpstreamReady>;
  readonly frames: AsyncIterableIterator<SubscriberFrame>;
  /** Detach; the upstream stops once the last subscriber has left. */
  close(): void;
}

type Opener = (signal: AbortSignal) => AsyncGenerator<AgentStreamFrame>;

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "");
}

function sourceOf(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>).source
    : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One attach point's bounded, independently stoppable view of the upstream. */
class Subscriber implements AsyncIterableIterator<SubscriberFrame> {
  readonly ready: Promise<UpstreamReady>;
  private resolveReady!: (value: UpstreamReady) => void;
  private readonly queue: Array<{ frame: SubscriberFrame; seeded: boolean }> =
    [];
  private liveCount = 0;
  private liveBytes = 0;
  private ended = false;
  private waiter: (() => void) | undefined;

  constructor() {
    this.ready = new Promise<UpstreamReady>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  settle(ready: UpstreamReady): void {
    this.resolveReady(ready);
  }

  /**
   * Seed the boundary replay. It is bounded by the upstream ring already, so it
   * must NOT count against this queue's bound: doing so cut a reading
   * subscriber off the moment a 256-frame replay was followed by one frame.
   */
  seed(frame: SubscriberFrame): void {
    if (this.ended) return;
    this.queue.push({ frame, seeded: true });
    this.wake();
  }

  push(frame: SubscriberFrame): void {
    if (this.ended) return;
    this.queue.push({ frame, seeded: false });
    if (frame.kind === "frame") {
      this.liveCount += 1;
      this.liveBytes += bytesOf(frame.data);
    }
    if (this.liveCount > MAX_QUEUE_EVENTS || this.liveBytes > MAX_QUEUE_BYTES) {
      this.queue.length = 0;
      this.liveCount = 0;
      this.liveBytes = 0;
      this.ended = true;
      this.queue.push({
        frame: {
          kind: "end",
          reason:
            "the reader fell behind and was disconnected; re-read the session for the durable page",
        },
        seeded: false,
      });
    }
    this.wake();
  }

  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.queue.push({ frame: { kind: "end", reason }, seeded: false });
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  async next(): Promise<IteratorResult<SubscriberFrame>> {
    for (;;) {
      const item = this.queue.shift();
      if (item !== undefined) {
        // Only live frames count against the bound; a seeded replay does not.
        if (!item.seeded && item.frame.kind === "frame") {
          this.liveCount -= 1;
          this.liveBytes -= bytesOf(item.frame.data);
        }
        return { value: item.frame, done: false };
      }
      if (this.ended) return { value: undefined, done: true };
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  async return(): Promise<IteratorResult<SubscriberFrame>> {
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<SubscriberFrame> {
    return this;
  }
}

/**
 * One upstream A2A stream for a `(agent_id, session_id)`, fanned out to every
 * subscriber. It exists so two open tabs share one connection to the agent and
 * the connection dies when the last tab leaves (ADR 0018 §5).
 */
class Upstream {
  private readonly abort = new AbortController();
  private readonly subscribers = new Set<Subscriber>();
  private readonly replay: unknown[] = [];
  private replayBytes = 0;
  private readonly connectedPromise: Promise<void>;
  private resolveConnected!: () => void;
  private rejectConnected!: (error: unknown) => void;
  private landed = false;
  private kind: UpstreamKind | "opening" = "opening";
  private reason: string | undefined;
  private iterator: AsyncGenerator<AgentStreamFrame> | undefined;
  private pumping = false;
  private released = false;

  constructor(
    private readonly opener: Opener,
    private readonly onEmpty: () => void,
  ) {
    this.connectedPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnected = resolve;
      this.rejectConnected = reject;
    });
    // A failure before any subscriber awaits `connected` must not be fatal.
    this.connectedPromise.catch(() => undefined);
  }

  subscribe(): StreamSubscriber {
    const subscriber = new Subscriber();
    this.subscribers.add(subscriber);
    if (this.kind === "live") {
      subscriber.settle(this.readyValue());
      for (const data of this.replay) subscriber.seed({ kind: "frame", data });
    } else if (this.kind !== "opening") {
      subscriber.settle(this.readyValue());
      subscriber.end(this.reason ?? this.kind);
    }
    void this.pump();
    return {
      connected: this.connectedPromise,
      ready: subscriber.ready,
      frames: subscriber,
      close: () => this.detach(subscriber),
    };
  }

  /** Close from outside: end every subscriber and drop the upstream. */
  close(): void {
    this.release();
    for (const subscriber of [...this.subscribers]) {
      subscriber.end("the control plane closed the stream");
    }
    this.subscribers.clear();
    this.onEmpty();
  }

  private readyValue(): UpstreamReady {
    return {
      kind: this.kind === "opening" ? "ended" : this.kind,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    };
  }

  private detach(subscriber: Subscriber): void {
    if (!this.subscribers.delete(subscriber)) return;
    subscriber.end("the view was closed");
    if (this.subscribers.size === 0) {
      this.release();
      this.onEmpty();
    }
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    // Anything still awaiting `connected` must not be left hanging.
    if (!this.landed) {
      this.landed = true;
      this.rejectConnected(new Error("the live view was closed"));
    }
    this.abort.abort();
    void this.iterator?.return(undefined).catch(() => undefined);
    this.iterator = undefined;
  }

  private classify(kind: UpstreamKind, reason?: string): void {
    this.kind = kind;
    this.reason = reason;
    const ready = this.readyValue();
    for (const subscriber of this.subscribers) {
      subscriber.settle(ready);
      if (kind !== "live") subscriber.end(reason ?? kind);
    }
    if (kind === "live") {
      for (const subscriber of this.subscribers)
        for (const data of this.replay)
          subscriber.seed({ kind: "frame", data });
    }
  }

  private record(data: unknown): void {
    this.replay.push(data);
    this.replayBytes += bytesOf(data);
    while (
      this.replay.length > MAX_QUEUE_EVENTS ||
      (this.replayBytes > MAX_QUEUE_BYTES && this.replay.length > 0)
    ) {
      const removed = this.replay.shift();
      if (removed !== undefined) this.replayBytes -= bytesOf(removed);
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.released) return;
    this.pumping = true;
    try {
      this.iterator = this.opener(this.abort.signal);
      for (;;) {
        const next = await this.iterator.next();
        if (this.released) break;
        if (next.done) {
          // An upstream that ends before it is classified never became a live
          // view, and must say so rather than look like a finished turn.
          if (!this.landed) {
            this.landed = true;
            this.rejectConnected(
              new Error("the agent's stream ended before it connected"),
            );
          }
          this.classify(
            "ended",
            "the agent's stream ended before any live frame arrived",
          );
          break;
        }
        if (!this.landed) {
          this.landed = true;
          this.resolveConnected();
        }
        const frame = next.value;
        if (frame.kind === "task") continue;
        if (this.kind === "opening") {
          const source = sourceOf(frame.value);
          if (source === "file") {
            this.classify(
              "file",
              "the agent served the durable file, not a live turn",
            );
            break;
          }
          if (source !== "live") {
            this.classify(
              "error",
              "the first message frame carried no source discriminator",
            );
            break;
          }
          this.classify("live");
        }
        this.record(frame.value);
        for (const subscriber of this.subscribers)
          subscriber.push({ kind: "frame", data: frame.value });
      }
    } catch (error) {
      if (!this.landed) {
        this.landed = true;
        this.rejectConnected(error);
      }
      if (!this.released) this.classify("ended", messageOf(error));
    } finally {
      this.pumping = false;
    }
  }
}

/** One live upstream per `(agent_id, session_id)`, shared by every subscriber. */
export class UpstreamRegistry {
  private readonly upstreams = new Map<string, Upstream>();

  get(key: string, opener: Opener): StreamSubscriber {
    let upstream = this.upstreams.get(key);
    if (upstream === undefined) {
      upstream = new Upstream(opener, () => {
        if (this.upstreams.get(key) === upstream) this.upstreams.delete(key);
      });
      this.upstreams.set(key, upstream);
    }
    return upstream.subscribe();
  }

  closeAgent(agentId: string): void {
    const prefix = `${agentId}\u0000`;
    for (const [key, upstream] of [...this.upstreams]) {
      if (key.startsWith(prefix)) upstream.close();
    }
  }

  closeAll(): void {
    for (const upstream of [...this.upstreams.values()]) upstream.close();
    this.upstreams.clear();
  }

  get size(): number {
    return this.upstreams.size;
  }
}

/** The registry key: agent and session, in a pair that cannot collide. */
export function streamKey(agentId: string, sessionId: string): string {
  return `${agentId}\u0000${sessionId}`;
}
