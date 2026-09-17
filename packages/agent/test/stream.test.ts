// SPDX-License-Identifier: GPL-3.0-or-later

import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  appendFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSessionStorageDir } from "../src/sessions.js";
import { sessionStream } from "../src/stream.js";

const sessionId = "123e4567-e89b-42d3-a456-426614174099";

async function makeSession(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-mesh-stream-"));
  const directory = getSessionStorageDir("/stream/project", root);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "session.jsonl"),
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2024-01-01T00:00:00.000Z",
      cwd: "/stream/project",
    })}\n`,
  );
  return root;
}

function sessionPath(root: string): string {
  return join(getSessionStorageDir("/stream/project", root), "session.jsonl");
}

function entry(id: string, text = id): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2024-01-01T00:00:01.000Z",
    message: { role: "user", content: text, timestamp: 1 },
  });
}

async function expectNoEvent(
  next: Promise<
    IteratorResult<Awaited<ReturnType<typeof sessionStream>["next"]>>
  >,
): Promise<void> {
  await expect(
    Promise.race([next.then(() => "event"), Promise.resolve("nothing")]),
  ).resolves.toBe("nothing");
}

describe("sessionStream", () => {
  it("withholds a partial LF record and preserves U+2028 in a completed entry", async () => {
    const root = await makeSession();
    const path = sessionPath(root);
    await appendFile(path, `${entry("first")}\n`);
    const stream = sessionStream(
      { id: sessionId },
      { sessionsRoot: root, pollIntervalMs: 60_000 },
    );

    await expect(stream.next()).resolves.toMatchObject({
      value: { entryId: "first" },
      done: false,
    });
    const partial = entry("second", "before\u2028after");
    const pending = stream.next();
    await appendFile(path, partial);
    await stream.poll();
    await expectNoEvent(pending);
    await appendFile(path, "\n");
    await stream.poll();
    await expect(pending).resolves.toMatchObject({
      value: {
        entryId: "second",
        data: { message: { content: "before\u2028after" } },
      },
      done: false,
    });
    await stream.stop();
  });

  it("replays after since and follows strictly after the boundary", async () => {
    const root = await makeSession();
    const path = sessionPath(root);
    await appendFile(path, `${entry("first")}\n${entry("second")}\n`);
    const stream = sessionStream(
      { id: sessionId, since: "first" },
      { sessionsRoot: root, pollIntervalMs: 60_000 },
    );
    await expect(stream.next()).resolves.toMatchObject({
      value: { entryId: "second" },
      done: false,
    });
    const pending = stream.next();
    await appendFile(path, `${entry("third")}\n`);
    await stream.poll();
    await expect(pending).resolves.toMatchObject({
      value: { entryId: "third" },
      done: false,
    });
    await stream.stop();
  });

  it("keeps subscribers independent and never changes the session file on stop", async () => {
    const root = await makeSession();
    const path = sessionPath(root);
    const first = sessionStream(
      { id: sessionId },
      { sessionsRoot: root, pollIntervalMs: 60_000 },
    );
    const second = sessionStream(
      { id: sessionId },
      { sessionsRoot: root, pollIntervalMs: 60_000 },
    );
    await appendFile(path, `${entry("first")}\n`);
    await Promise.all([first.poll(), second.poll()]);
    await expect(first.next()).resolves.toMatchObject({
      value: { entryId: "first" },
      done: false,
    });
    await expect(second.next()).resolves.toMatchObject({
      value: { entryId: "first" },
      done: false,
    });

    const before = await readFile(path);
    await first.stop();
    expect(await readFile(path)).toEqual(before);
    const pending = second.next();
    await appendFile(path, `${entry("second")}\n`);
    await second.poll();
    await expect(pending).resolves.toMatchObject({
      value: { entryId: "second" },
      done: false,
    });
    await second.stop();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "streams a session even when a sibling directory is unreadable",
    async () => {
      // The regression: streaming used to walk the sessions directory itself,
      // without the guards sessions.ts has. One unreadable directory made the
      // whole stream fail, so a single stray directory cost every session.
      const root = await makeSession();
      const path = sessionPath(root);
      const blocked = join(root, "--aaa-unreadable--");
      await mkdir(blocked, { recursive: true });
      await chmod(blocked, 0o000);
      await appendFile(path, `${entry("first")}\n`);

      try {
        const stream = sessionStream(
          { id: sessionId },
          { sessionsRoot: root, pollIntervalMs: 60_000 },
        );
        await expect(stream.next()).resolves.toMatchObject({
          value: { entryId: "first" },
          done: false,
        });
        await stream.stop();
      } finally {
        await chmod(blocked, 0o700);
      }
    },
  );
});
