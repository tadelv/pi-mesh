// SPDX-License-Identifier: GPL-3.0-or-later

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ControlStore, createControlServer } from "../src/index.js";

const agentId = "watch-coalesce-agent";
const controlId = "44444444-4444-4444-8444-444444444444";
const token = "dashboard-token";
const credential = Buffer.alloc(32, 9).toString("base64");
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
  pushers: Array<(frame: unknown) => void>;
}

async function startStub(): Promise<Stub> {
  const stub: Stub = {
    server: undefined as unknown as Server,
    port: 0,
    sessions: [],
    pushers: [],
  };
  stub.server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/agent-card.json"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name: "stub",
          skills: ["mesh.watch", "session.list", "process.list"].map((id) => ({
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
        reply({ sessions: stub.sessions });
        return;
      }
      if (rpc.method === "message/send" && skill === "process.list") {
        reply({ jobs: [] });
        return;
      }
      if (rpc.method === "message/stream" && skill === "mesh.watch") {
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

async function setup() {
  const stub = await startStub();
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

/** Continuously collect SSE events from the browser delivery endpoint. */
function collectEvents(
  body: ReadableStream<Uint8Array>,
  into: Array<{ name: string; data: unknown }>,
  stop: AbortSignal,
): void {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  stop.addEventListener("abort", () => {
    reader.cancel().catch(() => undefined);
  });
  void (async () => {
    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) return;
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
          if (name && data) {
            try {
              into.push({ name, data: JSON.parse(data) as unknown });
            } catch {
              into.push({ name, data });
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Aborted with the stream; the collected events are the assertion.
    }
  })();
}

function watchEvents(
  collected: Array<{ name: string; data: unknown }>,
): Array<Record<string, unknown>> {
  return collected
    .filter((event) => event.name === "watch")
    .map((event) => event.data as Record<string, unknown>);
}

describe("watch broadcast coalescing", () => {
  it("emits one event for several frames inside the window, and flushes again after it", async () => {
    const { stub, base, headers } = await setup();
    const synced = await fetch(`${base}/api/sync`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(synced.status).toBe(200);
    await waitFor("subscription", () => stub.pushers.length >= 1);
    // Let the subscribe-time live mark flush through before the burst, so the
    // count below can only be satisfied by the pushed frames.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const watchAbort = new AbortController();
    const stream = await fetch(`${base}/api/watch/stream`, {
      headers,
      signal: watchAbort.signal,
    });
    expect(stream.status).toBe(200);
    const collected: Array<{ name: string; data: unknown }> = [];
    collectEvents(stream.body!, collected, watchAbort.signal);
    try {
      // Five frames in one tick: session writes arriving faster than the
      // broadcast window.
      for (let i = 0; i < 5; i += 1) {
        stub.sessions.push({
          id: `burst-${i}`,
          project: "/p",
          name: `Burst ${i}`,
          started_at: timestamp,
          updated_at: timestamp,
        });
        for (const push of [...stub.pushers]) {
          push({
            type: "added",
            session: stub.sessions[stub.sessions.length - 1],
          });
        }
      }
      await waitFor(
        "coalesced broadcast",
        () => watchEvents(collected).length >= 1,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(
        watchEvents(collected).length,
        "coalescing clause: five frames inside one window cost one browser event",
      ).toBe(1);
      expect(
        watchEvents(collected)[0]?.agent_ids,
        "coalescing clause: the single event names the changed agent",
      ).toContain(agentId);
      // A frame after the window must flush again rather than join the past.
      stub.sessions.push({
        id: "burst-late",
        project: "/p",
        name: "Burst late",
        started_at: timestamp,
        updated_at: timestamp,
      });
      for (const push of [...stub.pushers]) {
        push({
          type: "added",
          session: stub.sessions[stub.sessions.length - 1],
        });
      }
      await waitFor("second flush", () => watchEvents(collected).length >= 2);
      expect(
        watchEvents(collected).length,
        "window clause: a later frame flushes a second event",
      ).toBe(2);
    } finally {
      watchAbort.abort();
    }
  });
});
