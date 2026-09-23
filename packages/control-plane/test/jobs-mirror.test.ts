// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, expect, it } from "vitest";
import { ControlStore, createControlServer } from "../src/index.js";

const agentId = "22222222-2222-4222-8222-222222222222";
const controlId = "33333333-3333-4333-8333-333333333333";
const token = "dashboard-token";
const credential = Buffer.alloc(32, 7).toString("base64");

const resources: Array<{ stop(): Promise<void>; close?(): void }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    if (resource.close !== undefined) resource.close();
    else await resource.stop();
  }
});

function bodyOf(init: RequestInit | undefined): {
  id: string;
  params?: { message?: { parts?: Array<{ data?: { skill?: string } }> } };
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
 * A control plane talking to a stub agent.
 *
 * `listStarted` resolves once the agent has been asked for its jobs, and
 * `listGate` is awaited before that answer is returned - together they let a test
 * land a write while a listing is in flight, which is the race the freshness
 * guard exists for.
 */
async function setup(
  options: {
    jobs?: Array<{ job_id: string; state: string }>;
    listGate?: Promise<void>;
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
  let listSeen!: () => void;
  const listStarted = new Promise<void>((resolve) => {
    listSeen = resolve;
  });
  const control = createControlServer({
    store,
    host: "127.0.0.1",
    port: 0,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            name: "agent",
            skills: [{ id: "session.list" }, { id: "process.list" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      switch (bodyOf(init).params?.message?.parts?.[0]?.data?.skill) {
        case "process.list": {
          listSeen();
          if (options.listGate !== undefined) await options.listGate;
          return rpc(init, {
            jobs: (options.jobs ?? [{ job_id: "job-1", state: "running" }]).map(
              (job) => ({
                ...job,
                session_id: "session-1",
                pid: 41,
                project: "p",
                started_at: "2026-01-01T00:00:00.000Z",
              }),
            ),
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
        default:
          return rpc(init, {});
      }
    },
  });
  resources.push(control);
  const address = await control.start();
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "content-type": "application/json", "X-Pi-Mesh-Ui": token };
  return { store, base, headers, listStarted };
}

async function state(base: string, headers: Record<string, string>) {
  const response = await fetch(`${base}/api/state`, { headers });
  return (await response.json()) as {
    agents: Array<{ jobs_synced_at: number | null }>;
    jobs: Array<{ job_id: string }>;
  };
}

it("withdraws the freshness claim once this control plane writes a job itself", async () => {
  const { base, headers } = await setup();
  expect(
    (await fetch(`${base}/api/sync`, { method: "POST", headers })).status,
  ).toBe(200);
  expect((await state(base, headers)).agents[0]!.jobs_synced_at).not.toBeNull();

  const spawned = await fetch(`${base}/api/agents/${agentId}/spawn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ project: "p", prompt: "hi" }),
  });
  expect(spawned.status).toBe(200);
  const after = await state(base, headers);
  // The rows for this agent are no longer a verbatim copy of the agent's list,
  // so the label must stop claiming they are.
  expect(after.agents[0]!.jobs_synced_at).toBeNull();
  expect(after.jobs.map((job) => job.job_id)).toContain("spawned-1");
});

it("does not let a stale listing clobber a write that landed mid-flight", async () => {
  let release!: () => void;
  const listGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { base, headers, listStarted } = await setup({
    listGate,
    jobs: [{ job_id: "stale-1", state: "running" }],
  });
  const syncing = fetch(`${base}/api/sync`, { method: "POST", headers });
  await listStarted;
  const spawned = await fetch(`${base}/api/agents/${agentId}/spawn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ project: "p", prompt: "hi" }),
  });
  expect(spawned.status).toBe(200);
  release();
  expect((await syncing).status).toBe(200);

  const after = await state(base, headers);
  // Applying the older answer would have replaced the job the agent does have.
  expect(after.jobs.map((job) => job.job_id)).toContain("spawned-1");
  expect(after.jobs.map((job) => job.job_id)).not.toContain("stale-1");
  expect(after.agents[0]!.jobs_synced_at).toBeNull();
});
