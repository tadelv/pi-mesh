// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairTokenId, pairingProof } from "@pi-mesh/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  ControlStore,
  PairingService,
  createControlServer,
  dashboard,
  dashboardHtml,
} from "../src/index.js";

const servers: Array<{ stop(): Promise<void> }> = [];
const stores: ControlStore[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const store of stores.splice(0)) store.close();
});
async function setup(serverOptions: { fetch?: typeof fetch } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-mesh-control-test-"));
  const store = new ControlStore(join(root, "control.db"));
  stores.push(store);
  store.controlName("test control");
  const pairing = new PairingService({
    controlId: store.controlId(),
    controlName: "test control",
  });
  const server = createControlServer({
    store,
    pairing,
    port: 0,
    host: "127.0.0.1",
    ...serverOptions,
  });
  servers.push(server);
  const address = await server.start();
  return {
    store,
    pairing,
    server,
    base: `http://127.0.0.1:${address.port}`,
    token: store.dashboardToken(),
  };
}

describe("control server", () => {
  it("shows whether each jobs view is fresh and marks cached rows only", () => {
    expect(dashboard).toContain("Jobs — from the agent (");
    expect(dashboard).toContain("Jobs — cached, not synced from this agent");
    expect(dashboard).toContain("job.state+(jobsFresh ? '' : ' (last known)')");
    // Source-level because this project claims no browser test: there is no DOM
    // harness, so the render function cannot be called. The predicate has to
    // treat a MISSING jobs_synced_at as not-fresh - `!== null` calls it fresh
    // and renders "NaNs ago" - and that is only assertable here.
    expect(dashboard).toContain("typeof agent.jobs_synced_at === 'number'");
  });

  it("bounds session responses to the newest 200 cached entries by default", async () => {
    const { base, store, token } = await setup();
    store.upsertAgent({
      peer_id: "agent-x",
      name: "Agent X",
      host: "127.0.0.1",
      port: 1,
      credential: Buffer.alloc(32, 3).toString("base64"),
      paired_at: "now",
    });
    store.upsertEvents(
      "agent-x",
      "session-x",
      Array.from({ length: 250 }, (_, i) => ({
        entryId: `entry-${i}`,
        type: "message",
        timestamp: new Date(i * 1000).toISOString(),
        data: { index: i },
      })),
    );
    const headers = { "X-Pi-Mesh-Ui": token };
    const response = await fetch(`${base}/api/sessions/agent-x/session-x`, {
      headers,
    });
    const tail = (await response.json()) as {
      events: Array<{ entry_id: string }>;
      hasEarlier: boolean;
      total: number;
      stale: boolean;
    };
    expect(
      tail.events,
      "default response bound clause: return only the newest 200 entries",
    ).toHaveLength(200);
    expect(tail.events[0]!.entry_id).toBe("entry-50");
    expect(tail.events.at(-1)!.entry_id).toBe("entry-249");
    expect(tail).toMatchObject({ hasEarlier: true, total: 250, stale: true });

    const shorter = (await (
      await fetch(`${base}/api/sessions/agent-x/session-x?tail=50`, { headers })
    ).json()) as { events: Array<{ entry_id: string }>; hasEarlier: boolean };
    expect(shorter.events).toHaveLength(50);
    expect(shorter.events[0]!.entry_id).toBe("entry-200");
    expect(shorter.hasEarlier).toBe(true);
    expect(
      (
        await fetch(`${base}/api/sessions/agent-x/session-x?tail=1001`, {
          headers,
        })
      ).status,
    ).toBe(400);

    const earlier = (await (
      await fetch(`${base}/api/sessions/agent-x/session-x?before=entry-50`, {
        headers,
      })
    ).json()) as { events: Array<{ entry_id: string }>; hasEarlier: boolean };
    expect(earlier.events.map((event) => event.entry_id)).toEqual(
      Array.from({ length: 50 }, (_, i) => `entry-${i}`),
    );
    expect(earlier.hasEarlier).toBe(false);

    const all = (await (
      await fetch(`${base}/api/sessions/agent-x/session-x?all=1`, { headers })
    ).json()) as { events: unknown[]; hasEarlier: boolean };
    expect(all.events).toHaveLength(250);
    expect(all.hasEarlier).toBe(false);
  });

  it("keeps the default session response bounded when the cache exceeds the maximum tail", async () => {
    const { base, store, token } = await setup();
    store.upsertAgent({
      peer_id: "agent-x",
      name: "Agent X",
      host: "127.0.0.1",
      port: 1,
      credential: Buffer.alloc(32, 3).toString("base64"),
      paired_at: "now",
    });
    store.upsertEvents(
      "agent-x",
      "session-x",
      Array.from({ length: 1200 }, (_, i) => ({
        entryId: `entry-${i}`,
        type: "message",
        timestamp: new Date(i * 1000).toISOString(),
        data: { index: i },
      })),
    );
    const response = await fetch(`${base}/api/sessions/agent-x/session-x`, {
      headers: { "X-Pi-Mesh-Ui": token },
    });
    const tail = (await response.json()) as {
      events: Array<{ entry_id: string }>;
      hasEarlier: boolean;
      total: number;
    };
    expect(
      tail.events,
      "default response bound clause: return only the newest 200 even above the maximum tail",
    ).toHaveLength(200);
    expect(tail.events[0]!.entry_id).toBe("entry-1000");
    expect(tail.events.at(-1)!.entry_id).toBe("entry-1199");
    expect(tail).toMatchObject({ hasEarlier: true, total: 1200 });
  });

  it("pages backward without duplicating or dropping entries at page boundaries", async () => {
    const { base, store, token } = await setup();
    store.upsertAgent({
      peer_id: "agent-x",
      name: "Agent X",
      host: "127.0.0.1",
      port: 1,
      credential: Buffer.alloc(32, 3).toString("base64"),
      paired_at: "now",
    });
    store.upsertEvents(
      "agent-x",
      "session-x",
      Array.from({ length: 450 }, (_, i) => ({
        entryId: `entry-${i}`,
        type: "message",
        timestamp: new Date(i * 1000).toISOString(),
        data: { index: i },
      })),
    );
    const headers = { "X-Pi-Mesh-Ui": token };
    const newest = (await (
      await fetch(`${base}/api/sessions/agent-x/session-x`, { headers })
    ).json()) as { events: Array<{ entry_id: string }>; hasEarlier: boolean };
    const middle = (await (
      await fetch(`${base}/api/sessions/agent-x/session-x?before=entry-250`, {
        headers,
      })
    ).json()) as { events: Array<{ entry_id: string }>; hasEarlier: boolean };
    const oldest = (await (
      await fetch(`${base}/api/sessions/agent-x/session-x?before=entry-50`, {
        headers,
      })
    ).json()) as { events: Array<{ entry_id: string }>; hasEarlier: boolean };

    expect(newest.events).toHaveLength(200);
    expect(newest.hasEarlier).toBe(true);
    expect(middle.events).toHaveLength(200);
    expect(middle.hasEarlier).toBe(true);
    expect(oldest.events).toHaveLength(50);
    expect(oldest.hasEarlier).toBe(false);
    expect(
      [...oldest.events, ...middle.events, ...newest.events].map(
        (event) => event.entry_id,
      ),
      "page join clause: all cached entries appear exactly once in original order",
    ).toEqual(Array.from({ length: 450 }, (_, i) => `entry-${i}`));
  });

  it("requires dashboard token for API state", async () => {
    const { base, token } = await setup();
    const unauthorized = await fetch(`${base}/api/state`);
    expect(unauthorized.status, "missing token must be rejected").toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
    expect((await fetch(`${base}/api/state?token=wrong`)).status).toBe(401);
    const authorized = await fetch(`${base}/api/state`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authorized.status).toBe(200);
    expect(
      ((await authorized.json()) as { control: { name: string } }).control.name,
    ).toBe("test control");
    expect(
      (await fetch(`${base}/api/state?token=${encodeURIComponent(token)}`))
        .status,
    ).toBe(200);
  });

  it("never exposes an agent credential through the state API", async () => {
    const { base, store, token } = await setup();
    // A paired agent must actually be present, or the assertion below runs over
    // an empty list and passes whether or not the credential is leaked.
    store.upsertAgent({
      peer_id: "agent-x",
      name: "Agent X",
      host: "10.0.0.9",
      port: 7330,
      credential: Buffer.alloc(32, 3).toString("base64"),
      paired_at: new Date().toISOString(),
    });
    const response = await fetch(`${base}/api/state`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const state = (await response.json()) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0]).toMatchObject({ peer_id: "agent-x" });
    expect(Object.keys(state.agents[0]!)).not.toContain("credential");
  });

  it("persists successful pairing with the request host and announced port, but not a bad proof", async () => {
    const { base, pairing, store } = await setup();
    const agentId = "agent-1";
    const issued = pairing.issue();
    const token = Buffer.from(issued.token, "base64");
    const helloBody = {
      agent_id: agentId,
      agent_name: "Agent",
      token_id: pairTokenId(token),
      nonce: "agent-nonce",
      agent_port: 7442,
    };
    const hello = await fetch(`${base}/pair/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(helloBody),
    });
    const challenge = (await hello.json()) as { nonce: string };
    const transcript = {
      clientPeerId: agentId,
      clientNonce: helloBody.nonce,
      serverPeerId: store.controlId(),
      serverNonce: challenge.nonce,
    };
    const bad = await fetch(`${base}/pair/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        nonce: challenge.nonce,
        hmac: "bad",
      }),
    });
    expect(bad.status).toBe(401);
    expect(store.getAgent(agentId)).toBeUndefined();
    const proof = pairingProof(token, transcript, "verify");
    const verified = await fetch(`${base}/pair/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        nonce: challenge.nonce,
        hmac: proof,
      }),
    });
    expect(verified.status).toBe(200);
    expect(store.getAgent(agentId)).toMatchObject({
      name: "Agent",
      host: "127.0.0.1",
      port: 7442,
    });
  });

  it("serves a dashboard that carries no token, in the page or the URL", async () => {
    const { base, server, token } = await setup();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    // ADR 0014: the token is read with `pi-mesh-control-plane token` and pasted
    // in. It is never minted into a cookie here and never put in a URL, so
    // there is nothing for browser history or a proxy log to keep.
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(await page.text()).not.toContain(token);
    expect(server.dashboardUrl()).not.toContain(token);
    expect(server.dashboardUrl()).not.toContain("token=");
    const issue = await fetch(`${base}/api/pair/token`, {
      method: "POST",
      headers: { "X-Pi-Mesh-Ui": token },
    });
    expect(issue.status).toBe(200);
    expect(await issue.json()).toMatchObject({
      token: expect.any(String),
      token_id: expect.any(String),
      expires_at: expect.any(String),
    });
  });

  it("returns 400 for malformed JSON and 404 for unknown paths", async () => {
    const { base, token } = await setup();
    const malformed = await fetch(`${base}/pair/hello`, {
      method: "POST",
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const oversized = await fetch(`${base}/pair/hello`, {
      method: "POST",
      body: JSON.stringify({ payload: "x".repeat(65 * 1024) }),
    });
    expect(oversized.status).toBe(400);
    const unknown = await fetch(`${base}/missing`);
    expect(unknown.status).toBe(404);
    const unknownAgent = await fetch(`${base}/api/sessions/missing/session`, {
      headers: { "X-Pi-Mesh-Ui": token },
    });
    expect(unknownAgent.status).toBe(404);
  });

  it("re-reads the dashboard markup on every request", async () => {
    // The dev server points dashboardHtml at src/dashboard.html so that editing
    // the page is a browser refresh, no rebuild. A server that read the markup
    // once at start would return the first body twice and fail this clause.
    let revision = "first-revision";
    const { base } = await setup({ dashboardHtml: () => revision });
    expect(
      await (await fetch(`${base}/`)).text(),
      "per-request read clause: GET / returns the markup as of this request",
    ).toBe("first-revision");
    revision = "second-revision";
    expect(await (await fetch(`${base}/`)).text()).toBe("second-revision");
  });

  it("serves the on-disk dashboard markup by default", async () => {
    // The build copies src/dashboard.html to dist/, and the default read finds
    // it beside the compiled module. This pins the copy step: delete the file
    // and the page 500s instead of silently serving something else.
    const { base } = await setup();
    expect(await (await fetch(`${base}/`)).text()).toBe(dashboardHtml());
  });
});
