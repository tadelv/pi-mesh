// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * M8-7 STEP 2: runs and findings mirrored through the watch.
 *
 * Each clause fails by name when the code it protects is removed. The
 * WatchSource harness mirrors test/watch.test.ts: the test decides exactly
 * what lands on the subscription.
 */

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WatchFinding,
  WatchFindingsCoverage,
  WatchFrame,
  WatchRun,
} from "@pi-mesh/protocol";
import { ControlStore, createControlServer } from "../src/index.js";
import type { AgentTarget } from "../src/client.js";
import { WatchManager, type WatchOpener } from "../src/watch.js";

const PEER = "agent-runs-1";
const PEER_B = "agent-runs-2";
const AT = "2026-01-01T00:00:00.000Z";
const NOW_MS = new Date("2026-02-01T00:00:00.000Z").valueOf();
const NOW_ISO = "2026-02-01T00:00:00.000Z";

function run(id: string, overrides: Partial<WatchRun> = {}): WatchRun {
  return {
    run_id: id,
    state: "running",
    liveness: {
      state: "alive",
      reason: "pid-alive",
      probed_at: NOW_ISO,
      status_age_ms: 1_000,
    },
    pid: 101,
    started_at: "2026-01-01T00:00:00.000Z",
    last_update: "2026-01-01T00:01:00.000Z",
    status_age_ms: 1_000,
    steps: [],
    ...overrides,
  };
}

function finding(rule: string, runId: string, summary: string): WatchFinding {
  return {
    rule,
    run_id: runId,
    summary,
    observed_at: NOW_ISO,
  };
}

function coverage(
  overrides: Partial<WatchFindingsCoverage> = {},
): WatchFindingsCoverage {
  return {
    layout_recognised: true,
    last_success: NOW_ISO,
    last_error: null,
    ...overrides,
  };
}

function agentRow(peerId: string) {
  return {
    peer_id: peerId,
    name: `Agent ${peerId}`,
    host: "127.0.0.1",
    port: 1,
    credential: Buffer.alloc(32, 9).toString("base64"),
    paired_at: AT,
  };
}

/** A hand-driven mesh.watch source: the test decides exactly what lands. */
class WatchSource {
  readonly signals: AbortSignal[] = [];
  opens = 0;
  private readonly queue: WatchFrame[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;

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
        if (this.ended) return;
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
}

const stores: ControlStore[] = [];
const managers: WatchManager[] = [];
const closables: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const close of closables.splice(0)) await close();
  for (const store of stores.splice(0)) store.close();
});

