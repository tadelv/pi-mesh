// SPDX-License-Identifier: GPL-3.0-or-later

import { copyFile, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { getSessionStorageDir } from "../../agent/src/sessions.js";
import { pair } from "../../agent/src/pair.js";
import { JobManager } from "../../agent/src/jobs.js";
import { parseSpawnPolicy } from "../../agent/src/spawn-policy.js";
import { createAgentServer } from "../../agent/src/server.js";
import {
  ControlStore,
  PairingService,
  createControlServer,
} from "../src/index.js";

const rootPath = dirname(fileURLToPath(import.meta.url));
const controls: Array<{ stop(): Promise<void> }> = [];
const agents: Array<{ stop(): Promise<void> }> = [];
const stores: ControlStore[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  for (const control of controls.splice(0)) await control.stop();
  for (const store of stores.splice(0)) store.close();
});
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (address === null || typeof address === "string")
    throw new Error("no probe address");
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

it("pairs a real agent, syncs its session, and retains the cache offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-mesh-vertical-"));
  const store = new ControlStore(join(root, "control.db"));
  stores.push(store);
  const controlId = store.controlId();
  const pairing = new PairingService({
    controlId,
    controlName: "test control",
  });
  const control = createControlServer({
    store,
    pairing,
    port: 0,
    host: "127.0.0.1",
  });
  controls.push(control);
  const address = await control.start();
  const port = await freePort();
  const identity = {
    peerId: "22222222-2222-4222-8222-222222222222",
    name: "slice-agent",
  };
  const issued = pairing.issue();
  const output = { write: () => true };
  expect(
    await pair([issued.token, "--control-host", `127.0.0.1:${address.port}`], {
      stdout: output,
      stderr: output,
      identity,
      controlCredentialsPath: join(root, "agent-credentials.json"),
      agentPort: port,
    }),
  ).toBe(0);
  await expect(
    readFile(join(root, "agent-credentials.json"), "utf8"),
  ).resolves.toContain(controlId);

  const sessionsRoot = join(root, "sessions");
  const directory = getSessionStorageDir("/synthetic/project", sessionsRoot);
  await mkdir(directory, { recursive: true });
  await copyFile(
    join(rootPath, "../../agent/test/fixtures/pi-0.85.1-session-v3.jsonl"),
    join(directory, "fixture.jsonl"),
  );
  const jobs = new JobManager({
    spawnJob: (_spec, report) => ({
      pid: 1234,
      argv: ["pi", "--mode", "rpc"],
      stdioClosed: true,
      command: async () => ({ type: "get_state", success: true }),
      close: async () => report.exited({ code: 0, signal: null }),
    }),
  });
  const sourceJob = jobs.start({
    peerId: identity.peerId,
    project: "/synthetic/job-project",
    cwd: "/synthetic/job-project",
    name: "sync-test",
  });
  const agent = createAgentServer({
    jobs,
    spawnPolicy: parseSpawnPolicy(undefined, "*"),
    port,
    host: "127.0.0.1",
    swarmKey: Buffer.from("fixture swarm key"),
    identity,
    controlCredentialsPath: join(root, "agent-credentials.json"),
    sessionsRoot,
  });
  agents.push(agent);
  await agent.start();
  const headers = { "X-Pi-Mesh-Ui": store.dashboardToken() };
  const synced = await fetch(`http://127.0.0.1:${address.port}/api/sync`, {
    method: "POST",
    headers,
  });
  const result = (await synced.json()) as {
    results: Array<{ peer_id: string; ok: boolean }>;
  };
  expect(result.results).toContainEqual({
    peer_id: identity.peerId,
    ok: true,
    count: 1,
  });
  const [session] = store.listSessions(identity.peerId);
  expect(session).toBeDefined();
  const firstStateResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/state`,
    { headers },
  );
  const firstState = (await firstStateResponse.json()) as {
    agents: Array<{ peer_id: string; jobs_synced_at: number | null }>;
    jobs: Array<{ agent_id: string; job_id: string; project: string }>;
  };
  expect(
    firstState.agents.find((entry) => entry.peer_id === identity.peerId)
      ?.jobs_synced_at,
    "process.list sync freshness clause: successful job sync records its timestamp",
  ).toEqual(expect.any(Number));
  expect(
    firstState.jobs,
    "process.list mirror clause: sync replaces jobs with the agent's rows",
  ).toContainEqual(
    expect.objectContaining({
      agent_id: identity.peerId,
      job_id: sourceJob.id,
      project: "/synthetic/job-project",
    }),
  );
  const restartedControl = createControlServer({
    store,
    host: "127.0.0.1",
    port: 0,
  });
  controls.push(restartedControl);
  const restartedAddress = await restartedControl.start();
  const restartedState = (await (
    await fetch(`http://127.0.0.1:${restartedAddress.port}/api/state`, {
      headers,
    })
  ).json()) as {
    agents: Array<{ peer_id: string; jobs_synced_at: number | null }>;
    jobs: Array<{ job_id: string }>;
  };
  expect(
    restartedState.agents.find((entry) => entry.peer_id === identity.peerId)
      ?.jobs_synced_at,
    "restart clause: job freshness is not persisted",
  ).toBeNull();
  expect(restartedState.jobs.map((job) => job.job_id)).toContain(sourceJob.id);
  await restartedControl.stop();
  controls.pop();
  const state = await fetch(`http://127.0.0.1:${address.port}/api/state`, {
    headers,
  });
  expect(
    ((await state.json()) as { sessions: Array<{ session_id: string }> })
      .sessions,
  ).toContainEqual(
    expect.objectContaining({ session_id: session!.session_id }),
  );
  const sessionUrl = `http://127.0.0.1:${address.port}/api/sessions/${identity.peerId}/${session!.session_id}`;
  const liveRead = await fetch(sessionUrl, { headers });
  const liveData = (await liveRead.json()) as {
    events: unknown[];
    stale: boolean;
  };
  expect(liveData.stale).toBe(false);
  expect(liveData.events.length).toBeGreaterThan(0);

  const listJobs = jobs.list.bind(jobs);
  jobs.list = () => {
    throw new Error("synthetic process.list failure");
  };
  const jobsFailureSync = await fetch(
    `http://127.0.0.1:${address.port}/api/sync`,
    { method: "POST", headers },
  );
  expect(
    jobsFailureSync.status,
    "jobs failure must not change the sync response status",
  ).toBe(200);
  const jobsFailureResult = (await jobsFailureSync.json()) as {
    results: Array<{ peer_id: string; ok: boolean; count?: number }>;
  };
  expect(
    jobsFailureResult.results,
    "jobs failure must not change the successful session sync result",
  ).toContainEqual({ peer_id: identity.peerId, ok: true, count: 1 });
  jobs.list = listJobs;
  const jobsFailureState = (await (
    await fetch(`http://127.0.0.1:${address.port}/api/state`, { headers })
  ).json()) as {
    agents: Array<{ peer_id: string; jobs_synced_at: number | null }>;
    jobs: Array<{ job_id: string }>;
  };
  expect(
    jobsFailureState.agents.find((entry) => entry.peer_id === identity.peerId)
      ?.jobs_synced_at,
    "failed process.list call drops only its freshness mark",
  ).toBeNull();
  expect(jobsFailureState.jobs.map((job) => job.job_id)).toContain(
    sourceJob.id,
  );

  await agent.stop();
  agents.pop();
  await jobs.shutdown();
  const offline = await fetch(`http://127.0.0.1:${address.port}/api/sync`, {
    method: "POST",
    headers,
  });
  const offlineResult = (await offline.json()) as {
    results: Array<{ peer_id: string; ok: boolean }>;
  };
  expect(offlineResult.results).toContainEqual(
    expect.objectContaining({ peer_id: identity.peerId, ok: false }),
  );
  expect(store.listSessions(identity.peerId)).toContainEqual(
    expect.objectContaining({ session_id: session!.session_id }),
  );
  const staleState = await fetch(`http://127.0.0.1:${address.port}/api/state`, {
    headers,
  });
  const staleData = (await staleState.json()) as {
    agents: Array<{ peer_id: string; jobs_synced_at: number | null }>;
    jobs: Array<{ job_id: string }>;
  };
  expect(
    staleData.agents.find((entry) => entry.peer_id === identity.peerId)
      ?.jobs_synced_at,
  ).toBeNull();
  expect(staleData.jobs.map((job) => job.job_id)).toContain(sourceJob.id);
  const cachedRead = await fetch(sessionUrl, { headers });
  const cachedData = (await cachedRead.json()) as {
    events: unknown[];
    stale: boolean;
  };
  expect(cachedData.stale).toBe(true);
  expect(cachedData.events).toEqual(liveData.events);
});

