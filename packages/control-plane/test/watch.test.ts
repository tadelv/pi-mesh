// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary, WatchFrame } from "@pi-mesh/protocol";
import { ControlStore } from "../src/db.js";
import type { AgentTarget } from "../src/client.js";
import { WatchManager, type WatchOpener } from "../src/watch.js";

const PEER = "agent-watch-1";

function summary(
  id: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    project: "/work/a",
    name: `Name ${id}`,
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function agentRow() {
  return {
    peer_id: PEER,
    name: "Watch Agent",
    host: "127.0.0.1",
    port: 1,
    credential: Buffer.alloc(32, 9).toString("base64"),
    paired_at: "2026-01-01T00:00:00.000Z",
  };
}

/** A hand-driven mesh.watch source: the test decides exactly what lands. */
class WatchSource {
  readonly signals: AbortSignal[] = [];
  opens = 0;
  private readonly queue: WatchFrame[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;
  autoEnd = false;

  readonly open: WatchOpener = async function* (
    this: WatchSource,
    _target: AgentTarget,
    signal: AbortSignal,
  ): AsyncGenerator<WatchFrame> {
    void _target;
    this.opens += 1;
    this.signals.push(signal);
    const wake = (): void => {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter?.();
    };
    signal.addEventListener("abort", wake);
    try {
      for (;;) {
        const frame = this.queue.shift();
        if (frame !== undefined) {
          yield frame;
          continue;
        }
        if (this.ended || this.autoEnd) return;
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
        if (signal.aborted) return;
      }
    } finally {
      signal.removeEventListener("abort", wake);
    }
  }.bind(this);

  push(frame: WatchFrame): void {
    this.queue.push(frame);
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  end(): void {
    this.ended = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  /** Let the next reconnected stream stay open (a close is otherwise sticky). */
  reopen(): void {
    this.ended = false;
  }
}

const stores: ControlStore[] = [];
const managers: WatchManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllGlobals();
});

function setup(
  source: WatchSource,
  options: {
    resyncGate?: Promise<void>;
    skills?: string[];
    sleep?: (ms: number) => Promise<void>;
    sleeps?: number[];
  } = {},
) {
  const store = new ControlStore(":memory:");
  stores.push(store);
  store.upsertAgent(agentRow());
  let resyncs = 0;
  const manager = new WatchManager({
    store,
    controlId: "control-1",
    now: () => new Date("2026-02-01T00:00:00.000Z").valueOf(),
    resyncAgent: async () => {
      resyncs += 1;
      if (options.resyncGate !== undefined) await options.resyncGate;
    },
    opener: source.open,
    backoffBaseMs: 50,
    backoffMaxMs: 400,
    jitterRatio: 0,
    random: () => 0,
    sleep:
      options.sleep ??
      ((ms: number) => {
        options.sleeps?.push(ms);
        // Yield to the event loop rather than resolving immediately: an
        // immediately-resolved sleep would let the reconnect loop starve
        // every timer in the worker.
        return new Promise<void>((resolve) => setImmediate(resolve));
      }),
  });
  managers.push(manager);
  const ensure = (): void =>
    manager.ensureAgent(agentRow(), options.skills ?? ["mesh.watch"]);
  return {
    store,
    manager,
    ensure,
    resyncs: () => resyncs,
  };
}

async function waitFor(
  message: string,
  predicate: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("mesh.watch subscription", () => {
  it("applies an updated delta to one row without removing the other", async () => {
    const source = new WatchSource();
    const { store, ensure } = setup(source);
    // Two mirrored sessions BEFORE the subscription opens, so the loss of one
    // is observable rather than vacuous.
    store.upsertSessions(
      PEER,
      [summary("keep"), summary("change")],
      "2026-01-01T00:00:00.000Z",
    );
    expect(store.listSessions(PEER)).toHaveLength(2);
    // A delta routed through upsertSessions would prune the agent's other row
    // (db.ts): any call after the snapshot's bootstrap is the data-loss bug.
    let deltaPhase = false;
    let forbiddenCalls = 0;
    const original = store.upsertSessions.bind(store);
    store.upsertSessions = (...args) => {
      if (deltaPhase) forbiddenCalls += 1;
      return (original as (...call: unknown[]) => void)(...args);
    };
    ensure();
    source.push({
      type: "snapshot",
      sessions: [summary("keep"), summary("change")],
      jobs: [],
    });
    await waitFor("snapshot bootstrap", () =>
      store
        .listSessions(PEER)
        .some((row) => row.synced_at === "2026-02-01T00:00:00.000Z"),
    );
    deltaPhase = true;
    source.push({
      type: "updated",
      session: summary("change", { name: "Changed name" }),
    });
    await waitFor("delta application", () =>
      store
        .listSessions(PEER)
        .some(
          (row) => row.session_id === "change" && row.name === "Changed name",
        ),
    );
    expect(
      forbiddenCalls,
      "delta application clause: no delta may pass through upsertSessions",
    ).toBe(0);
    expect(
      store
        .listSessions(PEER)
        .map((row) => row.session_id)
        .sort(),
      "data-loss clause: the updated delta leaves the other session in place",
    ).toEqual(["change", "keep"]);
  });

  it("applies the bootstrap snapshot as a complete listing", async () => {
    const source = new WatchSource();
    const { store, ensure } = setup(source);
    store.upsertSessions(
      PEER,
      [summary("old-a"), summary("old-b")],
      "2026-01-01T00:00:00.000Z",
    );
    ensure();
    source.push({
      type: "snapshot",
      sessions: [summary("new-a"), summary("new-b")],
      jobs: [],
    });
    await waitFor("snapshot application", () =>
      store.listSessions(PEER).some((row) => row.session_id === "new-a"),
    );
    expect(
      store
        .listSessions(PEER)
        .map((row) => row.session_id)
        .sort(),
      "bootstrap clause: the snapshot replaces the mirror completely",
    ).toEqual(["new-a", "new-b"]);
  });

  it("deletes exactly one row for a removed frame", async () => {
    const source = new WatchSource();
    const { store, ensure } = setup(source);
    ensure();
    source.push({
      type: "snapshot",
      sessions: [summary("gone"), summary("stays")],
      jobs: [],
    });
    await waitFor("snapshot application", () =>
      store.listSessions(PEER).some((row) => row.session_id === "gone"),
    );
    source.push({ type: "removed", id: "gone" });
    await waitFor(
      "removal application",
      () => !store.listSessions(PEER).some((row) => row.session_id === "gone"),
    );
    expect(
      store.listSessions(PEER).map((row) => row.session_id),
      "removed clause: exactly the named row is deleted",
    ).toEqual(["stays"]);
  });

  it("updates one job row per frame and deletes one row per job removal", async () => {
    const source = new WatchSource();
    const { store, manager, ensure } = setup(source);
    const at = "2026-01-01T00:00:00.000Z";
    store.replaceJobs(PEER, [
      {
        job_id: "job-1",
        session_id: "s1",
        pid: 11,
        project: "/work/a",
        created_at: at,
        state: "running",
      },
      {
        job_id: "job-2",
        session_id: "s2",
        pid: 22,
        project: "/work/b",
        created_at: at,
        state: "running",
      },
    ]);
    ensure();
    // The snapshot carries the same jobs as inventory facts; the complete
    // listing must not blank the columns only sync reports.
    source.push({
      type: "snapshot",
      sessions: [],
      jobs: [
        { job_id: "job-1", session_id: "s1", state: "running" },
        { job_id: "job-2", session_id: "s2", state: "running" },
      ],
    });
    await waitFor("snapshot bootstrap", () => manager.status(PEER) === "live");
    expect(
      store.listJobs(PEER).find((row) => row.job_id === "job-1"),
      "snapshot clause: the complete job listing preserves sync-owned columns",
    ).toMatchObject({ pid: 11, project: "/work/a" });
    source.push({
      type: "job",
      job: { job_id: "job-1", session_id: "s1", state: "exited" },
    });
    await waitFor("job delta", () =>
      store
        .listJobs(PEER)
        .some((row) => row.job_id === "job-1" && row.state === "exited"),
    );
    // Columns the watch cannot see survive the delta.
    expect(
      store.listJobs(PEER).find((row) => row.job_id === "job-1"),
      "job delta clause: sync-owned columns survive a state-only frame",
    ).toMatchObject({ pid: 11, project: "/work/a" });
    source.push({ type: "job-removed", job_id: "job-2" });
    await waitFor(
      "job removal",
      () => !store.listJobs(PEER).some((row) => row.job_id === "job-2"),
    );
    expect(
      store.listJobs(PEER).map((row) => row.job_id),
      "job-removed clause: exactly the named job row is deleted",
    ).toEqual(["job-1"]);
  });

  it("marks a closed stream stale, re-lists once, and reconnects with backoff", async () => {
    const source = new WatchSource();
    const sleeps: number[] = [];
    let releaseResync!: () => void;
    const resyncGate = new Promise<void>((resolve) => {
      releaseResync = resolve;
    });
    const { manager, ensure, resyncs } = setup(source, {
      resyncGate,
      sleeps,
    });
    ensure();
    source.push({ type: "snapshot", sessions: [summary("s1")], jobs: [] });
    await waitFor("subscription live", () => manager.status(PEER) === "live");
    source.end();
    await waitFor("stale mark", () => manager.isStale(PEER));
    expect(
      manager.status(PEER),
      "close clause: the mirror reads stale while the re-list is outstanding",
    ).toBe("stale");
    expect(
      resyncs(),
      "close clause: exactly one re-list follows the close",
    ).toBe(1);
    expect(source.opens, "reconnect waits for the re-list").toBe(1);
    releaseResync();
    await waitFor("reconnect", () => source.opens >= 2);
    expect(
      sleeps[0],
      "reconnect clause: the first retry waits out the bounded backoff",
    ).toBe(50);
    expect(
      manager.isStale(PEER),
      "stale clears only on the next snapshot",
    ).toBe(true);
    // The test source's end is sticky; reopen so the next stream stays up
    // long enough for the snapshot to read as live rather than flicker.
    source.reopen();
    source.push({ type: "snapshot", sessions: [summary("s1")], jobs: [] });
    await waitFor("stale cleared", () => manager.status(PEER) === "live");
  });

  it("backs off exponentially across consecutive closes", async () => {
    const source = new WatchSource();
    source.autoEnd = true;
    const sleeps: number[] = [];
    const { manager, ensure } = setup(source, { sleeps });
    ensure();
    await waitFor("two backoffs observed", () => sleeps.length >= 2);
    // Stop the (deliberately endless) reconnect loop before asserting.
    manager.closeAll();
    expect(
      sleeps.slice(0, 2),
      "backoff clause: consecutive closes double the delay within the bound",
    ).toEqual([50, 100]);
  });

  it("re-lists to converge on a dropped marker without reconnecting", async () => {
    const source = new WatchSource();
    const { ensure, resyncs } = setup(source);
    ensure();
    source.push({ type: "snapshot", sessions: [], jobs: [] });
    await waitFor("subscription live", () => source.opens === 1);
    // The stream is still open (no end), so a gap must converge in place.
    source.push({ type: "dropped", reason: "burst", dropped: 3 });
    await waitFor("dropped convergence", () => resyncs() === 1);
    expect(
      source.opens,
      "dropped clause: the gap is repaired by re-list, not reconnect",
    ).toBe(1);
  });

  it("closes the subscription on unpair and evicts the mirror", async () => {
    const source = new WatchSource();
    const { store, manager, ensure } = setup(source);
    ensure();
    source.push({
      type: "snapshot",
      sessions: [summary("s1")],
      jobs: [],
    });
    await waitFor(
      "subscription open",
      () => store.listSessions(PEER).length === 1,
    );
    // Unpairing is the store hook the server installs: rows go, and the held
    // stream goes with them - there is no next request boundary to defer to.
    manager.closeAgent(PEER);
    store.removeAgent(PEER);
    expect(
      source.signals[0]?.aborted,
      "unpair clause: the held stream is aborted",
    ).toBe(true);
    expect(manager.size, "unpair clause: no subscription survives").toBe(0);
    expect(
      store.listSessions(PEER),
      "unpair clause: the session mirror is evicted",
    ).toEqual([]);
    expect(
      store.listJobs(PEER),
      "unpair clause: the jobs mirror is evicted",
    ).toEqual([]);
    const opens = source.opens;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      source.opens,
      "unpair clause: an explicit close never reconnects",
    ).toBe(opens);
  });

  it("never subscribes to an agent without mesh.watch", async () => {
    const source = new WatchSource();
    const { store, manager } = setup(source, { skills: ["session.list"] });
    manager.ensureAgent(agentRow(), ["session.list", "process.list"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      source.opens,
      "capability clause: no stream opens without the advertisement",
    ).toBe(0);
    expect(
      manager.status(PEER),
      "capability clause: the agent reads off, not stale",
    ).toBe("off");
    expect(
      store.listSessions(PEER),
      "capability clause: nothing is mirrored without a subscription",
    ).toEqual([]);
  });

  it("closes the subscription when the capability is withdrawn", async () => {
    const source = new WatchSource();
    const { manager } = setup(source);
    manager.ensureAgent(agentRow(), ["mesh.watch"]);
    await waitFor("subscription open", () => source.opens === 1);
    manager.ensureAgent(agentRow(), ["session.list"]);
    expect(
      source.signals[0]?.aborted,
      "withdrawal clause: the stream closes with the capability",
    ).toBe(true);
    expect(
      manager.size,
      "withdrawal clause: no subscription survives the withdrawal",
    ).toBe(0);
  });
});
