// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

function output() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
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

  it.each([[[]], [["bogus"]]])("rejects an unknown or missing command", async (argv) => {
    const captured = output();

    await expect(run(argv, captured.io)).resolves.toBe(2);

    const { stdout, stderr } = captured.read();
    expect(stdout).toBe("");
    expect(stderr).toMatch(/Usage: pi-mesh-agent keygen\n/);
  });
});
