// SPDX-License-Identifier: GPL-3.0-or-later

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ControlStore, createControlServer } from "../src/index.js";

const agentId = "watch-server-agent";
const controlId = "33333333-3333-4333-8333-333333333333";
const token = "dashboard-token";
const credential = Buffer.alloc(32, 7).toString("base64");
const timestamp = "2026-01-01T00:00:00.000Z";

interface Stub {
  server: Server;
  port: number;
  sessions: Array<{
    id: string;
    project: string;
    name?: string;
    started_at: string;
    updated_at: string;
  }>;
  counts: { card: number; sessionList: number; streams: number };
  /** Currently open watch SSE responses, server-side. */
  openStreams: number;
  pushers: Array<(frame: unknown) => void>;
}

async function startStub(skills: string[]): Promise<Stub> {
  const stub: Stub = {
    server: undefined as unknown as Server,
    port: 0,
    sessions: [],
    counts: { card: 0, sessionList: 0, streams: 0 },
    openStreams: 0,
    pushers: [],
  };
  stub.server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/agent-card.json"
    ) {
      stub.counts.card += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name: "stub",
          skills: skills.map((id) => ({
            id,
            name: id,
            description: "",
            tags: [],
          })),
        }),
      );
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/") {
      response.writeHead(404);
      response.end("unknown");
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const rpc = JSON.parse(body) as {
        id: unknown;
        method: string;
        params?: { message?: { parts?: Array<{ data?: { skill?: string } }> } };
      };
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
      const skill = rpc.params?.message?.parts?.[0]?.data?.skill;
      if (rpc.method === "message/send" && skill === "session.list") {
        stub.counts.sessionList += 1;
        reply({ sessions: stub.sessions });
        return;
      }
      if (rpc.method === "message/send" && skill === "process.list") {
        reply({ jobs: [] });
        return;
      }
      if (rpc.method === "message/stream" && skill === "mesh.watch") {
        stub.counts.streams += 1;
        stub.openStreams += 1;
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const send = (payload: unknown): void => {
          if (!response.destroyed)
            response.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        send({ task: { id: "watch-task" } });
        const push = (frame: unknown): void =>
          send({ message: { parts: [{ data: { result: frame } }] } });
        push({ type: "snapshot", sessions: stub.sessions, jobs: [] });
        stub.pushers.push(push);
        response.once("close", () => {
          stub.openStreams -= 1;
          const index = stub.pushers.indexOf(push);
          if (index !== -1) stub.pushers.splice(index, 1);
        });
        return;
      }
      reply({});
    });
  });
  await new Promise<void>((resolve) =>
    stub.server.listen(0, "127.0.0.1", resolve),
  );
  stub.port = (stub.server.address() as { port: number }).port;
  return stub;
}

const resources: Array<{ stop(): Promise<void>; close?(): void }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    if (resource.close !== undefined) resource.close();
    else await resource.stop();
  }
});

async function setup(skills = ["mesh.watch", "session.list", "process.list"]) {
  const stub = await startStub(skills);
  const store = new ControlStore(":memory:");
  resources.push({
    stop: async () =>
      new Promise<void>((resolve) => stub.server.close(() => resolve())),
    close: () => store.close(),
  });
  store.setMeta("control_id", controlId);
  store.setMeta("dashboard_token", token);
  store.upsertAgent({
    peer_id: agentId,
    name: "stub",
    host: "127.0.0.1",
    port: stub.port,
    credential,
    paired_at: timestamp,
  });
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  resources.push(control);
  const address = await control.start();
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "X-Pi-Mesh-Ui": token, "content-type": "application/json" };
  return { stub, store, control, base, headers };
}

