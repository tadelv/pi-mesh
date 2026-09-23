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
} from "../src/index.js";

const servers: Array<{ stop(): Promise<void> }> = [];
const stores: ControlStore[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const store of stores.splice(0)) store.close();
});
async function setup(
  serverOptions: { typesafeApiKey?: string; fetch?: typeof fetch } = {},
) {
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
      intent_enabled: boolean;
    };
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0]).toMatchObject({ peer_id: "agent-x" });
    expect(Object.keys(state.agents[0]!)).not.toContain("credential");
    expect(state.intent_enabled).toBe(false);
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

  it("routes intent only when enabled, authenticated, and available", async () => {
    const disabled = await setup({ typesafeApiKey: "" });
    const disabledResponse = await fetch(`${disabled.base}/api/intent`, {
      method: "POST",
      headers: { authorization: `Bearer ${disabled.token}` },
      body: JSON.stringify({ text: "show sessions" }),
    });
    expect(disabledResponse.status).toBe(501);
    expect(await disabledResponse.json()).toEqual({ error: "intent_disabled" });

    const answer = {
      answers: {
        action: {
          type: "choice",
          choice: "show_devices",
          probabilities: { show_devices: 0.9, none: 0.1 },
          confidence: 0.9,
        },
      },
    };
    const enabled = await setup({
      typesafeApiKey: "typesafe-secret",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        expect(url).toBe("https://api.typesafe.ai/v1/systemone");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer typesafe-secret",
        );
        return new Response(JSON.stringify(answer), { status: 200 });
      }) as typeof fetch,
    });
    const headers = {
      authorization: `Bearer ${enabled.token}`,
      "content-type": "application/json",
    };
    const success = await fetch(`${enabled.base}/api/intent`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "show paired machines" }),
    });
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ action: "show_devices" });
    const empty = await fetch(`${enabled.base}/api/intent`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: " " }),
    });
    expect(empty.status).toBe(400);
    expect(
      (
        await fetch(`${enabled.base}/api/intent`, {
          method: "POST",
          body: JSON.stringify({ text: "show devices" }),
        })
      ).status,
    ).toBe(401);

    const unavailable = await setup({
      typesafeApiKey: "typesafe-secret",
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    const failed = await fetch(`${unavailable.base}/api/intent`, {
      method: "POST",
      headers: { authorization: `Bearer ${unavailable.token}` },
      body: JSON.stringify({ text: "show devices" }),
    });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "intent_unavailable" });
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
});
