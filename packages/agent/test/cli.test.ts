// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { PeerRegistry, servedSkills, type BonjourLike } from "../src/index.js";

class FakeBonjour implements BonjourLike {
  readonly published: { txt: Record<string, string>; port: number }[] = [];
  destroyed = false;

  publish(options: { txt: Record<string, string>; port: number }): void {
    this.published.push(options);
  }

  find(): { stop(): void } {
    return { stop: () => undefined };
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function output() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
          return true;
        },
      },
    },
    read: () => ({ stdout, stderr }),
  };
}

describe("agent CLI", () => {
  it("prints one 32-byte base64 key for keygen", async () => {
    const captured = output();

    await expect(run(["keygen"], captured.io)).resolves.toBe(0);

    const { stdout, stderr } = captured.read();
    expect(stdout).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
    expect(Buffer.from(stdout.trim(), "base64")).toHaveLength(32);
    expect(stderr).toBe("");
  });

  it.each([[[]], [["bogus"]], [["--profile", "bogus", "peers"]]])(
    "rejects an unknown or missing command or profile",
    async (argv) => {
      const captured = output();

      await expect(run(argv, captured.io)).resolves.toBe(2);

      const { stdout, stderr } = captured.read();
      expect(stdout).toBe("");
      expect(stderr).toMatch(/Usage: pi-mesh-agent keygen\n/);
    },
  );

  it("prints the browsed peer registry as JSON on stdout only", async () => {
    const captured = output();
    const registry = new PeerRegistry();
    registry.add({
      id: "peer-b",
      name: "Peer B",
      serviceType: "mesh",
      host: "peer-b.local",
      port: 7330,
      txt: { id: "peer-b" },
    });

    await expect(
      run(["peers", "--timeout", "0"], { ...captured.io, registry }),
    ).resolves.toBe(0);

    const { stdout, stderr } = captured.read();
    expect(JSON.parse(stdout)).toHaveLength(1);
    expect(JSON.parse(stdout)[0]).toMatchObject({ id: "peer-b" });
    expect(stderr).toBe("");
  });

  it("prints an empty registry when nothing is discovered", async () => {
    const captured = output();

    await expect(
      run(["peers", "--timeout", "0", "--profile", "public"], captured.io),
    ).resolves.toBe(0);

    const { stdout } = captured.read();
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it("starts the listener and advertises exactly its served skills", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-mesh-cli-"));
    const bonjour = new FakeBonjour();
    const captured = output();
    const oldHome = process.env.HOME;
    const oldPort = process.env.PI_MESH_PORT;
    process.env.HOME = home;
    process.env.PI_MESH_PORT = "47931";
    try {
      const running = run(["start"], {
        ...captured.io,
        bonjour,
        identity: {
          peerId: "22222222-2222-4222-8222-222222222222",
          name: "agent",
        },
        swarmKey: Buffer.alloc(32, 7),
      });
      for (
        let attempt = 0;
        attempt < 100 && bonjour.published.length === 0;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(bonjour.published).toHaveLength(1);
      const capabilities = bonjour.published[0]?.txt.caps?.split(",").sort();
      expect(capabilities).toEqual([...servedSkills()].sort());
      const cardResponse = await fetch(
        "http://127.0.0.1:47931/.well-known/agent-card.json",
      );
      const card = (await cardResponse.json()) as {
        skills: { id: string }[];
      };
      expect(capabilities).toEqual(card.skills.map((skill) => skill.id).sort());
      process.emit("SIGINT");
      await expect(running).resolves.toBe(0);
      expect(bonjour.destroyed).toBe(true);
      await expect(readdir(home)).resolves.toEqual([]);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldPort === undefined) delete process.env.PI_MESH_PORT;
      else process.env.PI_MESH_PORT = oldPort;
    }
  });
});
