// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, expect, it } from "vitest";
import { PI_MESH_HEADERS } from "@pi-mesh/protocol";
import { ControlStore, createControlServer } from "../src/index.js";
import { agentControls } from "../src/controls.js";

const agentId = "22222222-2222-4222-8222-222222222222";
const controlId = "33333333-3333-4333-8333-333333333333";
const models = [
  { id: "model-a", provider: "provider-a", name: "Model A" },
  { id: "model-b", provider: "provider-b", name: "Model B", reasoning: true },
];
const commands = [
  { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
];
const status = {
  model: { id: "model-a", provider: "provider-a", name: "Model A" },
  thinkingLevel: "high",
  tokens: { input: 100, output: 20, total: 120 },
  cost: 0.5,
  contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
};
const resources: Array<{ stop(): Promise<void>; close(): void }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    await resource.stop();
    resource.close();
  }
});

async function setup(
  options: {
    confidential?: boolean;
    allowInsecureExecution?: boolean;
    response?: (skill: string, input: unknown) => unknown;
  } = {},
) {
  const store = new ControlStore(":memory:");
  store.setMeta("control_id", controlId);
  store.setMeta("dashboard_token", "dashboard-token");
  store.upsertAgent({
    peer_id: agentId,
    name: "agent",
    host: "agent.test",
    port: 7330,
    credential: Buffer.alloc(32, 7).toString("base64"),
    paired_at: "now",
  });
  const requests: Array<{ skill: string; input: unknown }> = [];
  const control = createControlServer({
    store,
    host: "127.0.0.1",
    port: 0,
    ...(options.allowInsecureExecution ? { allowInsecureExecution: true } : {}),
    ...(options.confidential === undefined
      ? {}
      : { confidential: () => options.confidential! }),
    fetch: async (url, init) => {
      // Refuse the parts of the wire shape this stub claims to protect. A stub
      // that answers any request hides a wire-format bug forever (AGENTS.md),
      // and a throw here surfaces as agent_unreachable, so a violation fails a
      // test rather than being silently accepted.
      if (init?.method !== "POST")
        throw new Error("stub refused a non-POST request");
      const endpoint = new URL(String(url));
      if (endpoint.pathname !== "/")
        throw new Error(
          `stub refused an unexpected A2A path ${endpoint.pathname}`,
        );
      const wire = (init.headers ?? {}) as Record<string, string>;
      if (wire["A2A-Version"] !== "1.0")
        throw new Error("stub refused a request without A2A-Version 1.0");
      for (const name of [
        PI_MESH_HEADERS.peer,
        PI_MESH_HEADERS.nonce,
        PI_MESH_HEADERS.timestamp,
        PI_MESH_HEADERS.signature,
      ]) {
        if (typeof wire[name] !== "string" || wire[name].length === 0)
          throw new Error(`stub refused a request without ${name}`);
      }
      const request = JSON.parse(String(init.body)) as {
        id: string;
        jsonrpc?: string;
        method?: string;
        params?: {
          message?: {
            role?: string;
            parts?: Array<{ data?: { skill?: string; input?: unknown } }>;
          };
        };
      };
      if (request.jsonrpc !== "2.0" || request.method !== "message/send")
        throw new Error("stub refused an unexpected JSON-RPC method");
      if (request.params?.message?.role !== "ROLE_USER")
        throw new Error("stub refused an unexpected message role");
      const data = request.params?.message?.parts?.[0]?.data;
      if (!data || typeof data.skill !== "string" || !("input" in data))
        throw new Error("stub refused unexpected A2A request shape");
      requests.push({ skill: data.skill, input: data.input });
      const response = options.response?.(data.skill, data.input);
      if (response instanceof Error) throw response;
      if (
        typeof response === "object" &&
        response !== null &&
        "rpcError" in response
      ) {
        const error = (
          response as { rpcError: { code: number; message: string } }
        ).rpcError;
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, error }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { message: { parts: [{ data: { result: response } }] } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  resources.push({ stop: () => control.stop(), close: () => store.close() });
  const { port } = await control.start();
  const headers = {
    "X-Pi-Mesh-Ui": "dashboard-token",
    "content-type": "application/json",
  };
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers,
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return { store, requests, get, post };
}

it("advertises model controls only for their exact agent skills", () => {
  expect(agentControls(["session.models", "session.set_model"])).toEqual({
    spawn: false,
    steer: false,
    stop: false,
    abort: false,
    resume: false,
    models: true,
    setModel: true,
    commands: false,
    status: false,
    stream: false,
  });
  expect(agentControls(["session.commands"])).toMatchObject({
    commands: true,
    models: false,
  });
  expect(agentControls([])).toMatchObject({ models: false, setModel: false });
  expect(agentControls(null)).toMatchObject({ models: false, setModel: false });
});

it("models read returns the exact catalog and forwards the explicit job_id", async () => {
  const fixture = await setup({
    response: (skill, input) => {
      expect(skill, "models route calls session.models").toBe("session.models");
      expect(input, "models route forwards job_id").toEqual({
        job_id: "job-7",
      });
      return { models };
    },
  });
  const result = await fixture.get(
    `/api/agents/${agentId}/models?job_id=job-7`,
  );
  expect(
    fixture.requests,
    "models dispatch preserves session.models and job_id",
  ).toEqual([{ skill: "session.models", input: { job_id: "job-7" } }]);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ models });
});

it("models without a job sends an empty input", async () => {
  const fixture = await setup({
    response: (skill, input) => {
      expect(skill).toBe("session.models");
      expect(input, "pre-spawn models request is empty").toEqual({});
      return { models };
    },
  });
  const result = await fixture.get(`/api/agents/${agentId}/models`);
  expect(result).toMatchObject({ status: 200, body: { models } });
});

it("commands read forwards the required job_id and returns the exact list", async () => {
  const fixture = await setup({
    response: (skill, input) => {
      expect(skill, "commands route calls session.commands").toBe(
        "session.commands",
      );
      expect(input, "commands route forwards job_id").toEqual({
        job_id: "job-7",
      });
      return { commands };
    },
  });
  const result = await fixture.get(
    `/api/agents/${agentId}/commands?job_id=job-7`,
  );
  expect(
    fixture.requests,
    "commands dispatch preserves skill and job_id",
  ).toEqual([{ skill: "session.commands", input: { job_id: "job-7" } }]);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ commands });
});

