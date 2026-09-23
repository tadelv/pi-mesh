// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, expect, it } from "vitest";
import { createAgentServer } from "../../agent/src/server.js";
import { parseSpawnPolicy } from "../../agent/src/spawn-policy.js";
import { ControlStore, createControlServer, dashboard } from "../src/index.js";

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
      const agent = createAgentServer({
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
  store.setAgentCaps("unreachable-agent", ["session.list"], "previous-sync");

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
    agents: Array<{ peer_id: string; skills: string[] | null }>;
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
  expect(store.agentCaps()["unreachable-agent"]).toEqual(["session.list"]);

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
