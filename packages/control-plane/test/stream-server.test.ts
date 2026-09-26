// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { JobManager, type JobReporter } from "../../agent/src/jobs.js";
import { createAgentServer } from "../../agent/src/server.js";
import { getSessionStorageDir } from "../../agent/src/sessions.js";
import { parseSpawnPolicy } from "../../agent/src/spawn-policy.js";
import {
  ControlStore,
  createControlServer,
  type ControlServer,
} from "../src/index.js";

const agentId = "22222222-2222-4222-8222-222222222222";
const controlId = "33333333-3333-4333-8333-333333333333";
const token = "dashboard-token";
const credential = Buffer.alloc(32, 7).toString("base64");
const sessionId = "123e4567-e89b-42d3-a456-426614174099";

const resources: Array<{ stop(): Promise<void>; close?(): void }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    if (resource.close !== undefined) resource.close();
    else await resource.stop();
  }
});

/** A job that stays running and can be made to emit live RPC events on demand. */
function jobFixture() {
  let sequence = 0;
  const reports: JobReporter[] = [];
  const manager = new JobManager({
    spawnJob: (_spec, report) => {
      sequence += 1;
      queueMicrotask(() => report.session(sessionId));
      reports.push(report);
      return {
        pid: 100 + sequence,
        argv: [],
        stdioClosed: false,
        ready: Promise.resolve(),
        command: async () => ({ success: true }),
        close: async () => report.exited({ code: 0, signal: null }),
      };
    },
  });
  return {
    manager,
    reports,
    async start(project = "live") {
      const record = await manager.startReady({
        peerId: controlId,
        project,
        cwd: process.cwd(),
        name: project,
      });
      manager.acknowledge(record.id);
      return record;
    },
    emit(delta: string): void {
      reports.at(-1)?.event?.({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta },
      });
    },
  };
}

async function setup() {
  const store = new ControlStore(":memory:");
  store.setMeta("control_id", controlId);
  store.setMeta("dashboard_token", token);
  let streamOpens = 0;
  const countingFetch: typeof globalThis.fetch = async (input, init) => {
    if (
      typeof init?.body === "string" &&
      init.body.includes('"message/stream"')
    )
      streamOpens += 1;
    return globalThis.fetch(input, init);
  };
  const control = createControlServer({
    store,
    host: "127.0.0.1",
    port: 0,
    fetch: countingFetch,
  });
  const controlAddress = await control.start();
  const jobs = jobFixture();
  const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-mesh-stream-"));
  const agent = createAgentServer({
    host: "127.0.0.1",
    port: 0,
    swarmKey: Buffer.from("fixture swarm key"),
    identity: { peerId: agentId, name: "test agent" },
    controlCredentials: [{ controlId, credential, pairedAt: "now" }],
    jobs: jobs.manager,
    sessionsRoot,
    spawnPolicy: parseSpawnPolicy("*", ""),
  });
  const agentAddress = await agent.start();
  store.upsertAgent({
    peer_id: agentId,
    name: "agent",
    host: "127.0.0.1",
    port: agentAddress.port,
    credential,
    paired_at: "now",
  });
  resources.push(
    { stop: async () => agent.stop() },
    { stop: async () => jobs.manager.shutdown() },
    control as ControlServer,
    { stop: async () => undefined, close: () => store.close() },
  );
  return {
    store,
    control,
    jobs,
    agent,
    sessionsRoot,
    base: `http://127.0.0.1:${controlAddress.port}`,
    opens: () => streamOpens,
  };
}

function streamUrl(base: string): string {
  return `${base}/api/sessions/${encodeURIComponent(agentId)}/${encodeURIComponent(sessionId)}/stream`;
}