function setup(source: WatchSource) {
  const store = new ControlStore(":memory:");
  stores.push(store);
  store.upsertAgent(agentRow(PEER));
  const manager = new WatchManager({
    store,
    controlId: "control-1",
    now: () => NOW_MS,
    resyncAgent: async () => undefined,
    opener: source.open,
    backoffBaseMs: 50,
    backoffMaxMs: 400,
    jitterRatio: 0,
    random: () => 0,
    sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
  managers.push(manager);
  return { store, manager };
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

describe("M8-7 runs mirror", () => {
  it("runs-delta-keeps-others: a run delta leaves the agent's other runs in place", async () => {
    const source = new WatchSource();
    const { store, manager } = setup(source);
    // Two mirrored runs BEFORE the subscription opens, so the loss of one
    // is observable rather than vacuous.
    store.replaceRuns(PEER, [run("keep"), run("change")], AT);
    expect(store.listRuns(PEER)).toHaveLength(2);
    // A delta routed through replaceRuns would prune the agent's other row:
    // any call after the snapshot's bootstrap is the data-loss bug.
    let deltaPhase = false;
    let forbiddenCalls = 0;
    const original = store.replaceRuns.bind(store);
    store.replaceRuns = (...args) => {
      if (deltaPhase) forbiddenCalls += 1;
      return (original as (...call: unknown[]) => void)(...args);
    };
    manager.ensureAgent(agentRow(PEER), ["mesh.watch"]);
    source.push({
      type: "snapshot",
      sessions: [],
      jobs: [],
      runs: [run("keep"), run("change")],
    });
    await waitFor(
      "snapshot bootstrap",
      () => store.runsSyncedAt(PEER) === NOW_ISO,
    );
    deltaPhase = true;
    source.push({
      type: "run",
      run: run("change", { state: "complete" }),
    });
    await waitFor("delta application", () =>
      store
        .listRuns(PEER)
        .some((row) => row.run_id === "change" && row.state === "complete"),
    );
    expect(
      forbiddenCalls,
      "runs-delta-keeps-others: no delta may pass through the complete-listing path (route it through replaceRuns to fail this)",
    ).toBe(0);
    expect(
      store
        .listRuns(PEER)
        .map((row) => row.run_id)
        .sort(),
      "runs-delta-keeps-others: the run delta leaves the other run in place",
    ).toEqual(["change", "keep"]);
  });

  it("runs-bootstrap-complete: the snapshot replaces runs completely, and an absent field leaves the mirror alone", async () => {
    const source = new WatchSource();
    const { store, manager } = setup(source);
    store.replaceRuns(PEER, [run("old-a"), run("old-b")], AT);
    manager.ensureAgent(agentRow(PEER), ["mesh.watch"]);
    source.push({
      type: "snapshot",
      sessions: [],
      jobs: [],
      runs: [run("new-a")],
    });
    await waitFor("snapshot application", () =>
      store.listRuns(PEER).some((row) => row.run_id === "new-a"),
    );
    expect(
      store.listRuns(PEER).map((row) => row.run_id),
      "runs-bootstrap-complete: the snapshot prunes what it no longer lists",
    ).toEqual(["new-a"]);
    // An older agent whose snapshot carries no runs must not wipe the
    // mirror: absent means not observed, never \"none\".
    source.push({ type: "snapshot", sessions: [], jobs: [] });
    await waitFor(
      "second snapshot",
      () => store.runsSyncedAt(PEER) === NOW_ISO,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      store.listRuns(PEER).map((row) => row.run_id),
      "runs-bootstrap-complete: an absent runs field leaves the mirror alone",
    ).toEqual(["new-a"]);
  });

  it("runs-removed: deletes exactly one row for exactly one agent", async () => {
    const source = new WatchSource();
    const { store, manager } = setup(source);
    store.upsertAgent(agentRow(PEER_B));
    store.replaceRuns(PEER, [run("gone"), run("stays")], AT);
    store.replaceRuns(PEER_B, [run("gone")], AT);
    manager.ensureAgent(agentRow(PEER), ["mesh.watch"]);
    source.push({
      type: "snapshot",
      sessions: [],
      jobs: [],
      runs: [run("gone"), run("stays")],
    });
    await waitFor(
      "snapshot bootstrap",
      () => store.runsSyncedAt(PEER) === NOW_ISO,
    );
    source.push({ type: "run-removed", run_id: "gone" });
    await waitFor(
      "removal application",
      () => !store.listRuns(PEER).some((row) => row.run_id === "gone"),
    );
    expect(
      store.listRuns(PEER).map((row) => row.run_id),
      "runs-removed: exactly the named row is deleted",
    ).toEqual(["stays"]);
    expect(
      store.listRuns(PEER_B).map((row) => row.run_id),
      "runs-removed: a removal for agent A never touches agent B",
    ).toEqual(["gone"]);
  });
});

describe("M8-7 findings mirror", () => {
  it("findings-replace: a findings frame replaces the previous set wholesale", async () => {
    const source = new WatchSource();
    const { store, manager } = setup(source);
    manager.ensureAgent(agentRow(PEER), ["mesh.watch"]);
    source.push({
      type: "snapshot",
      sessions: [],
      jobs: [],
      runs: [],
      findings: {
        findings: [
          finding("run-stale", "run-1", "stale one"),
          finding("run-long", "run-2", "long two"),
        ],
        evaluated_at: "2026-01-01T00:00:00.000Z",
        coverage: coverage({ last_success: "2026-01-01T00:00:00.000Z" }),
      },
    });
    await waitFor(
      "snapshot findings",
      () => store.listFindings(PEER).length === 2,
    );
    source.push({
      type: "findings",
      findings: [finding("run-budget-usd", "run-3", "over budget")],
      evaluated_at: NOW_ISO,
      coverage: coverage(),
    });
    await waitFor("findings replacement", () =>
      store.listFindings(PEER).some((row) => row.rule === "run-budget-usd"),
    );
    expect(
      store.listFindings(PEER).map((row) => row.rule),
      "findings-replace: the frame replaces the previous set, never patches it",
    ).toEqual(["run-budget-usd"]);
    expect(
      store.getFindingsSnapshot(PEER)?.evaluated_at,
      "findings-replace: evaluated_at travels with the set",
    ).toBe(NOW_ISO);
    expect(
      store.getFindingsSnapshot(PEER),
      "findings-replace: coverage travels with the set",
    ).toMatchObject({ layout_recognised: true, last_error: null });
  });

  it("findings-absent: no observed pass is not rendered as no findings", async () => {
    const source = new WatchSource();
    const { store, manager } = setup(source);
    manager.ensureAgent(agentRow(PEER), ["mesh.watch"]);
    // Snapshots without findings: an older agent that reports none.
    source.push({ type: "snapshot", sessions: [], jobs: [] });
    await waitFor("snapshot bootstrap", () => manager.status(PEER) === "live");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      store.getFindingsSnapshot(PEER),
      "findings-absent: with no observed pass there is no snapshot row (absence is not 'no findings')",
    ).toBeUndefined();
    expect(
      store.listFindings(PEER),
      "findings-absent: with no observed pass there are no mirrored rows",
    ).toEqual([]);
  });

  it("findings-empty-observed: an evaluated empty set is stored with its pass", async () => {
    const source = new WatchSource();
    const { store, manager } = setup(source);
    manager.ensureAgent(agentRow(PEER), ["mesh.watch"]);
    source.push({
      type: "snapshot",
      sessions: [],
      jobs: [],
      runs: [],
      findings: { findings: [], evaluated_at: NOW_ISO, coverage: coverage() },
    });
    await waitFor(
      "snapshot findings",
      () => store.getFindingsSnapshot(PEER) !== undefined,
    );
    expect(
      store.listFindings(PEER),
      "findings-empty-observed: evaluated-empty stores no rows",
    ).toEqual([]);
    expect(
      store.getFindingsSnapshot(PEER)?.evaluated_at,
      "findings-empty-observed: but the pass itself is recorded, unlike absence",
    ).toBe(NOW_ISO);
  });
});

describe("M8-7 mirror freshness and eviction", () => {
  it("freshness-stamp: mirror writes stamp runs rows and the findings snapshot", async () => {
    const store = new ControlStore(":memory:");
    stores.push(store);
    store.upsertRun(PEER, run("run-1"), NOW_ISO);
    expect(
      store.runsSyncedAt(PEER),
      "freshness-stamp: a mirrored run row carries its mirror write time (remove the synced_at write to fail this)",
    ).toBe(NOW_ISO);
    expect(
      store.runsSyncedAt("no-such-agent"),
      "freshness-stamp: an agent with no mirrored runs has no stamp",
    ).toBeNull();
    store.replaceFindings(
      PEER,
      { findings: [], evaluated_at: NOW_ISO, coverage: coverage() },
      NOW_ISO,
    );
    expect(
      store.getFindingsSnapshot(PEER)?.evaluated_at,
      "freshness-stamp: the snapshot carries the pass time (remove the evaluated_at write to fail this)",
    ).toBe(NOW_ISO);
  });

  it("freshness-stamp-state: /api/state exposes the stamps the panel renders", async () => {
    const store = new ControlStore(":memory:");
    stores.push(store);
    store.setMeta("control_id", "control-1");
    const token = store.dashboardToken();
    store.upsertAgent(agentRow(PEER));
    store.upsertAgent(agentRow(PEER_B));
    store.replaceRuns(PEER, [run("run-1")], NOW_ISO);
    store.replaceFindings(
      PEER,
      {
        findings: [finding("run-stale", "run-1", "stale")],
        evaluated_at: NOW_ISO,
        coverage: coverage(),
      },
      NOW_ISO,
    );
    const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
    closables.push(() => control.stop());
    const { port } = await control.start();
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { "X-Pi-Mesh-Ui": token },
    });
    expect(response.status).toBe(200);
    const state = (await response.json()) as {
      runs: unknown[];
      findings: unknown[];
      agents: Array<{
        peer_id: string;
        runs_synced_at: number | null;
        findings_snapshot: {
          evaluated_at: string;
          coverage: {
            layout_recognised: boolean;
            last_success: string | null;
            last_error: string | null;
          };
        } | null;
      }>;
    };
    expect(state.runs).toHaveLength(1);
    expect(state.findings).toHaveLength(1);
    const observed = state.agents.find((agent) => agent.peer_id === PEER);
    expect(
      observed?.runs_synced_at,
      "freshness-stamp-state: the state carries the runs stamp (remove it to fail this)",
    ).toBe(NOW_MS);
    expect(
      observed?.findings_snapshot,
      "freshness-stamp-state: the state carries the findings pass with coverage (remove it to fail this)",
    ).toMatchObject({
      evaluated_at: NOW_ISO,
      coverage: { layout_recognised: true, last_error: null },
    });
    const unobserved = state.agents.find((agent) => agent.peer_id === PEER_B);
    expect(
      unobserved?.runs_synced_at,
      "freshness-stamp-state: an agent with no mirrored runs has no stamp",
    ).toBeNull();
    expect(
      unobserved?.findings_snapshot,
      "freshness-stamp-state: an agent with no observed pass has no snapshot (not 'no findings')",
    ).toBeNull();
  });

  it("unpair-evicts-runs: removeAgent evicts runs, findings and the snapshot", async () => {
    const store = new ControlStore(":memory:");
    stores.push(store);
    store.upsertAgent(agentRow(PEER));
    store.replaceRuns(PEER, [run("run-1")], NOW_ISO);
    store.replaceFindings(
      PEER,
      {
        findings: [finding("run-stale", "run-1", "stale")],
        evaluated_at: NOW_ISO,
        coverage: coverage(),
      },
      NOW_ISO,
    );
    store.removeAgent(PEER);
    expect(store.listRuns(PEER)).toEqual([]);
    expect(store.listFindings(PEER)).toEqual([]);
    expect(
      store.getFindingsSnapshot(PEER),
      "unpair-evicts-runs: the snapshot goes with the pairing",
    ).toBeUndefined();
    expect(store.runsSyncedAt(PEER)).toBeNull();
  });
});