it("commands read refuses a missing job_id without contacting the agent", async () => {
  const fixture = await setup({ response: () => ({ commands }) });
  const result = await fixture.get(`/api/agents/${agentId}/commands`);
  expect(result.status).toBe(400);
  expect(fixture.requests, "no agent call for a missing job_id").toEqual([]);
});

it("commands read surfaces the agent refusal", async () => {
  const fixture = await setup({
    response: () => ({
      rpcError: { code: -32107, message: "Job is not running: job-7" },
    }),
  });
  const result = await fixture.get(
    `/api/agents/${agentId}/commands?job_id=job-7`,
  );
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ ok: false, code: -32107 });
});

it("status read forwards the required job_id and returns the object", async () => {
  const fixture = await setup({
    response: (skill, input) => {
      expect(skill, "status route calls session.status").toBe("session.status");
      expect(input, "status route forwards job_id").toEqual({
        job_id: "job-7",
      });
      return status;
    },
  });
  const result = await fixture.get(
    `/api/agents/${agentId}/status?job_id=job-7`,
  );
  expect(
    fixture.requests,
    "status dispatch preserves skill and job_id",
  ).toEqual([{ skill: "session.status", input: { job_id: "job-7" } }]);
  expect(result.status).toBe(200);
  expect(result.body).toEqual(status);
});

it("status read refuses a missing job_id without contacting the agent", async () => {
  const fixture = await setup({ response: () => status });
  const result = await fixture.get(`/api/agents/${agentId}/status`);
  expect(result.status).toBe(400);
  expect(fixture.requests, "no agent call for a missing job_id").toEqual([]);
});

it("setmodel forwards the exact request body and returns the agent result", async () => {
  const piResult = { provider: "provider-a", id: "model-a", name: "Model A" };
  const body = { job_id: "job-7", provider: "provider-a", model_id: "model-a" };
  const fixture = await setup({
    response: (skill, input) => {
      expect(skill, "setmodel routes to session.set_model").toBe(
        "session.set_model",
      );
      expect(input, "setmodel forwards snake_case body exactly").toEqual(body);
      return piResult;
    },
  });
  const result = await fixture.post(`/api/agents/${agentId}/setmodel`, body);
  expect(
    fixture.requests,
    "setmodel dispatches the exact skill and input",
  ).toEqual([{ skill: "session.set_model", input: body }]);
  expect(result).toEqual({ status: 200, body: { ok: true, result: piResult } });
});

it("setmodel refuses non-confidential execution before contacting the agent", async () => {
  const fixture = await setup({ confidential: false });
  const result = await fixture.post(`/api/agents/${agentId}/setmodel`, {
    job_id: "job",
    provider: "p",
    model_id: "m",
  });
  expect(result).toMatchObject({
    status: 403,
    body: { error: "confidential_transport_required" },
  });
  expect(fixture.requests, "transport refusal reaches no agent").toEqual([]);
});

it("setmodel allows the explicit insecure override", async () => {
  const fixture = await setup({
    confidential: false,
    allowInsecureExecution: true,
    response: () => ({ changed: true }),
  });
  const result = await fixture.post(`/api/agents/${agentId}/setmodel`, {
    job_id: "job",
    provider: "p",
    model_id: "m",
  });
  expect(result).toMatchObject({
    status: 200,
    body: { ok: true, result: { changed: true } },
  });
});

it("models and setmodel return 404 for an unknown agent", async () => {
  const fixture = await setup();
  expect(await fixture.get("/api/agents/missing/models")).toEqual({
    status: 404,
    body: { error: "unknown_agent" },
  });
  expect(await fixture.post("/api/agents/missing/setmodel", {})).toEqual({
    status: 404,
    body: { error: "unknown_agent" },
  });
});

it("surfaces agent skill refusals as HTTP 200 with code and message", async () => {
  const fixture = await setup({
    response: () => ({
      rpcError: { code: -32107, message: "Job is not running" },
    }),
  });
  const result = await fixture.post(`/api/agents/${agentId}/setmodel`, {
    job_id: "job",
    provider: "p",
    model_id: "m",
  });
  expect(result).toEqual({
    status: 200,
    body: { ok: false, code: -32107, message: "Job is not running" },
  });
});

it("maps an unreachable agent to 502", async () => {
  const fixture = await setup({
    response: () => new Error("connection refused"),
  });
  const result = await fixture.get(`/api/agents/${agentId}/models`);
  expect(result).toMatchObject({
    status: 502,
    body: { error: "agent_unreachable" },
  });
});

it("maps a malformed models result to agent_unreachable", async () => {
  // The guard exists for the same reason the spawn one does
  // (execution.test.ts "maps malformed successful spawn results"): a reply with
  // the wrong SHAPE must not be laundered into a 200 with `models: undefined`,
  // which the dashboard would read as an empty catalog.
  for (const bad of [{ notModels: true }, { models: "nope" }, null]) {
    const fixture = await setup({ response: () => bad });
    const result = await fixture.get(`/api/agents/${agentId}/models`);
    expect(result, JSON.stringify(bad)).toMatchObject({
      status: 502,
      body: { error: "agent_unreachable" },
    });
  }
});