async function stateOf(base: string, headers: Record<string, string>) {
  const response = await fetch(`${base}/api/state`, { headers });
  return (await response.json()) as {
    agents: Array<{ peer_id: string; watch: string }>;
    sessions: Array<{ session_id: string }>;
  };
}

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not happen within 5s`);
}

/** Read SSE events from the browser delivery endpoint until one matches. */
async function nextWatchEvent(
  body: ReadableStream<Uint8Array>,
  want: string,
): Promise<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("no watch event arrived");
    const read = await reader.read();
    if (read.done) throw new Error("watch stream ended before any event");
    buffer += decoder.decode(read.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const record = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const name = (
        record.split("\n").find((line) => line.startsWith("event:")) ?? ""
      )
        .slice(6)
        .trim();
      const data = record
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (name === want && data) {
        await reader.cancel();
        return JSON.parse(data) as Record<string, unknown>;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

describe("watch server integration", () => {
  it("subscribes on advertisement and delivers pushed frames to browsers", async () => {
    const { stub, base, headers } = await setup();
    const synced = await fetch(`${base}/api/sync`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(synced.status).toBe(200);
    await waitFor("subscription", () => stub.counts.streams === 1);
    expect(
      (await stateOf(base, headers)).agents[0]?.watch,
      "advertisement clause: the state reports the held subscription",
    ).toBe("live");
    stub.sessions.push({
      id: "streamed-1",
      project: "/p",
      name: "Streamed",
      started_at: timestamp,
      updated_at: timestamp,
    });
    for (const push of [...stub.pushers]) {
      push({
        type: "added",
        session: stub.sessions[stub.sessions.length - 1],
      });
    }
    // The browser endpoint is opened BEFORE the next push, like a dashboard
    // that connected at page load and waits for inventory.
    const watchAbort = new AbortController();
    const stream = await fetch(`${base}/api/watch/stream`, {
      headers,
      signal: watchAbort.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    stub.sessions.push({
      id: "streamed-2",
      project: "/p",
      name: "Streamed two",
      started_at: timestamp,
      updated_at: timestamp,
    });
    for (const push of [...stub.pushers]) {
      push({
        type: "added",
        session: stub.sessions[stub.sessions.length - 1],
      });
    }
    const event = await nextWatchEvent(stream.body!, "watch");
    expect(event).toMatchObject({ agent_id: agentId });
    // Tear down the browser stream before the servers go away: a cancelled
    // reader alone leaves the socket for shutdown to destroy mid-read.
    watchAbort.abort();
    await waitFor("mirror", async () => {
      const state = await stateOf(base, headers);
      return (
        state.sessions.some((row) => row.session_id === "streamed-2") &&
        state.sessions.some((row) => row.session_id === "streamed-1")
      );
    });
    // Both pushed rows arrive through the subscription: the manual sync ran
    // once, before either push, and is never called again here.
    expect(stub.counts.sessionList).toBe(1);
  });

  it("closes the subscription on unpair without reconnecting", async () => {
    const { stub, store, base, headers } = await setup();
    await fetch(`${base}/api/sync`, { method: "POST", headers, body: "{}" });
    await waitFor("subscription", () => stub.counts.streams === 1);
    await waitFor("stream established", () => stub.openStreams === 1);
    // The real removal path: deleting the agent row must take the held stream
    // with it, and the explicit close must not schedule a reconnect.
    store.removeAgent(agentId);
    await waitFor("unpair close", () => stub.openStreams === 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      stub.counts.streams,
      "unpair clause: an explicit close never reconnects",
    ).toBe(1);
    expect(
      (await stateOf(base, headers)).agents,
      "unpair clause: the agent row is gone",
    ).toEqual([]);
  });

  it("closes every subscription on shutdown", async () => {
    const { stub, control, base, headers } = await setup();
    await fetch(`${base}/api/sync`, { method: "POST", headers, body: "{}" });
    await waitFor("subscription", () => stub.counts.streams === 1);
    await waitFor("stream established", () => stub.openStreams === 1);
    await control.stop();
    resources.splice(resources.indexOf(control), 1);
    await waitFor("shutdown close", () => stub.openStreams === 0);
  });

  it("reports off and opens nothing without the advertisement", async () => {
    const { stub, base, headers } = await setup(["session.list"]);
    await fetch(`${base}/api/sync`, { method: "POST", headers, body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      stub.counts.streams,
      "capability clause: no stream opens without the advertisement",
    ).toBe(0);
    expect(
      (await stateOf(base, headers)).agents[0]?.watch,
      "capability clause: the agent reads off, not stale",
    ).toBe("off");
  });
});
