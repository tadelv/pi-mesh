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
const otherSessionId = "123e4567-e89b-42d3-a456-42661417409a";

function header(id: string): string {
  return `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2024-01-01T00:00:00.000Z",
    cwd: "/stream/project",
  })}\n`;
}

async function makeSession(id = sessionId): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-mesh-stream-"));
  const directory = getSessionStorageDir("/stream/project", root);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "session.jsonl"), header(id));
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

/**
 * Assert that no event arrives. Races against a real event-loop tick rather
 * than Promise.resolve(), so delivery deferred by any same-turn hop (a
 * microtask or setImmediate inside enqueue) is still caught.
 */
async function expectNoEvent(
  pending: Promise<IteratorResult<{ entryId: string }>>,
): Promise<void> {
  const outcome = await Promise.race([
    pending.then(
      () => "event",
      () => "error",
    ),
    new Promise((resolve) => setImmediate(() => resolve("nothing"))),
  ]);
  expect(outcome).toBe("nothing");
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

    const pending = stream.next();
    await appendFile(path, entry("second", "before\u2028after"));
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

    // Exactly one "second": a duplicate would mean the partial line was
    // delivered twice, once before its LF and once after.
    await appendFile(path, `${entry("third")}\n`);
    await stream.poll();
    await expect(stream.next()).resolves.toMatchObject({
      value: { entryId: "third" },
    });
    await stream.stop();
  });

  it("replays strictly after since and then follows", async () => {
    const root = await makeSession();
    const path = sessionPath(root);
    await appendFile(path, `${entry("first")}\n${entry("second")}\n`);
    const stream = sessionStream(
      { id: sessionId, since: "first" },
      { sessionsRoot: root, pollIntervalMs: 60_000 },
    );

    // The boundary entry itself must NOT be re-delivered.
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

  it("does not re-deliver the boundary entry when its line is still half-written", async () => {
    // The blocking finding: `since` named an entry whose line had no LF yet.
    // The boundary entry was absent from the complete-entry snapshot, so the
    // cursor was reset to the snapshot tail - an entry BEFORE the boundary -
    // and when the LF finally arrived the boundary entry itself was delivered,
    // breaking the strictly-after rule.
    const root = await makeSession();
    const path = sessionPath(root);
    await appendFile(path, `${entry("first")}\n${entry("second")}`);
    const stream = sessionStream(
      { id: sessionId, since: "second" },
      { sessionsRoot: root, pollIntervalMs: 60_000 },
    );

    // Nothing may be emitted: "second" is not strictly after "second", and
    // "first" is before the boundary.
    const pending = stream.next();
    await stream.poll();
    await expectNoEvent(pending);

    // Complete the boundary line and append a genuine successor.
    await appendFile(path, `\n${entry("third")}\n`);
    await stream.poll();

    // The still-pending next() must resolve to the successor, never to the
    // boundary entry it was already waiting past.
    await expect(pending).resolves.toMatchObject({
      value: { entryId: "third" },
    });
    await stream.stop();
  });

  it("gives each subscriber its own cursor", async () => {
    // Staggered construction, which the earlier version did not do: both
    // subscribers were built before any entry existed and polled in lockstep,
    // so a module-level shared cursor would have been indistinguishable from
    // per-instance state.
    const root = await makeSession();
    const path = sessionPath(root);
    await appendFile(path, `${entry("first")}\n`);

    const early = sessionStream(
      { id: sessionId },
      { sessionsRoot: root, pollIntervalMs: 60_000 },
    );
    await expect(early.next()).resolves.toMatchObject({
      value: { entryId: "first" },
    });

    await appendFile(path, `${entry("second")}\n`);
    const late = sessionStream(
      { id: sessionId },
      { sessionsRoot: root, pollIntervalMs: 60_000 },
    );

    // The later subscriber starts from the beginning, as the milestone
    // promises; the earlier one is already past "first".
    await expect(late.next()).resolves.toMatchObject({
      value: { entryId: "first" },
    });
    await expect(late.next()).resolves.toMatchObject({
      value: { entryId: "second" },
    });
    // The earlier subscriber only advances on a poll, and has already
    // consumed "first", so it must yield exactly "second".
    await early.poll();
    await expect(early.next()).resolves.toMatchObject({
      value: { entryId: "second" },
    });

    await early.stop();
    await late.stop();
  });

  it("leaves the session file untouched and keeps other subscribers running", async () => {
    const root = await makeSession();
    const path = sessionPath(root);
    await appendFile(path, `${entry("first")}\n`);
    // Baseline captured BEFORE any stream exists, so a mutation during
    // initialize or the first poll would be visible rather than baked in.
    const before = await readFile(path, "utf8");

    const first = sessionStream(
      { id: sessionId },
      { sessionsRoot: root, pollIntervalMs: 60_000 },
    );
    const second = sessionStream(
      { id: sessionId },
      { sessionsRoot: root, pollIntervalMs: 60_000 },
    );
    await Promise.all([first.poll(), second.poll()]);
    await expect(first.next()).resolves.toMatchObject({
      value: { entryId: "first" },
    });
    // Drain second's own initial replay too, or its pending queue entry would
    // satisfy the assertion below instead of the newly appended one.
    await expect(second.next()).resolves.toMatchObject({
      value: { entryId: "first" },
    });

    await first.stop();
    expect(await readFile(path, "utf8")).toEqual(before);

    const pending = second.next();
    await appendFile(path, `${entry("second")}\n`);
    await second.poll();
    await expect(pending).resolves.toMatchObject({
      value: { entryId: "second" },
    });
    await second.stop();
    expect(await readFile(path, "utf8")).toEqual(
      before + `${entry("second")}\n`,
    );
  });

  it("finds a session whose file is not the first one scanned", async () => {
    // findSessionPath's loop was only ever exercised with the match at
    // position 0, because no test had two session files.
    const root = await makeSession(otherSessionId);
    const secondDirectory = getSessionStorageDir("/stream/other", root);
    await mkdir(secondDirectory, { recursive: true });
    await writeFile(join(secondDirectory, "session.jsonl"), header(sessionId));

    const stream = sessionStream(
      { id: sessionId },
      { sessionsRoot: root, pollIntervalMs: 60_000 },
    );
    await stream.stop();

    const other = sessionStream(
      { id: otherSessionId },
      { sessionsRoot: root, pollIntervalMs: 60_000 },
    );
    await other.stop();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "streams a session even when a sibling directory is unreadable",
    async () => {
      // The regression: streaming used to walk the sessions directory itself,
      // without the guards sessions.ts has. One unreadable directory made the
      // whole stream fail, so a single stray directory cost every session.
      const root = await mkdtemp(join(tmpdir(), "pi-mesh-stream-"));
      // Created BEFORE the session directory, so the failing entry is
      // encountered first regardless of readdir ordering. The earlier version
      // created it afterwards and passed for the wrong reason.
      const blocked = join(root, "--aaa-unreadable--");
      await mkdir(blocked, { recursive: true });
      await chmod(blocked, 0o000);

      const directory = getSessionStorageDir("/stream/project", root);
      await mkdir(directory, { recursive: true });
      const path = join(directory, "session.jsonl");
      await writeFile(path, header(sessionId));
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