it("syncs a running agent that is paired after it started", async () => {
  // The README order: start the agent, start the control plane, THEN pair. The
  // test above pairs first and only then creates the agent, which is why it
  // could not see this - a running agent read its credential file once at
  // startup and never looked again (issue #2).
  const root = await mkdtemp(join(tmpdir(), "pi-mesh-late-pair-"));
  const store = new ControlStore(join(root, "control.db"));
  stores.push(store);
  const pairing = new PairingService({
    controlId: store.controlId(),
    controlName: "test control",
  });
  const control = createControlServer({
    store,
    pairing,
    port: 0,
    host: "127.0.0.1",
  });
  controls.push(control);
  const address = await control.start();
  const port = await freePort();
  const identity = {
    peerId: "33333333-3333-4333-8333-333333333333",
    name: "late-pair-agent",
  };
  const credentialsPath = join(root, "agent-credentials.json");
  const sessionsRoot = join(root, "sessions");
  const directory = getSessionStorageDir("/synthetic/project", sessionsRoot);
  await mkdir(directory, { recursive: true });
  await copyFile(
    join(rootPath, "../../agent/test/fixtures/pi-0.85.1-session-v3.jsonl"),
    join(directory, "fixture.jsonl"),
  );

  // Started with no credential file at all.
  const agent = createAgentServer({
    port,
    host: "127.0.0.1",
    swarmKey: Buffer.from("fixture swarm key"),
    identity,
    controlCredentialsPath: credentialsPath,
    sessionsRoot,
  });
  agents.push(agent);
  await agent.start();

  const issued = pairing.issue();
  const output = { write: () => true };
  expect(
    await pair([issued.token, "--control-host", `127.0.0.1:${address.port}`], {
      stdout: output,
      stderr: output,
      identity,
      controlCredentialsPath: credentialsPath,
      agentPort: port,
    }),
  ).toBe(0);

  // No restart in between: the sync is the first request the agent sees with
  // the credential a separate process just wrote.
  const headers = { "X-Pi-Mesh-Ui": store.dashboardToken() };
  const synced = await fetch(`http://127.0.0.1:${address.port}/api/sync`, {
    method: "POST",
    headers,
  });
  const result = (await synced.json()) as {
    results: Array<{ peer_id: string; ok: boolean }>;
  };
  expect(result.results).toContainEqual({
    peer_id: identity.peerId,
    ok: true,
    count: 1,
  });
});