async function sync(base: string): Promise<void> {
  const response = await fetch(`${base}/api/sync`, {
    method: "POST",
    headers: { "X-Pi-Mesh-Ui": token, "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(200);
}

async function openStream(base: string): Promise<Response> {
  return fetch(streamUrl(base), {
    headers: { "X-Pi-Mesh-Ui": token },
    signal: AbortSignal.timeout(10_000),
  });
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** The text a live `message_update` frame carried. */
function deltaOf(item: SseEvent): unknown {
  return (
    item.data as { assistantMessageEvent?: { delta?: unknown } } | undefined
  )?.assistantMessageEvent?.delta;
}

function parse(record: string): SseEvent | undefined {
  const event = record
    .split("\n")
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();
  const data = record
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (event === undefined || data.length === 0) return undefined;
  return { event, data: JSON.parse(data) as unknown };
}

async function readEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: { count?: number; timeoutMs?: number } = {},
): Promise<SseEvent[]> {
  const decoder = new TextDecoder();
  let buffer = "";
  const out: SseEvent[] = [];
  const deadline = Date.now() + (options.timeoutMs ?? 3_000);
  while (Date.now() < deadline) {
    if (options.count !== undefined && out.length >= options.count) break;
    const read = await reader.read();
    if (read.done) break;
    buffer += decoder.decode(read.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const item = parse(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (item !== undefined) out.push(item);
      boundary = buffer.indexOf("\n\n");
    }
  }
  return out;
}

/**
 * Read until the stream ends or the deadline passes, tolerating a socket that
 * was cut rather than flushed. Returns whether the stream actually closed.
 */
async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 3_000,
): Promise<{ events: SseEvent[]; closed: boolean }> {
  const decoder = new TextDecoder();
  let buffer = "";
  const events: SseEvent[] = [];
  let closed = false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const read = await reader.read().catch(() => undefined);
    if (read === undefined) {
      closed = true;
      break;
    }
    if (read.done) {
      closed = true;
      break;
    }
    buffer += decoder.decode(read.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const item = parse(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (item !== undefined) events.push(item);
      boundary = buffer.indexOf("\n\n");
    }
  }
  return { events, closed };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not happen within 3s`);
}

async function writeDurableSession(sessionsRoot: string): Promise<void> {
  const directory = getSessionStorageDir("/fixture/project", sessionsRoot);
  await mkdir(directory, { recursive: true });
  const rows = [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2025-01-01T00:00:00.000Z",
      cwd: "/fixture/project",
    },
    {
      type: "message",
      id: "file-entry-1",
      parentId: null,
      timestamp: "2025-01-01T00:00:01.000Z",
      message: { role: "user", content: "first" },
    },
  ];
  await writeFile(
    join(directory, "session.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

it("streams live frames to an authenticated header request, and refuses without a token", async () => {
  const { base, jobs, opens } = await setup();
  await jobs.start();
  await sync(base);

  const unauthorized = await fetch(streamUrl(base));
  expect(unauthorized.status, "no X-Pi-Mesh-Ui header").toBe(401);

  const response = await openStream(base);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
  // The token travelled in a header; the request line carries no token.
  expect(streamUrl(base)).not.toContain("token");
  const reader = response.body!.getReader();
  jobs.emit("first");
  jobs.emit("second");
  const frames = (await readEvents(reader, { count: 2 })).filter(
    (item) => item.event === "live",
  );
  expect(
    frames.map(deltaOf),
    "missing observation: two live deltas reached the browser",
  ).toEqual(["first", "second"]);
  expect(
    frames.every(
      (frame) => (frame.data as { source?: string }).source === "live",
    ),
    "the source discriminator survives the control-plane hop",
  ).toBe(true);
  expect(opens()).toBe(1);
  await reader.cancel();
});

it("refuses two running jobs claiming one session, and opens no upstream", async () => {
  const { base, jobs, opens } = await setup();
  await jobs.start();
  await jobs.start();
  // Both jobs report the same session id, which is exactly the ambiguity.
  await sync(base);
  const response = await openStream(base);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: "ambiguous_session",
    message: expect.any(String),
  });
  expect(
    opens(),
    "an ambiguous session must not open an upstream to guess",
  ).toBe(0);
});

it("refuses a session with no running job", async () => {
  const { base, opens } = await setup();
  await sync(base);
  const response = await openStream(base);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "no_running_job" });
  expect(opens()).toBe(0);
});

it("refuses a session whose jobs listing is not confirmed", async () => {
  const { base, jobs, opens } = await setup();
  await jobs.start();
  // Deliberately no sync: the cached row is not the agent's listing.
  const response = await openStream(base);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "jobs_unconfirmed" });
  expect(opens()).toBe(0);
});

it("refuses a stream with a stated reason when the agent is unreachable", async () => {
  const { base, jobs, agent } = await setup();
  await jobs.start();
  await sync(base);
  await agent.stop();
  const response = await openStream(base);
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({
    error: "stream_unavailable",
    message: expect.any(String),
  });
});

it("downgrades a file-sourced first frame with no duplicated entries", async () => {
  const { base, jobs, sessionsRoot } = await setup();
  const record = await jobs.start();
  // Confirm the job while it is running, then stop it on the agent WITHOUT
  // syncing: the mirror still claims a running job, which is the race this
  // clause exists for. The agent answers with the durable file instead.
  await sync(base);
  await jobs.manager.stop(record.id);
  await writeDurableSession(sessionsRoot);
  const response = await openStream(base);
  expect(response.status).toBe(200);
  const events = await readEvents(response.body!.getReader());
  expect(
    events.map((item) => item.event),
    "missing observation: the browser is told the session is not live here",
  ).toContain("not-live");
  expect(
    events.filter((item) => item.event === "live"),
    "replayed file entries must never be presented as a live overlay",
  ).toEqual([]);
});

it("shares one upstream across two subscribers and reopens after the last leaves", async () => {
  const { base, jobs, opens } = await setup();
  await jobs.start();
  await sync(base);

  const first = await openStream(base);
  const firstReader = first.body!.getReader();
  const second = await openStream(base);
  const secondReader = second.body!.getReader();
  await waitFor(() => opens() === 1, "the shared upstream opened");
  jobs.emit("shared");
  expect(
    deltaOf((await readEvents(firstReader, { count: 1 }))[0]!),
    "the first subscriber sees the shared frame",
  ).toBe("shared");
  expect(
    deltaOf((await readEvents(secondReader, { count: 1 }))[0]!),
    "the second subscriber sees the same upstream's frame",
  ).toBe("shared");
  expect(opens(), "two subscribers must share one upstream, not open two").toBe(
    1,
  );

  await firstReader.cancel();
  await secondReader.cancel();
  // The last unsubscribe drops the upstream, so a later request opens a fresh
  // one. If the upstream were not dropped, every probe would join the still-open
  // connection and the open count would stay at one.
  let reopened = false;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && !reopened) {
    const probe = await openStream(base);
    await probe.body!.getReader().cancel();
    reopened = opens() >= 2;
    if (!reopened) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(
    reopened,
    "missing observation: the last unsubscribe closed the upstream",
  ).toBe(true);
});

it("closes the live view when the control plane shuts down", async () => {
  const { base, jobs, control } = await setup();
  await jobs.start();
  await sync(base);
  const response = await openStream(base);
  const reader = response.body!.getReader();
  jobs.emit("before-shutdown");
  await readEvents(reader, { count: 1 });
  await control.stop();
  const { events, closed } = await drain(reader);
  expect(
    closed || events.some((item) => item.event === "end"),
    "missing observation: no upstream survives a shutdown",
  ).toBe(true);
});

it("closes one agent's live views when it is unpaired", async () => {
  const { base, jobs, control } = await setup();
  await jobs.start();
  await sync(base);
  const response = await openStream(base);
  const reader = response.body!.getReader();
  jobs.emit("before-unpair");
  await readEvents(reader, { count: 1 });
  control.closeAgentStreams(agentId);
  const { events, closed } = await drain(reader);
  expect(
    closed && events.some((item) => item.event === "end"),
    "missing observation: unpairing closed the upstream cleanly",
  ).toBe(true);
});
