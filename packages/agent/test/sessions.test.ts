// SPDX-License-Identifier: GPL-3.0-or-later

import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SessionStore,
  getSessionStorageDir,
  parseSession,
} from "../src/sessions.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function testRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-mesh-sessions-"));
}

async function installFixture(root: string, name: string): Promise<void> {
  const target = getSessionStorageDir("/synthetic/project", root);
  await mkdir(target, { recursive: true });
  await copyFile(fixture(name), join(target, `${name}.jsonl`));
}

describe("Pi session parsing", () => {
  it("reads the committed Pi 0.85.1 v3 fixture in exact append order", async () => {
    const content = await readFile(fixture("pi-0.85.1-session-v3.jsonl"));
    const parsed = parseSession(content);

    expect(parsed.errors).toEqual([]);
    expect(parsed.header?.version).toBe(3);
    expect(parsed.entries).toHaveLength(5);
    expect(parsed.entries.map((entry) => entry.type)).toEqual([
      "model_change",
      "thinking_level_change",
      "custom",
      "message",
      "message",
    ]);
    expect(parsed.entries.map((entry) => entry.id)).toEqual([
      "225ca269",
      "db3a54ab",
      "27130e49",
      "33ecf5dc",
      "c608dfd5",
    ]);
  });

  it("covers documented extra entry types and v1/v2 headers from synthetic fixtures", async () => {
    // These are synthetic fixtures; their fields are copied from Pi's
    // installed core/session-manager.d.ts declarations.
    for (const name of [
      "synthetic-extra-entry-types-v3.jsonl",
      "synthetic-header-v1.jsonl",
      "synthetic-header-v2.jsonl",
    ]) {
      const parsed = parseSession(await readFile(fixture(name)));
      expect(parsed.errors, name).toEqual([]);
      expect(parsed.header).toBeDefined();
    }

    const extra = parseSession(
      await readFile(fixture("synthetic-extra-entry-types-v3.jsonl")),
    );
    expect(extra.entries.map((entry) => entry.type)).toEqual([
      "compaction",
      "branch_summary",
      "custom_message",
      "label",
      "session_info",
    ]);
    const v1 = parseSession(
      await readFile(fixture("synthetic-header-v1.jsonl")),
    );
    expect(v1.entries[0]?.id).toBe("v1-2");
    expect(typeof v1.entries[0]?.parentId).toBe("object");
  });

  it("skips and reports one malformed line while retaining later entries", async () => {
    const parsed = parseSession(
      await readFile(fixture("synthetic-malformed-line-v3.jsonl")),
    );
    expect(parsed.entries.map((entry) => entry.type)).toEqual([
      "message",
      "session_info",
    ]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.line).toBe(3);
    expect(parsed.errors[0]?.message).toMatch(/^invalid JSON:/);
  });
});

describe("SessionStore", () => {
  it("lists by header UUID and cwd, and reads with an entry cursor", async () => {
    const root = await testRoot();
    await installFixture(root, "synthetic-extra-entry-types-v3.jsonl");
    const store = new SessionStore({ sessionsRoot: root });

    await expect(store.list()).resolves.toEqual([
      {
        id: "123e4567-e89b-42d3-a456-426614174000",
        project: "/synthetic/project",
        name: "Synthetic session",
        started_at: "2024-12-03T14:00:00.000Z",
        updated_at: "2024-12-03T14:00:05.000Z",
      },
    ]);

    // The regression: `status: "unknown"` was emitted for every session on
    // disk because Pi's format records no lifecycle state, and `ended_at` was
    // never populated. Both looked like data while carrying none - the same
    // defect as the removed `fp` TXT key. `updated_at` is last activity and
    // says so.
    const [summary] = await store.list();
    expect(summary).not.toHaveProperty("status");
    expect(summary).not.toHaveProperty("ended_at");

    const events = await store.read({
      id: "123e4567-e89b-42d3-a456-426614174000",
      since: "22222222",
    });
    expect(events.map((event) => event.entryId)).toEqual([
      "33333333",
      "44444444",
      "55555555",
    ]);
    expect(events.every((event) => typeof event.entryId === "string")).toBe(
      true,
    );
  });

  it("accepts an unknown version and still returns entries", async () => {
    const root = await testRoot();
    const directory = getSessionStorageDir("/unknown", root);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "unknown.jsonl"),
      '{"type":"session","version":99,"id":"123e4567-e89b-42d3-a456-426614174004","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/unknown"}\n{"type":"session_info","id":"aaaaaaaa","parentId":null,"timestamp":"2024-01-01T00:00:01.000Z","name":"forward"}\n',
    );

    const store = new SessionStore({ sessionsRoot: root });
    await expect(
      store.read({ id: "123e4567-e89b-42d3-a456-426614174004" }),
    ).resolves.toHaveLength(1);
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("reports malformed lines without breaking listing", async () => {
    const root = await testRoot();
    const target = getSessionStorageDir("/synthetic/project", root);
    await mkdir(target, { recursive: true });
    await copyFile(
      fixture("synthetic-malformed-line-v3.jsonl"),
      join(target, "malformed.jsonl"),
    );
    const store = new SessionStore({ sessionsRoot: root });

    await expect(store.list()).resolves.toHaveLength(1);
    expect(store.errors).toHaveLength(1);
  });

  it("rejects path traversal instead of treating the id as a path", async () => {
    const store = new SessionStore({ sessionsRoot: "/tmp/does-not-matter" });
    await expect(store.read({ id: "../secret" })).rejects.toThrow("plain UUID");
    await expect(store.read({ id: "/absolute/path" })).rejects.toThrow(
      "plain UUID",
    );
  });

  it("rejects an unknown since cursor", async () => {
    const root = await testRoot();
    await installFixture(root, "synthetic-extra-entry-types-v3.jsonl");
    const store = new SessionStore({ sessionsRoot: root });
    await expect(
      store.read({
        id: "123e4567-e89b-42d3-a456-426614174000",
        since: "does-not-exist",
      }),
    ).rejects.toThrow("Unknown session entry id");
  });
});
