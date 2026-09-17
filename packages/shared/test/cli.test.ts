// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectInvocation } from "../src/index.js";

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
        expect(isDirectInvocation(metaUrl, join(directory, "other.js"))).toBe(
          false,
        );
        expect(isDirectInvocation(metaUrl, undefined)).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
