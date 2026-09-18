// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateIdentity } from "../src/index.js";

describe("persistent peer identity", () => {
  it("creates a stable 0600 identity in a 0700 directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mesh-identity-"));
    const directory = join(root, "nested");
    const path = join(directory, "credentials.json");
    const first = await loadOrCreateIdentity({
      path,
      env: { PI_MESH_NAME: "first" },
    });
    const second = await loadOrCreateIdentity({
      path,
      env: { PI_MESH_NAME: "second" },
    });
    expect(second.peerId).toBe(first.peerId);
    expect(first.name).toBe("first");
    expect(second.name).toBe("second");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8")).peerId).toBe(first.peerId);
  });

  it("does not replace malformed credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mesh-identity-"));
    const path = join(root, "credentials.json");
    await writeFile(path, "not json");
    await expect(loadOrCreateIdentity({ path })).rejects.toThrow(path);
  });
});
