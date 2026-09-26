// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, expect, it } from "vitest";
import vm from "node:vm";
import { JobManager } from "../../agent/src/jobs.js";
import { createAgentServer } from "../../agent/src/server.js";
import { parseSpawnPolicy } from "../../agent/src/spawn-policy.js";
import {
  agentControls,
  ControlStore,
  createControlServer,
  dashboard,
} from "../src/index.js";

const controlId = "33333333-3333-4333-8333-333333333333";
const credential = Buffer.alloc(32, 7).toString("base64");
const resources: Array<{ stop(): Promise<void>; close?(): void }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    if ("close" in resource && resource.close !== undefined) resource.close();
    else await resource.stop();
  }
});

it("reports advertised capabilities and unknown for an unreachable agent", async () => {
  const store = new ControlStore(":memory:");
  resources.push({ stop: async () => undefined, close: () => store.close() });
  store.setMeta("control_id", controlId);
  store.setMeta("dashboard_token", "dashboard-token");
  const control = createControlServer({
    store,
    host: "127.0.0.1",
    port: 0,
  });
  resources.push(control);
  const controlAddress = await control.start();

  const agents = await Promise.all(
    [
      { id: "closed-agent", enabled: false },
      { id: "open-agent", enabled: true },
    ].map(async ({ id, enabled }) => {
      const jobs = enabled
        ? new JobManager({
            spawnJob: () => {
              throw new Error("must not spawn");
            },
          })
        : undefined;
      if (jobs !== undefined) resources.push({ stop: () => jobs.shutdown() });
      const agent = createAgentServer({
        ...(jobs === undefined ? {} : { jobs }),
        host: "127.0.0.1",
        port: 0,
        swarmKey: Buffer.from("fixture swarm key"),
        identity: { peerId: id, name: id },
        controlCredentials: [{ controlId, credential, pairedAt: "now" }],
        spawnPolicy: parseSpawnPolicy(enabled ? "*" : undefined, ""),
      });
      const address = await agent.start();
      resources.push(agent);
      store.upsertAgent({
        peer_id: id,
        name: id,
        host: "127.0.0.1",
        port: address.port,
        credential,
        paired_at: "now",
      });
      return id;
    }),
  );
  store.upsertAgent({
    peer_id: "unreachable-agent",
    name: "unreachable-agent",
    host: "127.0.0.1",
    port: 1,
    credential,
    paired_at: "now",
  });

  const headers = { "X-Pi-Mesh-Ui": "dashboard-token" };
  const sync = await fetch(`http://127.0.0.1:${controlAddress.port}/api/sync`, {
    method: "POST",
    headers,
  });
  expect(sync.status).toBe(200);
  const stateResponse = await fetch(
    `http://127.0.0.1:${controlAddress.port}/api/state`,
    { headers },
  );
  const state = (await stateResponse.json()) as {
    agents: Array<{
      peer_id: string;
      skills: string[] | null;
      controls: {
        spawn: boolean;
        steer: boolean;
        stop: boolean;
        abort: boolean;
        models: boolean;
        setModel: boolean;
        resume: boolean;
      };
    }>;
  };
  const skills = Object.fromEntries(
    state.agents.map((agent) => [agent.peer_id, agent.skills]),
  );
  expect(
    skills[agents[0]!]!.includes("process.spawn"),
    "closed-agent skills clause: a gate-closed agent must not advertise process.spawn",
  ).toBe(false);
  expect(skills[agents[1]!]!.includes("process.spawn")).toBe(true);
  expect(skills["unreachable-agent"]).toBeNull();
  const controls = Object.fromEntries(
    state.agents.map((agent) => [agent.peer_id, agent.controls]),
  );
  expect(controls[agents[0]!]).toMatchObject({ spawn: false });
  expect(controls[agents[1]!]).toEqual({
    spawn: true,
    steer: true,
    stop: true,
    abort: true,
    models: true,
    setModel: true,
    resume: true,
    commands: true,
    status: true,
  });
  expect(controls["unreachable-agent"]).toEqual({
    spawn: false,
    steer: false,
    stop: false,
    abort: false,
    models: false,
    setModel: false,
    resume: false,
    commands: false,
    status: false,
  });

  const restarted = createControlServer({ store, host: "127.0.0.1", port: 0 });
  resources.push(restarted);
  const restartedAddress = await restarted.start();
  const restartedState = (await (
    await fetch(`http://127.0.0.1:${restartedAddress.port}/api/state`, {
      headers,
    })
  ).json()) as { agents: Array<{ peer_id: string; skills: string[] | null }> };
  expect(
    restartedState.agents.find((agent) => agent.peer_id === agents[1]!)!.skills,
    "restart clause: capabilities must be unknown until this server instance syncs",
  ).toBeNull();

  // A freshly paired agent has no cached capabilities and has not been reached.
  // It must read as unknown, not capable: offering execution for an agent we
  // know nothing about is the capability-honesty failure this clause prevents.
  store.upsertAgent({
    peer_id: "fresh-agent",
    name: "fresh-agent",
    host: "127.0.0.1",
    port: 1,
    credential,
    paired_at: "now",
  });
  const freshState = (await (
    await fetch(`http://127.0.0.1:${controlAddress.port}/api/state`, {
      headers,
    })
  ).json()) as {
    agents: Array<{ peer_id: string; skills: string[] | null }>;
  };
  expect(
    freshState.agents.find((agent) => agent.peer_id === "fresh-agent")!.skills,
    "never-synced clause: an agent with no fetched capabilities must be unknown, not capable",
  ).toBeNull();
});

it("derives each control from its advertised skill", () => {
  expect(
    agentControls([
      "process.spawn",
      "session.steer",
      "process.stop",
      "session.abort",
      "session.models",
      "session.set_model",
    ]),
  ).toEqual({
    spawn: true,
    steer: true,
    stop: true,
    abort: true,
    models: true,
    setModel: true,
    resume: false,
    commands: false,
    status: false,
  });
  expect(
    agentControls(["process.spawn", "process.stop", "session.read"]),
  ).toEqual({
    spawn: true,
    steer: false,
    stop: true,
    abort: false,
    models: false,
    setModel: false,
    resume: false,
    commands: false,
    status: false,
  });
  expect(agentControls(null)).toEqual({
    spawn: false,
    steer: false,
    stop: false,
    abort: false,
    models: false,
    setModel: false,
    resume: false,
    commands: false,
    status: false,
  });
});

it("guards every dashboard control by its corresponding capability", () => {
  for (const action of ["spawn", "steer", "stop", "abort"])
    expect(dashboard, `dashboard controls.${action} guard clause`).toContain(
      `controls.${action}`,
    );
});

it("does not load external resources or disclose credentials in the dashboard", () => {
  expect(
    dashboard,
    "external-resource clause: dashboard must have no external URLs",
  ).not.toMatch(/https?:\/\//i);
  expect(
    dashboard,
    "external-resource clause: dashboard must have no remote src/href resources",
  ).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
  expect(dashboard.toLowerCase()).not.toContain("credential");
});

it("ships a dashboard script that parses", () => {
  // There is no browser test and none is claimed, so this is the cheapest guard
  // that a dashboard edit is valid JavaScript at all. vm.Script compiles
  // without running, which matters: the IIFE touches localStorage and document
  // the moment it executes.
  const script = /<script>([\s\S]*)<\/script>/.exec(dashboard)?.[1];
  expect(script, "the dashboard must contain an inline script").toBeTypeOf(
    "string",
  );
  expect(() => new vm.Script(script ?? "")).not.toThrow();
});
