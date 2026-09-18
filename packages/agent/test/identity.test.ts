// SPDX-License-Identifier: GPL-3.0-or-later

import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

  it("tightens a loose identity file and directory on reload", async () => {
    // The create path alone does NOT prove this. mkdir's 0700 and writeFile's
    // 0600 already satisfy a fresh-creation assertion under any umask, so
    // deleting both chmod calls would leave such a test green while a
    // pre-existing world-readable identity stayed readable. Only loosening the
    // files first exercises the chmods that repair it.
    const root = await mkdtemp(join(tmpdir(), "pi-mesh-identity-"));
    const directory = join(root, "nested");
    const path = join(directory, "credentials.json");
    const first = await loadOrCreateIdentity({ path });
    await chmod(directory, 0o755);
    await chmod(path, 0o644);
    const second = await loadOrCreateIdentity({ path });
    expect(second.peerId).toBe(first.peerId);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("does not replace malformed credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mesh-identity-"));
    const path = join(root, "credentials.json");
    await writeFile(path, "not json");
    await expect(loadOrCreateIdentity({ path })).rejects.toThrow(path);
  });
});
