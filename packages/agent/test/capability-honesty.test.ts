// SPDX-License-Identifier: GPL-3.0-or-later

import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentCard } from "@pi-mesh/protocol";
import type { BonjourLike, BonjourPublishOptions } from "../src/index.js";

// The gate cannot OPEN without a resolvable `pi`: cli.ts calls resolvePiBinary()
// before the listener starts, so on a machine with no `pi` - every CI runner -
// the enabled state cannot be observed at all and this file errors before a
// single assertion runs. resolvePiBinary only realpaths, stats and checks X_OK;
// it never executes the file, and nothing here spawns a session. So this stands
// in for the real binary at the process boundary rather than skipping the
// clause, which would leave the delivered behaviour untested in CI.
const PI_BINARY = fileURLToPath(
  new URL("./fixtures/pi-binary", import.meta.url),
);
const EXECUTION_SKILLS = [
  "process.spawn",
  "session.steer",
  "session.set_model",
  "session.resume",
  "mesh.handoff",
].sort();
const ALWAYS_SKILLS = [
  "mesh.peers",
  "session.list",
  "session.read",
  "session.stream",
  "session.models",
].sort();
const GATE_OPEN_SKILLS = [
  ...ALWAYS_SKILLS,
  "process.list",
  "process.stop",
  "session.abort",
  "session.commands",
  ...EXECUTION_SKILLS,
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
  const oldPiBinary = process.env.PI_MESH_PI_BINARY;
  process.env.PI_MESH_PORT = String(port);
  process.env.PI_MESH_WORKSPACE = process.cwd();
  process.env.PI_MESH_PI_BINARY = PI_BINARY;
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
    if (oldPiBinary === undefined) delete process.env.PI_MESH_PI_BINARY;
    else process.env.PI_MESH_PI_BINARY = oldPiBinary;
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

  it("clause 2: with the gate ENABLED, the HTTP agent card contains all gated skills", () => {
    expect(
      enabled.cardSkills.filter((skill) => EXECUTION_SKILLS.includes(skill)),
    ).toEqual(EXECUTION_SKILLS);
  });

  it("clause 3: DNS-SD caps omits all gated skills when DISABLED and contains all when ENABLED", () => {
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

  it("clause 5: DISABLED advertises exactly the five always-served skills", () => {
    expect(disabled.cardSkills).toEqual(ALWAYS_SKILLS);
    expect(disabled.capsSkills).toEqual(ALWAYS_SKILLS);
    expect(disabled.capsSkills.length).toBeGreaterThan(0);
  });

  it("clause 6: ENABLED advertises all thirteen job and execution skills", () => {
    expect(enabled.cardSkills).toEqual(GATE_OPEN_SKILLS);
    expect(enabled.capsSkills).toEqual(GATE_OPEN_SKILLS);
  });
});
