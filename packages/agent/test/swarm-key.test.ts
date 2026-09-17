// SPDX-License-Identifier: GPL-3.0-or-later

import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeSwarmKey,
  generateSwarmKey,
  loadSwarmKey,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryKey(contents: string, mode: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-mesh-agent-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "swarm.key");
  await writeFile(path, contents, "utf8");
  await chmod(path, mode);
  expect((await stat(path)).mode & 0o777).toBe(mode);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("swarm keys", () => {
  it("generates a base64-encoded 32-byte key", () => {
    const encoded = generateSwarmKey();

    expect(Buffer.from(encoded, "base64")).toHaveLength(32);
  });

  it.each([16, 64])("rejects a decoded key of %i bytes", (length) => {
    expect(() => decodeSwarmKey(Buffer.alloc(length).toString("base64"))).toThrow(
      /exactly 32 bytes/,
    );
  });

  it("rejects malformed base64", () => {
    expect(() => decodeSwarmKey("not base64!"))
      .toThrow("Swarm key must be valid base64");
  });

  it.each([16, 64])("rejects a file containing %i decoded bytes", async (length) => {
    const path = await temporaryKey(Buffer.alloc(length).toString("base64"), 0o600);

    await expect(loadSwarmKey(path)).rejects.toThrow(/exactly 32 bytes/);
  });

  it("loads a valid owner-only key and tolerates a trailing newline", async () => {
    const encoded = generateSwarmKey();
    const path = await temporaryKey(`${encoded}\n`, 0o600);

    await expect(loadSwarmKey(path)).resolves.toEqual(
      new Uint8Array(Buffer.from(encoded, "base64")),
    );
  });

  it("rejects a missing key with a clear error", async () => {
    const path = join(tmpdir(), "pi-mesh-missing-swarm-key");

    await expect(loadSwarmKey(path)).rejects.toThrow(path);
  });

  it.skipIf(process.platform === "win32")("refuses a group/world-readable key", async () => {
    const path = await temporaryKey(generateSwarmKey(), 0o644);

    await expect(loadSwarmKey(path)).rejects.toThrow(/mode 0644, expected 0600/);
  });

  it.skipIf(process.platform === "win32")("accepts an owner-readable key", async () => {
    const path = await temporaryKey(generateSwarmKey(), 0o400);

    await expect(loadSwarmKey(path)).resolves.toHaveLength(32);
  });
});

