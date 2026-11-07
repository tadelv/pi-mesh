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
  symlink,
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

describe("nested child transcripts (M8-6)", () => {
  // Layout mirrors a real retained run verified under ~/.pi/agent/sessions:
  // `<root>/--<munged>--/<parent-stem>/<uuid>/run-0/session.jsonl`, where
  // `<parent-stem>/` shares its stem with the parent's `<stem>.jsonl` and
  // the child's header id is its own UUID - not the `<uuid>` directory.
  const PARENT_ID = "123e4567-e89b-42d3-a456-426614174010";
  const CHILD_ID = "123e4567-e89b-42d3-a456-426614174011";
  const PARENT_STEM = `2024-01-01T00-00-00-000Z_${PARENT_ID}`;
  const RUN_DIR_ID = "c8b76411-f8b5-4ec7-aaeb-4c6b45fa331c";

  function childTranscriptContent(childId: string, parentFile: string): string {
    const lines = [
      {
        type: "session",
        version: 3,
        id: childId,
        timestamp: "2024-02-01T00:00:00.000Z",
        cwd: "/tmp",
        parentSession: parentFile,
      },
      {
        type: "model_change",
        id: "81eb34f0",
        parentId: null,
        timestamp: "2024-02-01T00:00:01.000Z",
        provider: "deepseek",
        modelId: "deepseek-chat",
      },
      {
        type: "session_info",
        id: "3cb70e3e",
        parentId: "81eb34f0",
        timestamp: "2024-02-01T00:00:02.000Z",
        name: "subagent-review",
      },
      {
        type: "message",
        id: "f5cd95f4",
        parentId: "3cb70e3e",
        timestamp: "2024-02-01T00:00:03.000Z",
        message: { role: "user", content: "review this" },
      },
    ];
    return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  }

  async function installNestedChild(
    root: string,
    options: { includeParentFile?: boolean } = {},
  ): Promise<{ parentFile: string; childPath: string }> {
    const projectDir = getSessionStorageDir("/synthetic/project", root);
    await mkdir(projectDir, { recursive: true });
    const parentFile = join(projectDir, `${PARENT_STEM}.jsonl`);
    if (options.includeParentFile !== false) {
      await writeFile(parentFile, headerForTest(PARENT_ID));
    }
    const runDir = join(projectDir, PARENT_STEM, RUN_DIR_ID, "run-0");
    await mkdir(runDir, { recursive: true });
    const childPath = join(runDir, "session.jsonl");
    await writeFile(childPath, childTranscriptContent(CHILD_ID, parentFile));
    return { parentFile, childPath };
  }

  it("resolves a nested child by its header id through the ordinary read path", async () => {
    const root = await testRoot();
    await installFixture(root, "synthetic-extra-entry-types-v3.jsonl");
    await installNestedChild(root);
    const store = new SessionStore({ sessionsRoot: root });

    const events = await store.read({ id: CHILD_ID });
    expect(events.map((event) => event.entryId)).toEqual([
      "81eb34f0",
      "3cb70e3e",
      "f5cd95f4",
    ]);
    // The `since` cursor works exactly as for an ordinary session.
    const tail = await store.read({ id: CHILD_ID, since: "81eb34f0" });
    expect(tail.map((event) => event.entryId)).toEqual([
      "3cb70e3e",
      "f5cd95f4",
    ]);
    // The parent is still an ordinary readable session.
    await expect(store.read({ id: PARENT_ID })).resolves.toEqual([]);
    // Addressable, but never listed: a listed id names a root transcript.
    const listed = await store.list();
    expect(listed.map((summary) => summary.id)).toEqual(
      expect.arrayContaining([
        "123e4567-e89b-42d3-a456-426614174000",
        PARENT_ID,
      ]),
    );
    expect(listed.map((summary) => summary.id)).not.toContain(CHILD_ID);
  });

  it("leaves ordinary session ordering and identity rules unchanged", async () => {
    // Regression, not a smoke test: the listing with a nested child
    // present must equal the listing without it, entry for entry.
    const root = await testRoot();
    await installFixture(root, "synthetic-extra-entry-types-v3.jsonl");
    const otherDir = getSessionStorageDir("/other/project", root);
    await mkdir(otherDir, { recursive: true });
    await writeFile(
      join(otherDir, "other.jsonl"),
      `${headerForTest("123e4567-e89b-42d3-a456-426614174020")}{"type":"message","id":"m1","parentId":null,"timestamp":"2024-01-02T00:00:00.000Z"}\n`,
    );
    const before = await new SessionStore({ sessionsRoot: root }).list();
    expect(before).toHaveLength(2);

    // Installed without the parent file so the ONLY change is the nested
    // child itself: the listing must be entry-for-entry identical.
    await installNestedChild(root, { includeParentFile: false });
    const after = await new SessionStore({ sessionsRoot: root }).list();
    expect(after).toEqual(before);
    expect(after.map((summary) => summary.id)).not.toContain(CHILD_ID);
    // And ordinary reads are untouched by the child's presence.
    await expect(
      new SessionStore({ sessionsRoot: root }).read({
        id: "123e4567-e89b-42d3-a456-426614174020",
        since: "m1",
      }),
    ).resolves.toEqual([]);
  });

  it("containment refuses a nested transcript that escapes the sessions root", async () => {
    // A symlinked ancestor points a well-formed child outside the root.
    // The walk descends through the symlink so that the containment check -
    // not silent skipping - is what refuses it: deleting the check resolves
    // this read and must fail this test by name.
    const root = await testRoot();
    const outside = await testRoot();
    const outsideStem = join(outside, PARENT_STEM);
    const outsideRunDir = join(outsideStem, RUN_DIR_ID, "run-0");
    await mkdir(outsideRunDir, { recursive: true });
    await writeFile(
      join(outsideRunDir, "session.jsonl"),
      childTranscriptContent(CHILD_ID, join(outsideStem, ".jsonl")),
    );
    const projectDir = getSessionStorageDir("/synthetic/project", root);
    await mkdir(projectDir, { recursive: true });
    await symlink(outsideStem, join(projectDir, PARENT_STEM));

    const store = new SessionStore({ sessionsRoot: root });
    await expect(store.read({ id: CHILD_ID })).rejects.toThrow(
      "Unknown session id",
    );
    // list() resets the error log, so the refusal is asserted first.
    expect(
      store.errors.some((error) =>
        error.message.includes("outside the sessions root"),
      ),
    ).toBe(true);
    const listed = await store.list();
    expect(listed.map((summary) => summary.id)).not.toContain(CHILD_ID);
  });

  it("containment refuses traversal and absolute ids before touching the filesystem", async () => {
    const store = new SessionStore({ sessionsRoot: await testRoot() });
    await expect(store.read({ id: ".." })).rejects.toThrow("plain UUID");
    await expect(store.read({ id: "../outside" })).rejects.toThrow(
      "plain UUID",
    );
    await expect(store.read({ id: "/etc/passwd" })).rejects.toThrow(
      "plain UUID",
    );
  });

  it("refuses a nested file with no header and produces no session", async () => {
    const root = await testRoot();
    const projectDir = getSessionStorageDir("/synthetic/project", root);
    const runDir = join(projectDir, PARENT_STEM, RUN_DIR_ID, "run-0");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "session.jsonl"),
      '{"type":"message","id":"m1","parentId":null,"timestamp":"2024-02-01T00:00:00.000Z"}\n',
    );
    const store = new SessionStore({ sessionsRoot: root });

    await expect(
      store.read({ id: "123e4567-e89b-42d3-a456-426614174099" }),
    ).rejects.toThrow("Unknown session id");
    // list() resets the error log, so the refusal is asserted first: the
    // file is skipped with its reason and never becomes a session.
    expect(
      store.errors.some((error) =>
        error.message.includes("no complete header"),
      ),
    ).toBe(true);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("refuses a nested file whose header id is not a UUID", async () => {
    const root = await testRoot();
    const projectDir = getSessionStorageDir("/synthetic/project", root);
    const runDir = join(projectDir, PARENT_STEM, RUN_DIR_ID, "run-0");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "session.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "run-0",
        timestamp: "2024-02-01T00:00:00.000Z",
        cwd: "/tmp",
      })}\n${JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2024-02-01T00:00:01.000Z",
      })}\n`,
    );
    // A nested file is never listed, so the refusal surfaces through a
    // read-shaped probe: the error log names the unaddressable id.
    const probe = new SessionStore({ sessionsRoot: root });
    await expect(
      probe.read({ id: "123e4567-e89b-42d3-a456-426614174099" }),
    ).rejects.toThrow("Unknown session id");
    expect(
      probe.errors.some((error) => error.message.includes("not a UUID")),
    ).toBe(true);
    // And the listing stays empty: no addressable id, no session.
    await expect(
      new SessionStore({ sessionsRoot: root }).list(),
    ).resolves.toEqual([]);
  });

  it("refuses a truncated nested file with its reason instead of serving entries", async () => {
    const root = await testRoot();
    const { childPath } = await installNestedChild(root);
    // A valid header and one good entry, then a torn final line: the id is
    // known, so the refusal must state its reason rather than serve a
    // half-parse.
    await writeFile(
      childPath,
      `${headerForTest(CHILD_ID)}{"type":"message","id":"m1","parentId":null,"timestamp":"2024-02-01T00:00:01.000Z"}\n{"type":"message","id":"broken",`,
    );
    const store = new SessionStore({ sessionsRoot: root });

    await expect(store.read({ id: CHILD_ID })).rejects.toThrow(
      /Refusing to read session .* truncated or malformed/,
    );
    await expect(store.read({ id: CHILD_ID })).rejects.toThrow(/line 3/);
    // list() resets the error log, so the refusal evidence is asserted
    // before listing: the file was refused, never served, never listed.
    expect(store.errors).not.toEqual([]);
    const listed = await store.list();
    expect(listed.map((summary) => summary.id)).not.toContain(CHILD_ID);
  });

  it("still reads a nested run whose parent session file is gone", async () => {
    // Decision, stated: the child is self-describing - resolution matches
    // its own header id and never consults the parent file. Retained runs
    // outlive their parents (compaction, retention, manual deletion), so
    // coupling run detail to parent retention would make oversight
    // availability an accident of cleanup. The parent's absence therefore
    // changes nothing: a valid child still reads, and nothing is listed.
    const root = await testRoot();
    await installNestedChild(root, { includeParentFile: false });
    const store = new SessionStore({ sessionsRoot: root });

    await expect(store.read({ id: CHILD_ID })).resolves.toHaveLength(3);
    await expect(store.list()).resolves.toEqual([]);
  });
});
