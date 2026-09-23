// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadControlCredentials,
  saveControlCredential,
} from "../src/control-credentials.js";

const entry = {
  controlId: "control",
  credential: Buffer.alloc(32, 1).toString("base64"),
  pairedAt: "2026-01-01T00:00:00.000Z",
};

describe("control credential storage", () => {
  it("loads missing as empty, round trips, upserts, and writes 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-controls-"));
    const path = join(dir, "nested", "credentials.json");
    expect(await loadControlCredentials({ path })).toEqual([]);
    await saveControlCredential(entry, { path });
    await saveControlCredential(
      { ...entry, credential: Buffer.alloc(32, 2).toString("base64") },
      { path },
    );
    const records = await loadControlCredentials({ path });
    expect(records).toHaveLength(1);
    expect(records[0]?.credential).toBe(Buffer.alloc(32, 2).toString("base64"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("throws on malformed JSON rather than resetting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-controls-"));
    const path = join(dir, "credentials.json");
    await writeFile(path, "{");
    await expect(loadControlCredentials({ path })).rejects.toThrow(
      "Malformed control credentials",
    );
  });
});
