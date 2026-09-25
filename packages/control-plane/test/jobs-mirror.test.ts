// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, expect, it } from "vitest";
import { ControlStore, createControlServer } from "../src/index.js";

const agentId = "22222222-2222-4222-8222-222222222222";
const controlId = "33333333-3333-4333-8333-333333333333";
const token = "dashboard-token";
const credential = Buffer.alloc(32, 7).toString("base64");

type Job = { job_id: string; state: string };

const resources: Array<{ stop(): Promise<void>; close?(): void }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    if (resource.close !== undefined) resource.close();
    else await resource.stop();
  }
});

function bodyOf(init: RequestInit | undefined): {
  id: string;
  params?: {
    message?: { parts?: Array<{ data?: { skill?: string; input?: Job } }> };
  };
} {
  return JSON.parse(String(init?.body)) as ReturnType<typeof bodyOf>;
}

function rpc(init: RequestInit | undefined, result: unknown): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: bodyOf(init).id,
      result: { message: { parts: [{ data: { result } }] } },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * A control plane talking to a stub agent. `jobsFor` answers per listing, and
 * `gates` holds a listing open until the test releases it - together they let a
 * test land a write mid-flight, or complete two listings out of order.
 */
async function setup(
  options: {
    jobsFor?: (index: number) => Job[];
    gates?: Array<Promise<void>>;
    /** Indices of process.list calls that fail, and of card fetches that do. */
    failListings?: number[];
    failCards?: number[];
    /** Holds the Nth card fetch open, so it can complete after a later sync. */
    cardGates?: Array<Promise<void>>;
  } = {},
) {
  const store = new ControlStore(":memory:");
  resources.push({ stop: async () => undefined, close: () => store.close() });
  store.setMeta("control_id", controlId);
  store.setMeta("dashboard_token", token);
  store.upsertAgent({
    peer_id: agentId,
    name: "agent",
    host: "127.0.0.1",
    port: 1,
    credential,
    paired_at: "now",
  });
  let listing = 0;
  let cards = 0;
  const arrived: Array<() => void> = [];
  const cardArrived: Array<() => void> = [];
  const cardWaiters: Array<Promise<void>> = [];
  /** Create this BEFORE starting the sync it belongs to. */
  const waitForCard = (index: number): Promise<void> => {
    cardWaiters[index] ??= new Promise<void>((resolve) => {
      cardArrived[index] = resolve;
    });
    return cardWaiters[index];
  };
  const started: Array<Promise<void>> = [];
  /** Create this BEFORE starting the sync it belongs to, or the signal is missed. */
  const waitForListing = (index: number): Promise<void> => {
    started[index] ??= new Promise<void>((resolve) => {
      arrived[index] = resolve;
    });
    return started[index];
  };
  const control = createControlServer({
    store,
    host: "127.0.0.1",
    port: 0,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        const cardIndex = cards++;
        cardArrived[cardIndex]?.();
        if (options.cardGates?.[cardIndex] !== undefined) {
          await options.cardGates[cardIndex];
        }
        if (options.failCards?.includes(cardIndex)) {
          return new Response(null, { status: 500 });
        }
        return new Response(
          JSON.stringify({
            name: "agent",
            skills: [{ id: "session.list" }, { id: "process.list" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const body = bodyOf(init);
      const skill = body.params?.message?.parts?.[0]?.data?.skill;
      switch (skill) {
        case "process.list": {
          const index = listing++;
          arrived[index]?.();
          if (options.gates?.[index] !== undefined) await options.gates[index];
          if (options.failListings?.includes(index)) {
            return new Response(null, { status: 500 });
          }
          const jobs = (
            options.jobsFor ?? (() => [{ job_id: "job-1", state: "running" }])
          )(index);
          return rpc(init, {
            jobs: jobs.map((job) => ({
              ...job,
              session_id: "session-1",
              pid: 41,
              project: "p",
              started_at: "2026-01-01T00:00:00.000Z",
            })),
          });
        }
        case "session.list":
          return rpc(init, { sessions: [] });
        case "process.spawn":
          return rpc(init, {
            job_id: "spawned-1",
            session_id: "session-2",
            pid: 42,
          });
        case "process.stop":
          return rpc(init, {
            job_id: body.params?.message?.parts?.[0]?.data?.input?.job_id,
            state: "exited",
            pid: 41,
          });
        default:
          return rpc(init, {});
      }
    },
  });
  resources.push(control);
  const address = await control.start();
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "content-type": "application/json", "X-Pi-Mesh-Ui": token };
  return { store, base, headers, waitForListing, waitForCard };
}

async function state(base: string, headers: Record<string, string>) {
  const response = await fetch(`${base}/api/state`, { headers });
  return (await response.json()) as {
    agents: Array<{ jobs_synced_at: number | null }>;
    jobs: Array<{ job_id: string }>;
  };
}

const sync = (base: string, headers: Record<string, string>) =>
  fetch(`${base}/api/sync`, { method: "POST", headers });

const spawn = (base: string, headers: Record<string, string>) =>
  fetch(`${base}/api/agents/${agentId}/spawn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ project: "p", prompt: "hi" }),
  });

const stop = (base: string, headers: Record<string, string>, jobId: string) =>
  fetch(`${base}/api/agents/${agentId}/stop`, {
    method: "POST",
    headers,
    body: JSON.stringify({ job_id: jobId }),
  });

it("withdraws the freshness claim once this control plane writes a job itself", async () => {
  const { base, headers } = await setup();
  expect((await sync(base, headers)).status).toBe(200);
  expect((await state(base, headers)).agents[0]!.jobs_synced_at).not.toBeNull();

  expect((await spawn(base, headers)).status).toBe(200);
  const after = await state(base, headers);
  // The rows for this agent are no longer a verbatim copy of the agent's list,
  // so the label must stop claiming they are.
  expect(after.agents[0]!.jobs_synced_at).toBeNull();
  expect(after.jobs.map((job) => job.job_id)).toContain("spawned-1");
});

it("keeps the claim when a stop changed no row", async () => {
  // A stop for a job this cache has never seen updates nothing, so the mirror is
  // still exactly what the agent reported. "Only a real write" has to mean it.
  const { base, headers } = await setup();
  expect((await sync(base, headers)).status).toBe(200);
  const stopped = await stop(base, headers, "never-seen");
  expect(stopped.status).toBe(200);
  const after = await state(base, headers);
  expect(after.agents[0]!.jobs_synced_at).not.toBeNull();
  expect(after.jobs.map((job) => job.job_id)).toEqual(["job-1"]);
});

it("does not let a stale listing clobber a write that landed mid-flight", async () => {
  let release!: () => void;
  const listGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { base, headers, waitForListing } = await setup({
    gates: [listGate],
    jobsFor: () => [{ job_id: "stale-1", state: "running" }],
  });
  const listed = waitForListing(0);
  const syncing = sync(base, headers);
  await listed;
  expect((await spawn(base, headers)).status).toBe(200);
  release();
  expect((await syncing).status).toBe(200);

  const after = await state(base, headers);
  // Applying the older answer would have replaced the job the agent does have.
  expect(after.jobs.map((job) => job.job_id)).toContain("spawned-1");
  expect(after.jobs.map((job) => job.job_id)).not.toContain("stale-1");
  expect(after.agents[0]!.jobs_synced_at).toBeNull();
});

it("applies concurrent listings in order, not by completion", async () => {
  // Two syncs in flight: the one that started LATER finishes FIRST and must win.
  // Comparing wall-clock timestamps let the slower, older answer overwrite it and
  // still be labelled fresh - which is why the guard is a sequence number.
  const releases: Array<() => void> = [];
  const gates = [0, 1].map(
    () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
  );
  const { base, headers, waitForListing } = await setup({
    gates,
    jobsFor: (index) => [
      { job_id: index === 0 ? "from-first" : "from-second", state: "running" },
    ],
  });
  const firstListed = waitForListing(0);
  const first = sync(base, headers);
  await firstListed;
  const secondListed = waitForListing(1);
  const second = sync(base, headers);
  await secondListed;

  releases[1]!(); // the later listing answers first
  expect((await second).status).toBe(200);
  releases[0]!(); // the earlier listing answers afterwards
  expect((await first).status).toBe(200);

  const after = await state(base, headers);
  expect(after.jobs.map((job) => job.job_id)).toEqual(["from-second"]);
  expect(after.agents[0]!.jobs_synced_at).not.toBeNull();
});

it("does not let an older failed listing erase a newer listing's freshness", async () => {
  // Listing 0 is held open and will FAIL. Listing 1 completes first and applies,
  // claiming freshness. The older failure must not withdraw that claim: the rows
  // are still exactly what the agent reported.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { base, headers, waitForListing } = await setup({
    gates: [gate],
    failListings: [0],
    jobsFor: (index) =>
      index === 0 ? [] : [{ job_id: "from-second", state: "running" }],
  });
  const firstListed = waitForListing(0);
  const first = sync(base, headers);
  await firstListed;
  // Started only once the first listing is in flight, so its sequence is newer.
  const second = sync(base, headers);
  expect((await second).status).toBe(200);
  expect((await state(base, headers)).agents[0]!.jobs_synced_at).not.toBeNull();

  release();
  expect((await first).status).toBe(200);
  const after = await state(base, headers);
  expect(after.agents[0]!.jobs_synced_at).not.toBeNull();
  expect(after.jobs.map((job) => job.job_id)).toEqual(["from-second"]);
});

it("keeps a newer failed listing's freshness withdrawal after an older success arrives", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { base, headers, waitForListing } = await setup({
    gates: [Promise.resolve(), gate],
    failListings: [2],
    jobsFor: (index) => [
      { job_id: index === 0 ? "baseline" : "obsolete", state: "running" },
    ],
  });
  // A real successful baseline makes the later withdrawal observable.
  expect((await sync(base, headers)).status).toBe(200);
  expect((await state(base, headers)).agents[0]!.jobs_synced_at).not.toBeNull();
  expect((await state(base, headers)).jobs.map((job) => job.job_id)).toEqual([
    "baseline",
  ]);

  const oldListed = waitForListing(1);
  const oldSync = sync(base, headers);
  await oldListed;
  const newerListed = waitForListing(2);
  const newerSync = sync(base, headers);
  await newerListed;
  expect((await newerSync).status).toBe(200);
  expect((await state(base, headers)).agents[0]!.jobs_synced_at).toBeNull();

  release();
  expect((await oldSync).status).toBe(200);
  const after = await state(base, headers);
  expect(
    after.agents[0]!.jobs_synced_at,
    "newer failed jobs listing keeps the mirror unconfirmed",
  ).toBeNull();
  expect(
    after.jobs.map((job) => job.job_id),
    "older success cannot replace rows after the newer failure",
  ).toEqual(["baseline"]);
});

it("does not let an older failed card fetch erase a newer listing's freshness", async () => {
  // The same ordering rule must cover a failure BEFORE any listing starts. The
  // first sync's card fetch is held open and then fails; the second sync starts
  // later, lists, and claims freshness. The older failure must not withdraw it.
  let release!: () => void;
  const cardGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { base, headers, waitForCard } = await setup({
    cardGates: [cardGate],
    failCards: [0],
  });
  const firstCard = waitForCard(0);
  const first = sync(base, headers);
  await firstCard;

  const second = sync(base, headers);
  expect((await second).status).toBe(200);
  expect((await state(base, headers)).agents[0]!.jobs_synced_at).not.toBeNull();

  release();
  expect((await first).status).toBe(200);
  expect((await state(base, headers)).agents[0]!.jobs_synced_at).not.toBeNull();
});
