// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { PeerRegistry } from "../src/index.js";

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
});
