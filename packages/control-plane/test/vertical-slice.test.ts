// SPDX-License-Identifier: GPL-3.0-or-later

import { copyFile, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { getSessionStorageDir } from "../../agent/src/sessions.js";
import { pair } from "../../agent/src/pair.js";
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
  const agent = createAgentServer({
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

  await agent.stop();
  agents.pop();
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
