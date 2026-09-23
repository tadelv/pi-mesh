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

/**
 * A control plane whose notion of "confidential" the test can flip, standing in
 * for the one thing a loopback test server cannot produce: a caller that reached
 * it across the LAN in the clear.
 */
async function setup(
  options: { allowInsecureExecution?: boolean; realDetection?: boolean } = {},
) {
  let confidential = true;
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
  const calls: string[] = [];
  const control = createControlServer({
    store,
    host: "127.0.0.1",
    port: 0,
    // realDetection omits the injection, so the default socket-derived check is
    // the thing under test rather than a scripted classification.
    ...(options.realDetection ? {} : { confidential: () => confidential }),
    ...(options.allowInsecureExecution === undefined
      ? {}
      : { allowInsecureExecution: options.allowInsecureExecution }),
    fetch: async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      calls.push(request.id);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            message: {
              parts: [
                {
                  data: {
                    result: {
                      job_id: "job-1",
                      session_id: "session-1",
                      pid: 41,
                    },
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  resources.push(control);
  const address = await control.start();
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "content-type": "application/json", "X-Pi-Mesh-Ui": token };
  return {
    store,
    base,
    headers,
    calls,
    /** Model the operator's request, then the same bytes replayed from the LAN. */
    setConfidential: (value: boolean) => {
      confidential = value;
    },
  };
}

const bodies: Record<string, unknown> = {
  spawn: { project: "p", prompt: "hi" },
  steer: { job_id: "job-1", message: "hi" },
  stop: { job_id: "job-1" },
  abort: { job_id: "job-1" },
};

it("refuses all four execution routes from a non-confidential request, reaching no agent", async () => {
  const { base, headers, calls, setConfidential } = await setup();
  setConfidential(false);
  for (const action of ["spawn", "steer", "stop", "abort"]) {
    const response = await fetch(`${base}/api/agents/${agentId}/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(bodies[action]),
    });
    expect(
      response.status,
      `${action} must require a confidential request`,
    ).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "confidential_transport_required",
    });
  }
  // The clause the 403 exists for: nothing was forwarded, so a captured request
  // cannot be the seed of an execution.
  expect(calls).toEqual([]);
});

it("refuses a captured request replayed from a plaintext path", async () => {
  // Capture a request that legitimately succeeded over a confidential channel.
  const { base, headers, calls, setConfidential } = await setup();
  const request = {
    method: "POST",
    headers,
    body: JSON.stringify(bodies.spawn),
  };
  const url = `${base}/api/agents/${agentId}/spawn`;
  expect((await fetch(url, request)).status).toBe(200);
  expect(calls).toHaveLength(1);

  // The same bytes, replayed by an observer who cannot make it confidential.
  // Nothing about the request changed; only where it came from did.
  setConfidential(false);
  expect((await fetch(url, request)).status).toBe(403);
  expect(calls).toHaveLength(1);
});

it("serves execution when the deliberate override is set, and reports it", async () => {
  const { base, headers, calls, setConfidential } = await setup({
    allowInsecureExecution: true,
  });
  setConfidential(false);
  const response = await fetch(`${base}/api/agents/${agentId}/spawn`, {
    method: "POST",
    headers,
    body: JSON.stringify(bodies.spawn),
  });
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(1);
  const state = (await (
    await fetch(`${base}/api/state`, { headers })
  ).json()) as {
    execution_transport: string;
  };
  expect(state.execution_transport).toBe("insecure_override");
});

it("keeps reading available over a plaintext request", async () => {
  // The split is deliberate (ADR 0014 decision 4): reading over a plaintext LAN
  // is the accepted v1 cost, execution is not. If this ever 403s, the fix over-
  // reached and the dashboard stops working entirely on a plaintext LAN.
  const { base, headers, setConfidential } = await setup();
  setConfidential(false);
  const response = await fetch(`${base}/api/state`, { headers });
  expect(response.status).toBe(200);
  const state = (await response.json()) as { execution_transport: string };
  expect(state.execution_transport).toBe("refused");
});

it("treats a real loopback request as confidential without configuration", async () => {
  // The default detection, not the injected one: the tests in execution.test.ts
  // depend on this, and a TLS-terminating proxy on this host looks the same.
  const { base, headers, calls } = await setup({ realDetection: true });
  const state = (await (
    await fetch(`${base}/api/state`, { headers })
  ).json()) as {
    execution_transport: string;
  };
  expect(state.execution_transport).toBe("confidential");
  const response = await fetch(`${base}/api/agents/${agentId}/spawn`, {
    method: "POST",
    headers,
    body: JSON.stringify(bodies.spawn),
  });
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(1);
});
