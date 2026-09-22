// SPDX-License-Identifier: GPL-3.0-or-later

import { createServer } from "node:net";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentCard } from "@pi-mesh/protocol";
import type { BonjourLike, BonjourPublishOptions } from "../src/index.js";

const EXECUTION_SKILLS = ["process.spawn", "session.steer"];
const UNGATED_SKILLS = [
  "mesh.peers",
  "process.stop",
  "session.abort",
  "session.list",
  "session.read",
  "session.stream",
].sort();

class PublishedBonjour implements BonjourLike {
  readonly published: BonjourPublishOptions[] = [];
  destroyed = false;

  publish(options: BonjourPublishOptions): void {
    this.published.push(options);
  }

  find(): { stop(): void } {
    return { stop: () => undefined };
  }

  destroy(): void {
    this.destroyed = true;
  }
}

type Observation = {
  cardSkills: string[];
  capsSkills: string[];
};

function withDeadline<T>(
  promise: Promise<T>,
  label: string,
  milliseconds = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`${label} did not settle within ${milliseconds}ms`)),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await withDeadline(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    "loopback port allocation",
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("loopback listener did not expose a TCP port");
  }
  await withDeadline(
    new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    }),
    "loopback port release",
  );
  return address.port;
}

async function observe(gate: string | undefined): Promise<Observation> {
  const port = await unusedLoopbackPort();
  const bonjour = new PublishedBonjour();
  const oldPort = process.env.PI_MESH_PORT;
  const oldGate = process.env.PI_MESH_ALLOW_SPAWN;
  const oldWorkspace = process.env.PI_MESH_WORKSPACE;
  process.env.PI_MESH_PORT = String(port);
  process.env.PI_MESH_WORKSPACE = process.cwd();
  if (gate === undefined) delete process.env.PI_MESH_ALLOW_SPAWN;
  else process.env.PI_MESH_ALLOW_SPAWN = gate;

  let stderr = "";
  vi.resetModules();
  const { run } = await import("../src/cli.js");
  const running = run(["start"], {
    stdout: { write: () => true },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    },
    bonjour,
    identity: {
      peerId: "22222222-2222-4222-8222-222222222222",
      name: "capability-honesty-test",
    },
    swarmKey: Buffer.alloc(32, 7),
  });

  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (bonjour.published.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (bonjour.published.length !== 1) {
      throw new Error(
        `agent did not publish exactly one DNS-SD advertisement: ${stderr}`,
      );
    }

    const response = await fetch(
      `http://127.0.0.1:${port}/.well-known/agent-card.json`,
      { signal: AbortSignal.timeout(2_000) },
    );
    if (!response.ok) {
      throw new Error(`agent card returned HTTP ${response.status}`);
    }
    const card = (await response.json()) as AgentCard;
    const caps = bonjour.published[0]?.txt?.caps;
    return {
      cardSkills: card.skills.map((skill) => skill.id).sort(),
      capsSkills: typeof caps === "string" ? caps.split(",").sort() : [],
    };
  } finally {
    process.emit("SIGINT");
    await withDeadline(running, "agent shutdown");
    if (oldPort === undefined) delete process.env.PI_MESH_PORT;
    else process.env.PI_MESH_PORT = oldPort;
    if (oldGate === undefined) delete process.env.PI_MESH_ALLOW_SPAWN;
    else process.env.PI_MESH_ALLOW_SPAWN = oldGate;
    if (oldWorkspace === undefined) delete process.env.PI_MESH_WORKSPACE;
    else process.env.PI_MESH_WORKSPACE = oldWorkspace;
  }
}

describe("M2-8 capability honesty", () => {
  let disabled: Observation;
  let enabled: Observation;

  beforeAll(async () => {
    disabled = await observe(undefined);
    enabled = await observe("*");
  });

  it("clause 1: with the gate DISABLED, the HTTP agent card contains neither gated skill", () => {
    expect(
      disabled.cardSkills.filter((skill) => EXECUTION_SKILLS.includes(skill)),
    ).toEqual([]);
  });

  it("clause 2: with the gate ENABLED, the HTTP agent card contains both gated skills", () => {
    expect(
      enabled.cardSkills.filter((skill) => EXECUTION_SKILLS.includes(skill)),
    ).toEqual(EXECUTION_SKILLS);
  });

  it("clause 3: DNS-SD caps omits both gated skills when DISABLED and contains both when ENABLED", () => {
    expect(
      disabled.capsSkills.filter((skill) => EXECUTION_SKILLS.includes(skill)),
    ).toEqual([]);
    expect(
      enabled.capsSkills.filter((skill) => EXECUTION_SKILLS.includes(skill)),
    ).toEqual(EXECUTION_SKILLS);
  });

  it("clause 4: the card and DNS-SD caps do not contradict each other in either gate state", () => {
    expect(disabled.cardSkills).toEqual(disabled.capsSkills);
    expect(enabled.cardSkills).toEqual(enabled.capsSkills);
  });

  it("clause 5: DISABLED still advertises the exact ungated skill set and non-empty caps", () => {
    expect(disabled.cardSkills).toEqual(UNGATED_SKILLS);
    expect(disabled.capsSkills).toEqual(UNGATED_SKILLS);
    expect(disabled.capsSkills.length).toBeGreaterThan(0);
  });
});
