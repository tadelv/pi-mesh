// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { JobManager } from "../../agent/src/jobs.js";
import { createAgentServer } from "../../agent/src/server.js";
import { parseSpawnPolicy } from "../../agent/src/spawn-policy.js";
import { ControlStore, createControlServer } from "../src/index.js";

const agentId = "22222222-2222-4222-8222-222222222222";
const controlId = "33333333-3333-4333-8333-333333333333";
const credential = Buffer.alloc(32, 7).toString("base64");
const sources = new URL("../src/", import.meta.url);
const resources: Array<{
  stop(): Promise<void>;
  close?(): void;
}> = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    if ("close" in resource && resource.close !== undefined) resource.close();
    else await resource.stop();
  }
});

function jobsFixture(existing = false) {
  let sequence = 0;
  const effects: unknown[] = [];
  const manager = new JobManager({
    spawnJob: (_spec, report) => {
      const number = ++sequence;
      const sessionId = `session-${number}`;
      queueMicrotask(() => report.session(sessionId));
      return {
        pid: 100 + number,
        argv: [],
        stdioClosed: false,
        ready: Promise.resolve(),
        command: async (command) => {
          effects.push({ kind: "send", command });
          return { success: true };
        },
        close: async () => {
          effects.push({ kind: "stop" });
          report.exited({ code: 0, signal: null });
        },
      };
    },
  });
  if (existing) {
    manager.start({
      peerId: controlId,
      project: "existing-project",
      cwd: process.cwd(),
      name: "existing-project",
    });
  }
  return { manager, effects, starts: () => sequence };
}