describe("M8-7 runs panel refresh path", () => {
  const markup = readFileSync(
    new URL("../src/dashboard.html", import.meta.url),
    "utf8",
  );
  const panel = markup.slice(
    markup.indexOf("M8-7-RUNS-PANEL-BEGIN"),
    markup.indexOf("M8-7-RUNS-PANEL-END"),
  );

  it("no-second-refresh-mechanism: the panel opens no timer, interval or subscription", async () => {
    expect(
      markup.indexOf("M8-7-RUNS-PANEL-BEGIN"),
      "no-second-refresh-mechanism: the panel region must stay delimited",
    ).toBeGreaterThanOrEqual(0);
    for (const forbidden of [
      "setInterval",
      "setTimeout",
      "setImmediate",
      "requestAnimationFrame",
      "fetch(",
      "EventSource",
      "WebSocket",
      "XMLHttpRequest",
    ]) {
      expect(
        panel,
        `no-second-refresh-mechanism: the runs panel must not contain ${forbidden} - it is fed by the same watch subscription as the session list`,
      ).not.toContain(forbidden);
    }
    expect(
      markup,
      "no-second-refresh-mechanism: the panel renders through the shared render path",
    ).toContain("renderRuns();");
  });
});

describe("M8-7 sync path for runs", () => {
  async function startStub(runs: WatchRun[]): Promise<{
    stub: Server;
    port: number;
    requests: string[];
  }> {
    const requests: string[] = [];
    const stub = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://stub");
      if (
        request.method === "GET" &&
        url.pathname === "/.well-known/agent-card.json"
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            name: "stub",
            skills: ["session.list", "run.list", "run.findings"].map((id) => ({
              id,
              name: id,
              description: "",
              tags: [],
            })),
          }),
        );
        return;
      }
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const rpc = JSON.parse(body) as {
          id: unknown;
          params?: {
            message?: { parts?: Array<{ data?: { skill?: string } }> };
          };
        };
        const skill = rpc.params?.message?.parts?.[0]?.data?.skill ?? "";
        requests.push(skill);
        const reply = (result: unknown): void => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: { message: { parts: [{ data: { result } }] } },
            }),
          );
        };
        if (skill === "session.list") reply({ sessions: [] });
        else if (skill === "process.list") reply({ jobs: [] });
        else if (skill === "run.list")
          reply({
            runs,
            coverage: {
              layout_recognised: true,
              last_success: NOW_ISO,
              last_error: null,
            },
            evaluated_at: NOW_ISO,
          });
        else if (skill === "run.findings")
          reply({
            findings: [],
            config: {},
            coverage: {
              layout_recognised: true,
              last_success: NOW_ISO,
              last_error: null,
            },
            evaluated_at: NOW_ISO,
          });
        else reply({});
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    closables.push(
      () => new Promise<void>((resolve) => stub.close(() => resolve())),
    );
    return { stub, port: (stub.address() as { port: number }).port, requests };
  }

  it("sync-mirrors-runs: one listing replaces the agent's runs, and run.findings is never consumed", async () => {
    const { port, requests } = await startStub([run("run-1"), run("run-2")]);
    const store = new ControlStore(":memory:");
    stores.push(store);
    store.setMeta("control_id", "control-1");
    const token = store.dashboardToken();
    store.upsertAgent({
      peer_id: PEER,
      name: "stub",
      host: "127.0.0.1",
      port,
      credential: Buffer.alloc(32, 7).toString("base64"),
      paired_at: AT,
    });
    store.replaceRuns(PEER, [run("run-old")], AT);
    const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
    closables.push(() => control.stop());
    const address = await control.start();
    const synced = await fetch(`http://127.0.0.1:${address.port}/api/sync`, {
      method: "POST",
      headers: { "X-Pi-Mesh-Ui": token, "content-type": "application/json" },
      body: "{}",
    });
    expect(synced.status).toBe(200);
    expect(
      store
        .listRuns(PEER)
        .map((row) => row.run_id)
        .sort(),
      "sync-mirrors-runs: the listing replaces the agent's runs completely",
    ).toEqual(["run-1", "run-2"]);
    expect(
      requests,
      "sync-mirrors-runs: run.list is the one refresh path for runs",
    ).toContain("run.list");
    expect(
      requests,
      "sync-mirrors-runs: run.findings is never called by sync - it is notify-once per epoch and calling it would consume the agent's suppression",
    ).not.toContain("run.findings");
  });
});
