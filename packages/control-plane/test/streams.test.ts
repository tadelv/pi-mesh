// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { AgentStreamFrame } from "../src/client.js";
import { UpstreamRegistry, type SubscriberFrame } from "../src/streams.js";

/** A hand-driven agent stream, so each clause controls exactly when a frame lands. */
class Source implements AsyncGenerator<AgentStreamFrame> {
  readonly signals: AbortSignal[] = [];
  private readonly queue: AgentStreamFrame[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;

  /** The opener handed to the registry; records the abort signal it is given. */
  readonly open = (signal: AbortSignal): AsyncGenerator<AgentStreamFrame> => {
    this.signals.push(signal);
    return this;
  };

  push(frame: AgentStreamFrame): void {
    this.queue.push(frame);
    this.wake();
  }

  live(value: Record<string, unknown>): void {
    this.push({ kind: "message", value: { source: "live", ...value } });
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  async next(): Promise<IteratorResult<AgentStreamFrame>> {
    for (;;) {
      const value = this.queue.shift();
      if (value !== undefined) return { value, done: false };
      if (this.ended) return { value: undefined, done: true };
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  async return(): Promise<IteratorResult<AgentStreamFrame>> {
    this.end();
    return { value: undefined, done: true };
  }

  async throw(error?: unknown): Promise<IteratorResult<AgentStreamFrame>> {
    this.end();
    throw error;
  }

  [Symbol.asyncIterator](): AsyncGenerator<AgentStreamFrame> {
    return this;
  }
}

async function nextFrame(subscriber: {
  frames: AsyncIterableIterator<SubscriberFrame>;
}): Promise<SubscriberFrame> {
  const next = await subscriber.frames.next();
  if (next.done === true) throw new Error("frames ended before a frame");
  return next.value;
}

/** Let the pump run its microtasks. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe("upstream registry", () => {
  it("opens one upstream for two subscribers and fans a live frame to both", async () => {
    const source = new Source();
    const registry = new UpstreamRegistry();
    const first = registry.get("agent\0session", source.open);
    const second = registry.get("agent\0session", source.open);
    source.live({ n: 1 });
    expect((await first.ready).kind).toBe("live");
    expect((await second.ready).kind).toBe("live");
    expect(
      source.signals,
      "two subscribers must share ONE upstream",
    ).toHaveLength(1);
    expect(await nextFrame(first)).toMatchObject({
      kind: "frame",
      data: { n: 1 },
    });
    expect(await nextFrame(second)).toMatchObject({
      kind: "frame",
      data: { n: 1 },
    });
    registry.closeAll();
  });

  it("closes the upstream only when the last subscriber leaves", async () => {
    const source = new Source();
    const registry = new UpstreamRegistry();
    const first = registry.get("agent\0session", source.open);
    const second = registry.get("agent\0session", source.open);
    source.live({ n: 1 });
    await first.ready;
    first.close();
    expect(
      source.signals[0]!.aborted,
      "one subscriber remaining must keep the upstream open",
    ).toBe(false);
    expect(
      registry.size,
      "the upstream survives while one subscriber remains",
    ).toBe(1);
    second.close();
    expect(
      source.signals[0]!.aborted,
      "the last unsubscribe must close the upstream",
    ).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("ends a subscriber that stops reading instead of buffering without bound", async () => {
    const source = new Source();
    const registry = new UpstreamRegistry();
    const subscriber = registry.get("agent\0session", source.open);
    source.live({ n: 0 });
    await subscriber.ready;
    // Far past the 256-event bound, and the test never reads between pushes.
    for (let index = 1; index <= 400; index += 1) source.live({ n: index });
    await settle();
    let end: SubscriberFrame | undefined;
    let delivered = 0;
    for (let index = 0; index < 500; index += 1) {
      const next = await subscriber.frames.next();
      if (next.done === true) break;
      if (next.value.kind === "end") {
        end = next.value;
        break;
      }
      delivered += 1;
    }
    expect(
      end?.kind === "end" ? end.reason : undefined,
      "missing observation: the reader fell behind and was cut off",
    ).toMatch(/fell behind/);
    expect(
      delivered,
      "the bound must be smaller than the frames offered",
    ).toBeLessThan(400);
    registry.closeAll();
  });

  it("classifies a file-sourced first frame as not live, with no frames", async () => {
    const source = new Source();
    const registry = new UpstreamRegistry();
    const subscriber = registry.get("agent\0session", source.open);
    source.push({ kind: "message", value: { source: "file", id: "entry-1" } });
    const ready = await subscriber.ready;
    expect(ready.kind).toBe("file");
    expect(ready.reason).toMatch(/durable file/);
    // The file's entries must not be presented as a live overlay.
    expect(await nextFrame(subscriber)).toMatchObject({ kind: "end" });
    registry.closeAll();
  });

  it("treats a first message frame with no discriminator as a protocol error", async () => {
    const source = new Source();
    const registry = new UpstreamRegistry();
    const subscriber = registry.get("agent\0session", source.open);
    source.push({ kind: "message", value: { type: "message_update" } });
    const ready = await subscriber.ready;
    expect(ready.kind).toBe("error");
    expect(ready.reason).toMatch(/no source discriminator/);
    registry.closeAll();
  });

  it("skips the task frame and replays recent live frames to a late subscriber", async () => {
    const source = new Source();
    const registry = new UpstreamRegistry();
    const first = registry.get("agent\0session", source.open);
    source.push({ kind: "task", task: { id: "task-1" } });
    source.live({ n: 1 });
    await first.ready;
    expect(
      await nextFrame(first),
      "the task frame is not a message frame",
    ).toMatchObject({
      kind: "frame",
      data: { n: 1 },
    });
    const late = registry.get("agent\0session", source.open);
    source.live({ n: 2 });
    expect(
      await nextFrame(late),
      "a late subscriber gets the replay",
    ).toMatchObject({
      kind: "frame",
      data: { n: 1 },
    });
    expect(await nextFrame(late)).toMatchObject({
      kind: "frame",
      data: { n: 2 },
    });
    registry.closeAll();
  });

  it("says the stream ended rather than looking like a finished turn", async () => {
    const source = new Source();
    const registry = new UpstreamRegistry();
    const subscriber = registry.get("agent\0session", source.open);
    source.end();
    const ready = await subscriber.ready;
    expect(ready.kind).toBe("ended");
    expect(await nextFrame(subscriber)).toMatchObject({ kind: "end" });
    registry.closeAll();
  });

  it("keeps a reading subscriber connected across a full replay and later frames", async () => {
    // Regression: the boundary replay used to count against the subscriber's
    // own bound, so a full 256-frame replay plus one frame cut off a subscriber
    // that was reading perfectly well.
    const source = new Source();
    const registry = new UpstreamRegistry();
    const first = registry.get("agent\0session", source.open);
    source.live({ n: -1 });
    await first.ready;
    for (let index = 0; index < 256; index += 1) source.live({ n: index });
    await settle();
    const late = registry.get("agent\0session", source.open);
    source.live({ n: 999 });
    // Read only after the replay AND the next live frame are queued, so the
    // bound is exercised before the reader has drained anything.
    await settle();
    let endReason: string | undefined;
    let sawTail = false;
    let seen = 0;
    for (let index = 0; index < 700; index += 1) {
      const next = await late.frames.next();
      if (next.done === true) break;
      if (next.value.kind === "end") {
        endReason = next.value.reason;
        break;
      }
      seen += 1;
      if ((next.value.data as { n?: number }).n === 999) {
        sawTail = true;
        break;
      }
    }
    expect(
      endReason,
      "a reading subscriber must not be cut off by its own replay",
    ).toBeUndefined();
    expect(sawTail, "the live tail after the replay").toBe(true);
    expect(seen, "the replay is delivered too").toBeGreaterThan(1);
    registry.closeAll();
  });

  it("closes only the named agent's upstreams when an agent is unpaired", async () => {
    const a = new Source();
    const b = new Source();
    const registry = new UpstreamRegistry();
    const one = registry.get("agent-a\0session", a.open);
    const two = registry.get("agent-b\0session", b.open);
    a.live({ n: 1 });
    b.live({ n: 1 });
    await one.ready;
    await two.ready;
    registry.closeAgent("agent-a");
    expect(a.signals[0]!.aborted).toBe(true);
    expect(b.signals[0]!.aborted, "another agent's upstream is untouched").toBe(
      false,
    );
    expect(registry.size).toBe(1);
    registry.closeAll();
    expect(b.signals[0]!.aborted).toBe(true);
    expect(registry.size).toBe(0);
  });
});