async function setup(
  options: {
    enabled?: boolean;
    existing?: boolean;
    malformedSpawn?: boolean;
  } = {},
) {
  const store = new ControlStore(":memory:");
  resources.push({ stop: async () => undefined, close: () => store.close() });
  store.setMeta("control_id", controlId);
  store.setMeta("dashboard_token", "dashboard-token");
  store.upsertAgent({
    peer_id: agentId,
    name: "agent",
    host: "127.0.0.1",
    port: 1,
    credential,
    paired_at: "now",
  });
  const control = createControlServer({
    store,
    host: "127.0.0.1",
    port: 0,
    ...(options.malformedSpawn
      ? {
          fetch: async (_input: string | URL | Request, init?: RequestInit) => {
            const request = JSON.parse(String(init?.body)) as { id: string };
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: { message: { parts: [{ data: { result: {} } }] } },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        }
      : {}),
  });
  resources.push(control);
  const controlAddress = await control.start();
  const jobFixture = jobsFixture(options.existing);
  const agent = createAgentServer({
    host: "127.0.0.1",
    port: 0,
    swarmKey: Buffer.from("fixture swarm key"),
    identity: { peerId: agentId, name: "test agent" },
    controlCredentials: [{ controlId, credential, pairedAt: "now" }],
    jobs: jobFixture.manager,
    spawnPolicy: parseSpawnPolicy(options.enabled ? "*" : undefined, ""),
  });
  const agentAddress = await agent.start();
  resources.push(agent);
  store.upsertAgent({
    peer_id: agentId,
    name: "agent",
    host: "127.0.0.1",
    port: agentAddress.port,
    credential,
    paired_at: "now",
  });
  const headers = {
    "content-type": "application/json",
    "X-Pi-Mesh-Ui": "dashboard-token",
  };
  const post = async (action: string, body: unknown) => {
    const response = await fetch(
      `http://127.0.0.1:${controlAddress.port}/api/agents/${agentId}/${action}`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return { store, jobFixture, controlAddress, headers, post };
}

it("spawns through the gated agent skill and publishes the cached job", async () => {
  const { store, jobFixture, controlAddress, headers, post } = await setup({
    enabled: true,
  });
  const response = await post("spawn", {
    project: "synthetic-project",
    prompt: "Say hello",
  });
  expect(response.status).toBe(200);
  expect(response.body.ok).toBe(true);
  const result = response.body.result as {
    job_id: string;
    session_id: string;
    pid: number;
  };
  expect(result).toMatchObject({ session_id: "session-1", pid: 101 });
  expect(jobFixture.starts()).toBe(1);
  expect(jobFixture.manager.list()).toHaveLength(1);
  expect(jobFixture.manager.list()[0]).toMatchObject({
    id: result.job_id,
    sessionId: result.session_id,
  });
  const state = await fetch(
    `http://127.0.0.1:${controlAddress.port}/api/state`,
    {
      headers,
    },
  );
  expect(((await state.json()) as { jobs: unknown[] }).jobs).toContainEqual(
    expect.objectContaining({
      agent_id: agentId,
      job_id: result.job_id,
      session_id: "session-1",
      project: "synthetic-project",
      state: "running",
    }),
  );
  expect(store.listJobs(agentId)).toHaveLength(1);
});

it("maps malformed successful spawn results to agent_unreachable without caching a job", async () => {
  const { store, post } = await setup({ malformedSpawn: true });
  const response = await post("spawn", {
    project: "synthetic-project",
    prompt: "Say hello",
  });
  expect(response.status).toBe(502);
  expect(response.body).toMatchObject({
    error: "agent_unreachable",
    message: expect.any(String),
  });
  expect(store.listJobs(agentId)).toEqual([]);
});

it("passes a closed-gate refusal through without starting or caching a job", async () => {
  const { store, jobFixture, post } = await setup({ existing: true });
  // Positive control: this agent has a genuinely tracked session before the
  // denied request, so an unchanged count cannot pass because nothing existed.
  const before = jobFixture.manager.list().length;
  expect(before).toBeGreaterThan(0);
  expect(jobFixture.manager.list()[0]).toMatchObject({ state: "running" });
  const startsBefore = jobFixture.starts();
  const response = await post("spawn", {
    project: "synthetic-project",
    prompt: "Say hello",
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ ok: false, code: -32102 });
  expect(jobFixture.starts()).toBe(startsBefore);
  expect(jobFixture.manager.list()).toHaveLength(before);
  expect(store.listJobs(agentId)).toEqual([]);
});

it("routes steer, stop, and abort to the real agent's corresponding effects", async () => {
  const { store, jobFixture, post } = await setup({ enabled: true });
  const spawned = await post("spawn", {
    project: "synthetic-project",
    prompt: "Say hello",
  });
  expect(spawned.body.ok).toBe(true);
  const jobId = (spawned.body.result as { job_id: string }).job_id;
  expect(
    (await post("steer", { job_id: jobId, message: "Continue" })).body,
  ).toMatchObject({
    ok: true,
    result: { success: true },
  });
  expect((await post("abort", { job_id: jobId })).body).toMatchObject({
    ok: true,
    result: { success: true },
  });
  expect((await post("stop", { job_id: jobId })).body).toMatchObject({
    ok: true,
    result: { state: "exited" },
  });
  expect(store.listJobs(agentId)).toContainEqual(
    expect.objectContaining({ job_id: jobId, state: "exited" }),
  );
  expect(jobFixture.effects).toEqual([
    { kind: "send", command: { type: "prompt", message: "Say hello" } },
    { kind: "send", command: { type: "steer", message: "Continue" } },
    { kind: "send", command: { type: "abort" } },
    { kind: "stop" },
  ]);
});

it("returns unknown-agent and unauthorized responses", async () => {
  const { controlAddress, headers } = await setup();
  const unknown = await fetch(
    `http://127.0.0.1:${controlAddress.port}/api/agents/no-such-agent/stop`,
    { method: "POST", headers, body: JSON.stringify({ job_id: "j1" }) },
  );
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "unknown_agent" });
  const unauthorized = await fetch(
    `http://127.0.0.1:${controlAddress.port}/api/agents/${agentId}/spawn`,
    { method: "POST", body: JSON.stringify({ project: "p", prompt: "x" }) },
  );
  expect(unauthorized.status).toBe(401);
  expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
});

it("rejects control-plane process execution machinery", async () => {
  const directory = fileURLToPath(sources);
  const files = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  for (const file of files.filter((entry) => entry.isFile())) {
    const path = join(directory, file.name);
    const source = await readFile(path, "utf8");
    expect(source, `${file.name} must not manage processes`).not.toMatch(
      /child_process|\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/,
    );
  }
});
