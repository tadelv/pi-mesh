// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectInvocation, run } from "../src/cli.js";

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

describe("isDirectInvocation", () => {
  it.skipIf(process.platform === "win32")(
    "detects invocation through a bin symlink",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "pi-mesh-cli-"));
      const realFile = join(directory, "cli.js");
      const linkPath = join(directory, "pi-mesh-agent");
      await writeFile(realFile, "// stub\n", "utf8");
      await symlink(realFile, linkPath);

      try {
        const metaUrl = pathToFileURL(realFile).href;

        // The regression: npm/pnpm run a symlink, so argv[1] is the link while
        // import.meta.url is the real file. These must still be one module.
        expect(isDirectInvocation(metaUrl, linkPath)).toBe(true);
        expect(isDirectInvocation(metaUrl, realFile)).toBe(true);
        expect(isDirectInvocation(metaUrl, join(directory, "other.js"))).toBe(false);
        expect(isDirectInvocation(metaUrl, undefined)).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
