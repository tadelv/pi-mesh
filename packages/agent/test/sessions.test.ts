// SPDX-License-Identifier: GPL-3.0-or-later

import { vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

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
import * as fs from "node:fs/promises";
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

function headerForTest(id: string): string {
  return `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2024-01-01T00:00:00.000Z",
    cwd: "/test",
  })}\n`;
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
    for (const [name, version] of [
      ["synthetic-extra-entry-types-v3.jsonl", 3],
      ["synthetic-header-v1.jsonl", 1],
      ["synthetic-header-v2.jsonl", 2],
    ] as const) {
      const parsed = parseSession(await readFile(fixture(name)));
      expect(parsed.errors, name).toEqual([]);
      // Tolerating versions 1-3 is the criterion, so assert the version
      // itself: toBeDefined() would still pass if version were dropped.
      expect(parsed.header?.version, name).toBe(version);
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
    // v1 has no tree ids. The parser synthesises stable cursors and chains
    // parents so `since` and append order work; Pi assigns RANDOM ids when it
    // migrates v1 -> v2, so there is no Pi entry id to preserve here. That
    // this is ours, and not Pi's, is documented in PROTOCOL.md.
    expect(v1.entries.map((entry) => entry.id)).toEqual(["v1-2", "v1-3"]);
    expect(v1.entries[0]?.parentId).toBeNull();
    expect(v1.entries[1]?.parentId).toBe("v1-2");
  });

  it("encodes the session directory exactly as Pi does", () => {
    // Regression: the helper used to replace "/" with "-" and keep the
    // leading separator, producing ---Users-...--- instead of
    // --Users-...--. Checked against directories that exist on this machine.
    expect(
      getSessionStorageDir("/Users/vid/development/repos/pi-mesh", "/root"),
    ).toBe(join("/root", "--Users-vid-development-repos-pi-mesh--"));
    expect(getSessionStorageDir("/private/tmp/pm-fixture", "/root")).toBe(
      join("/root", "--private-tmp-pm-fixture--"),
    );
    // Pi also encodes backslash and colon, and strips exactly one leading
    // separator. A colon and a backslash are adjacent in a Windows path, so
    // the double dash is Pi's actual output, not a mistake here.
    expect(getSessionStorageDir("C:\\Users\\me", "/root")).toBe(
      join("/root", "--C--Users-me--"),
    );
  });

  it("reads the latest session_info name and honours an explicit clear", async () => {
    // Pi's getSessionName walks entries in REVERSE to find the latest
    // session_info, and treats a later entry with no name as a clear. Using
    // find() (first) reported a stale name and could honour neither a rename
    // nor a clear - and no fixture had two session_info entries, so nothing
    // caught it.
    const root = await testRoot();
    await installFixture(root, "synthetic-session-info-rename-v3.jsonl");
    const store = new SessionStore({ sessionsRoot: root });

    const [summary] = await store.list();
    expect(summary?.name).toBeUndefined();
    expect(summary).not.toHaveProperty("name");
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

  it("skips a session file that vanishes while finding another session", async () => {
    const root = await testRoot();
    const vanishedDirectory = getSessionStorageDir("/aaa", root);
    const targetDirectory = getSessionStorageDir("/bbb", root);
    await mkdir(vanishedDirectory, { recursive: true });
    await mkdir(targetDirectory, { recursive: true });
    const vanished = join(vanishedDirectory, "vanished.jsonl");
    const target = join(targetDirectory, "target.jsonl");
    await writeFile(
      vanished,
      headerForTest("123e4567-e89b-42d3-a456-426614174098"),
    );
    await writeFile(
      target,
      headerForTest("123e4567-e89b-42d3-a456-426614174097"),
    );

    const spy = vi.mocked(fs.readFile);
    const originalReadFile = spy.getMockImplementation()!;
    spy.mockImplementation((async (path: string | URL, ...args: unknown[]) => {
      if (path === vanished) {
        const error = new Error("vanished") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return originalReadFile(path, ...(args as [never]));
    }) as typeof fs.readFile);
    try {
      const store = new SessionStore({ sessionsRoot: root });
      await expect(
        store.read({ id: "123e4567-e89b-42d3-a456-426614174097" }),
      ).resolves.toEqual([]);
      expect(store.errors[0]?.message).toContain("disappeared");
    } finally {
      spy.mockRestore();
    }
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
