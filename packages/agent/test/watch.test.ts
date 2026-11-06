// SPDX-License-Identifier: GPL-3.0-or-later

import {
  mkdir,
  mkdtemp,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WatchFrame } from "@pi-mesh/protocol";
import {
  createAgentServer,
  createSkillRegistry,
  getSessionStorageDir,
  servedSkills,
  SessionStore,
  SessionWatch,
  signedHeaders,
  type SessionWatchOptions,
} from "../src/index.js";

const sessionIdA = "123e4567-e89b-42d3-a456-426614174001";
const sessionIdB = "123e4567-e89b-42d3-a456-426614174002";
const sessionIdC = "123e4567-e89b-42d3-a456-426614174003";
const testIdentity = {
  peerId: "22222222-2222-4222-8222-222222222222",
  name: "test",
};
const testKey = Buffer.from("pi-mesh-vector-key-0123456789abc");

const HUGE_INTERVAL = 3_600_000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function headerLine(id: string, timestamp: string, cwd: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp,
    cwd,
  });
}

function infoLine(id: string, timestamp: string, name: string): string {
  return JSON.stringify({
    type: "session_info",
    id,
    parentId: null,
    timestamp,
    name,
  });
}

function messageLine(id: string, timestamp: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: { role: "user", content: text },
  });
}

function sessionContent(
  id: string,
  name: string,
  updatedAt: string,
  secret: string,
): string {
  return (
    `${headerLine(id, "2024-01-01T00:00:00.000Z", "/fixture/project")}\n` +
    `${infoLine("info-1", "2024-01-01T00:00:01.000Z", name)}\n` +
    `${messageLine("entry-1", updatedAt, secret)}\n`
  );
}

async function testRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-mesh-watch-"));
}

async function projectDir(root: string, project: string): Promise<string> {
  const directory = getSessionStorageDir(project, root);
  await mkdir(directory, { recursive: true });
  return directory;
}

function watchOptions(
  root: string,
  overrides: Partial<SessionWatchOptions> = {},
): SessionWatchOptions {
  return {
    sessionsRoot: root,
    pollIntervalMs: HUGE_INTERVAL,
    reconcileIntervalMs: HUGE_INTERVAL,
    ...overrides,
  };
}

/**
 * A reader that never strands a waiter: the pending next() promise is kept
 * and reused, so a quiet window does not swallow the frame that arrives
 * just after it.
 */
class Reader {
  private pending: Promise<IteratorResult<WatchFrame>> | undefined;

  constructor(private readonly watch: SessionWatch) {}

  private take(): Promise<IteratorResult<WatchFrame>> {
    const current = this.pending ?? this.watch.next();
    this.pending = undefined;
    return current;
  }

  async next(label: string, milliseconds = 5_000): Promise<WatchFrame> {
    const result = await Promise.race([
      this.take(),
      sleep(milliseconds).then(
        (): IteratorResult<WatchFrame> => {
          throw new Error(`${label}: no frame arrived within ${milliseconds}ms`);
        },
      ),
    ]);
    if (result.done) throw new Error(`${label}: the watch ended early`);
    return result.value;
  }

  /** Assert no frame arrives within the window; keep waiting on the same promise. */
  async quiet(milliseconds: number, label: string): Promise<void> {
    const current = this.pending ?? this.watch.next();
    const winner = await Promise.race([
      current.then(() => "frame" as const),
      sleep(milliseconds).then(() => "timeout" as const),
    ]);
    if (winner === "frame") {
      const result = await current;
      throw new Error(
        `${label}: unexpected frame ${JSON.stringify(result.value)}`,
      );
    }
    this.pending = current;
  }
}

async function startWatch(
  root: string,
  overrides: Partial<SessionWatchOptions> = {},
): Promise<{ watch: SessionWatch; reader: Reader }> {
  const watch = new SessionWatch(watchOptions(root, overrides));
  const reader = new Reader(watch);
  try {
    const first = await reader.next("watch bootstrap: the snapshot frame");
    if (first.type !== "snapshot") {
      throw new Error(
        `watch bootstrap: first frame must be a snapshot, saw ${first.type}`,
      );
    }
    return { watch, reader };
  } catch (error) {
    await watch.stop();
    throw error;
  }
}

describe("mesh.watch inventory deltas", () => {
  it("watch clause added: a new session emits exactly one added frame with its summary", async () => {
    const root = await testRoot();
    const directory = await projectDir(root, "/fixture/project");
    const { watch, reader } = await startWatch(root);
    try {
      const secret = "the secret transcript text must never leak";
      await writeFile(
        join(directory, "a.jsonl"),
        sessionContent(sessionIdA, "alpha", "2024-01-01T00:00:02.000Z", secret),
      );
      await watch.poll();
      const frame = await reader.next(
        "watch clause added: the added frame for the new session",
      );
      expect(frame.type).toBe("added");
      if (frame.type !== "added") throw new Error("unreachable");
      expect(frame.session.id).toBe(sessionIdA);
      expect(frame.session.name).toBe("alpha");
      // Inventory facts only: no entries cursor and no transcript content.
      expect(frame).not.toHaveProperty("entries");
      expect(JSON.stringify(frame)).not.toContain(secret);
      await reader.quiet(
        200,
        "watch clause added: exactly one added frame, never a duplicate",
      );
    } finally {
      await watch.stop();
    }
  });

  it("watch clause updated: an append emits an updated frame for the same session", async () => {
    const root = await testRoot();
    const directory = await projectDir(root, "/fixture/project");
    const path = join(directory, "a.jsonl");
    await writeFile(
      path,
      sessionContent(sessionIdA, "alpha", "2024-01-01T00:00:02.000Z", "first"),
    );
    const { watch, reader } = await startWatch(root);
    try {
      await reader.quiet(
        100,
        "watch clause updated: nothing present at connect is reported as added",
      );
      await writeFile(
        path,
        sessionContent(sessionIdA, "alpha", "2024-01-01T00:00:09.000Z", "first") +
          messageLine("entry-2", "2024-01-01T00:00:09.000Z", "second"),
      );
      await watch.poll();
      const frame = await reader.next(
        "watch clause updated: the updated frame for the appended session",
      );
      expect(frame.type).toBe("updated");
      if (frame.type !== "updated") throw new Error("unreachable");
      expect(frame.session.id).toBe(sessionIdA);
      expect(frame.session.updated_at).toBe("2024-01-01T00:00:09.000Z");
      expect(JSON.stringify(frame)).not.toContain("second");
    } finally {
      await watch.stop();
    }
  });

  it("watch clause removed: deleting a session emits a removed frame", async () => {
    const root = await testRoot();
    const directory = await projectDir(root, "/fixture/project");
    const path = join(directory, "a.jsonl");
    await writeFile(
      path,
      sessionContent(sessionIdA, "alpha", "2024-01-01T00:00:02.000Z", "first"),
    );
    const { watch, reader } = await startWatch(root);
    try {
      await unlink(path);
      await watch.poll();
      const frame = await reader.next(
        "watch clause removed: the removed frame for the deleted session",
      );
      expect(frame).toEqual({ type: "removed", id: sessionIdA });
    } finally {
      await watch.stop();
    }
  });

  it("watch clause rename: a renamed file emits no removed frame and keeps the session id", async () => {
    const root = await testRoot();
    const from = await projectDir(root, "/fixture/project");
    const to = await projectDir(root, "/other/project");
    const oldPath = join(from, "a.jsonl");
    const newPath = join(to, "renamed.jsonl");
    await writeFile(
      oldPath,
      sessionContent(sessionIdA, "alpha", "2024-01-01T00:00:02.000Z", "first"),
    );
    const { watch, reader } = await startWatch(root);
    try {
      await rename(oldPath, newPath);
      await watch.poll();
      // A moved file is not a deleted session: the id reconciliation must not
      // report a removal. The positive control below proves the watch still
      // tracks the session at its new path.
      await reader.quiet(
        300,
        "watch clause rename: no removed frame for a renamed session file",
      );
      await writeFile(
        newPath,
        sessionContent(sessionIdA, "alpha", "2024-01-01T00:00:09.000Z", "first") +
          messageLine("entry-2", "2024-01-01T00:00:09.000Z", "second"),
      );
      await watch.poll();
      const frame = await reader.next(
        "watch clause rename: the renamed session still reports under the same id",
      );
      expect(frame.type).toBe("updated");
      if (frame.type !== "updated") throw new Error("unreachable");
      expect(frame.session.id).toBe(sessionIdA);
    } finally {
      await watch.stop();
    }
  });

  it("watch clause truncation: truncating to zero and regrowing repairs the summary without duplicating", async () => {
    const root = await testRoot();
    const directory = await projectDir(root, "/fixture/project");
    const path = join(directory, "a.jsonl");
    await writeFile(
      path,
      sessionContent(sessionIdA, "alpha", "2024-01-01T00:00:02.000Z", "first"),
    );
    const skipped: string[] = [];
    const { watch, reader } = await startWatch(root, {
      onError: (error) => skipped.push(error.message),
    });
    const seen: WatchFrame[] = [];
    try {
      await writeFile(path, "");
      await watch.poll();
      // A truncated file with no complete header is skipped with a stated
      // reason: never a removal, never an empty session, never a duplicate.
      await reader.quiet(
        300,
        "watch clause truncation: a truncated file emits no removed and no empty session",
      );
      expect(
        skipped.some((message) => message.includes("no complete header")),
        "watch clause truncation: the skip states its reason",
      ).toBe(true);
      await writeFile(
        path,
        sessionContent(sessionIdA, "beta", "2024-01-01T00:00:09.000Z", "first"),
      );
      await watch.poll();
      const frame = await reader.next(
        "watch clause truncation: the regrown session is repaired",
      );
      seen.push(frame);
      expect(frame.type).toBe("updated");
      if (frame.type !== "updated") throw new Error("unreachable");
      expect(frame.session.id).toBe(sessionIdA);
      expect(frame.session.name).toBe("beta");
      expect(
        seen.filter(
          (entry) =>
            (entry.type === "added" || entry.type === "updated") &&
            entry.session.id === sessionIdA,
        ),
      ).toHaveLength(1);
    } finally {
      await watch.stop();
    }
  });

  it("watch clause clock: a backwards mtime is still detected as a change", async () => {
    const root = await testRoot();
    const directory = await projectDir(root, "/fixture/project");
    const path = join(directory, "a.jsonl");
    const before =
      sessionContent(sessionIdA, "alpha", "2024-01-01T00:00:02.000Z", "first");
    // Same byte length, different summary: only a metadata inequality can
    // notice this rewrite, and the mtime steps backwards.
    const after = before.replace("alpha", "alphb");
    expect(after).not.toBe(before);
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    await writeFile(path, before);
    const { watch, reader } = await startWatch(root);
    try {
      await writeFile(path, after);
      const past = new Date(Date.now() - 120_000);
      await utimes(path, past, past);
      await watch.poll();
      const frame = await reader.next(
        "watch clause clock: the backwards-mtime rewrite is still detected",
      );
      expect(frame.type).toBe("updated");
      if (frame.type !== "updated") throw new Error("unreachable");
      expect(frame.session.id).toBe(sessionIdA);
      expect(frame.session.name).toBe("alphb");
    } finally {
      await watch.stop();
    }
  });

  it("watch clause reconciliation: a change the index missed is repaired by the periodic pass", async () => {
    const root = await testRoot();
    const directory = await projectDir(root, "/fixture/project");
    const path = join(directory, "a.jsonl");
    await writeFile(
      path,
      sessionContent(sessionIdA, "alpha", "2024-01-01T00:00:02.000Z", "first"),
    );
    const realStat = async (target: string): Promise<{ mtimeMs: number; size: number }> => {
      const value = await stat(target);
      return { mtimeMs: value.mtimeMs, size: value.size };
    };
    // Frozen metadata simulates a change the fast path never sees (a
    // same-size rewrite inside one timestamp tick, a dropped stat).
    const frozen = new Map<string, { mtimeMs: number; size: number }>();
    const { watch, reader } = await startWatch(root, {
      stat: async (target: string) => frozen.get(target) ?? realStat(target),
    });
    try {
      frozen.set(path, await realStat(path));
      await writeFile(
        path,
        sessionContent(sessionIdA, "alpha", "2024-01-01T00:00:09.000Z", "first") +
          messageLine("entry-2", "2024-01-01T00:00:09.000Z", "second"),
      );
      await watch.poll();
      await reader.quiet(
        300,
        "watch clause reconciliation: the frozen index observes no change",
      );
      frozen.delete(path);
      await watch.reconcile();
      const frame = await reader.next(
        "watch clause reconciliation: the periodic pass repairs the missed change",
      );
      expect(frame.type).toBe("updated");
      if (frame.type !== "updated") throw new Error("unreachable");
      expect(frame.session.id).toBe(sessionIdA);
      expect(frame.session.updated_at).toBe("2024-01-01T00:00:09.000Z");
    } finally {
      await watch.stop();
    }
  });

  it("watch clause bound: an overflowing buffer drops with a stated dropped frame, never silently", async () => {
    const root = await testRoot();
    const directory = await projectDir(root, "/fixture/project");
    const { watch, reader } = await startWatch(root, {
      maxBufferedFrames: 2,
    });
    try {
      // No consumer is reading: three bursts against a buffer of two must
      // overflow, and the overflow must say so.
      await writeFile(
        join(directory, "a.jsonl"),
        sessionContent(sessionIdA, "alpha", "2024-01-01T00:00:02.000Z", "a"),
      );
      await writeFile(
        join(directory, "b.jsonl"),
        sessionContent(sessionIdB, "beta", "2024-01-01T00:00:02.000Z", "b"),
      );
      await writeFile(
        join(directory, "c.jsonl"),
        sessionContent(sessionIdC, "gamma", "2024-01-01T00:00:02.000Z", "c"),
      );
      await watch.poll();
      const first = await reader.next(
        "watch clause bound: a frame arrives after the burst",
      );
      const second = await reader.next(
        "watch clause bound: the buffer holds at most its bound",
      );
      await reader.quiet(
        200,
        "watch clause bound: nothing beyond the bound was retained",
      );
      const frames = [first, second];
      const dropped = frames.find((frame) => frame.type === "dropped");
      expect(
        dropped,
        "watch clause bound: the overflow states itself with a dropped frame",
      ).toBeDefined();
      if (dropped?.type !== "dropped") throw new Error("unreachable");
      expect(dropped.dropped).toBeGreaterThanOrEqual(1);
      expect(dropped.reason.length).toBeGreaterThan(0);
    } finally {
      await watch.stop();
    }
  });
});

describe("mesh.watch serving", () => {
  function watchCall(input: unknown): Record<string, unknown> {
    return {
      jsonrpc: "2.0",
      id: 1,
      method: "message/stream",
      params: {
        message: {
          messageId: "message-1",
          role: "ROLE_USER",
          parts: [{ data: { skill: "mesh.watch", input } }],
        },
      },
    };
  }

  async function postStream(
    port: number,
    key: Uint8Array,
    peerId: string,
    recipientPeerId: string,
    body: unknown,
  ): Promise<{ status: number; text: string }> {
    const text = JSON.stringify(body);
    const headers = signedHeaders(
      key,
      { peerId, name: "test" },
      { method: "POST", path: "/", recipientPeerId, body: text },
    );
    return new Promise((resolve, reject) => {
      const client = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/",
          headers: {
            "A2A-Version": "1.0",
            "content-type": "application/json",
            connection: "close",
            ...headers,
          },
        },
        (response) => {
          let payload = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (payload += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, text: payload }),
          );
        },
      );
      client.on("error", reject);
      client.end(text);
    });
  }

  async function* openWatch(
    port: number,
    recipientPeerId: string,
  ): AsyncGenerator<Record<string, unknown>> {
    const text = JSON.stringify(watchCall({}));
    const headers = signedHeaders(
      testKey,
      testIdentity,
      { method: "POST", path: "/", recipientPeerId, body: text },
    );
    const client = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/",
      headers: {
        "A2A-Version": "1.0",
        "content-type": "application/json",
        connection: "keep-alive",
        ...headers,
      },
    });
    const response = await new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        client.once("response", resolve);
        client.once("error", reject);
        client.end(text);
      },
    );
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error(
        `mesh.watch returned HTTP ${response.statusCode ?? "unknown"}`,
      );
    }
    response.setEncoding("utf8");
    let buffer = "";
    try {
      for await (const chunk of response) {
        buffer += chunk;
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const record = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = record
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (data.length > 0)
            yield JSON.parse(data) as Record<string, unknown>;
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      response.destroy();
      client.destroy();
    }
  }

  function resultOf(frame: Record<string, unknown>): unknown {
    const message = frame.message as
      | { parts?: { data?: { result?: unknown } }[] }
      | undefined;
    return message?.parts?.[0]?.data?.result;
  }

  it("watch clause auth: the skill is refused for a caller that is not paired", async () => {
    const root = await testRoot();
    await projectDir(root, "/fixture/project");
    const serverIdentity = {
      peerId: "11111111-1111-4111-8111-111111111111",
      name: "server",
    };
    const server = createAgentServer({
      host: "127.0.0.1",
      port: 0,
      sessionsRoot: root,
      swarmKey: testKey,
      identity: serverIdentity,
    });
    const address = await server.start();
    try {
      const wrongKey = Buffer.alloc(32, 1);
      const response = await postStream(
        address.port,
        wrongKey,
        testIdentity.peerId,
        serverIdentity.peerId,
        watchCall({}),
      );
      expect(response.status).toBe(200);
      expect(
        (JSON.parse(response.text) as { error: { code: number } }).error.code,
      ).toBe(-32100);
    } finally {
      await server.stop();
    }
  });

  it("watch clause input: a session id is refused, and an unknown layout names itself", async () => {
    const root = await testRoot();
    await projectDir(root, "/fixture/project");
    const serverIdentity = {
      peerId: "11111111-1111-4111-8111-111111111111",
      name: "server",
    };
    const server = createAgentServer({
      host: "127.0.0.1",
      port: 0,
      sessionsRoot: root,
      swarmKey: testKey,
      identity: serverIdentity,
    });
    const address = await server.start();
    try {
      const withId = await postStream(
        address.port,
        testKey,
        testIdentity.peerId,
        serverIdentity.peerId,
        watchCall({ id: sessionIdA }),
      );
      expect(
        (JSON.parse(withId.text) as { error: { code: number; message: string } })
          .error,
      ).toMatchObject({ code: -32602 });
    } finally {
      await server.stop();
    }

    const missing = join(root, "no-such-sessions-root");
    const unrecognised = createAgentServer({
      host: "127.0.0.1",
      port: 0,
      sessionsRoot: missing,
      swarmKey: testKey,
      identity: serverIdentity,
    });
    const unrecognisedAddress = await unrecognised.start();
    try {
      const response = await postStream(
        unrecognisedAddress.port,
        testKey,
        testIdentity.peerId,
        serverIdentity.peerId,
        watchCall({}),
      );
      const error = (
        JSON.parse(response.text) as { error: { code: number; message: string } }
      ).error;
      expect(error.code).toBe(-32004);
      expect(error.message).toMatch(/recognised session layout/);
    } finally {
      await unrecognised.stop();
    }
  });

  it("watch clause serving: the card advertises mesh.watch exactly where the session layout is recognised", async () => {
    const root = await testRoot();
    await projectDir(root, "/fixture/project");
    const serverIdentity = {
      peerId: "11111111-1111-4111-8111-111111111111",
      name: "server",
    };
    const recognised = createAgentServer({
      host: "127.0.0.1",
      port: 0,
      sessionsRoot: root,
      // Pin the runs scan root to an empty dir: this clause is about the
      // session layout, and the real temp dir is machine state.
      runsTmp: root,
      swarmKey: testKey,
      identity: serverIdentity,
    });
    await recognised.start();
    try {
      const card = recognised.agentCard();
      expect(card.skills.map((skill) => skill.id)).toContain("mesh.watch");
      expect(card.skills.map((skill) => skill.id).sort()).toEqual(
        [...servedSkills(false, false, false, true)].sort(),
      );
    } finally {
      await recognised.stop();
    }

    const unrecognised = createAgentServer({
      host: "127.0.0.1",
      port: 0,
      sessionsRoot: join(root, "no-such-sessions-root"),
      swarmKey: testKey,
      identity: serverIdentity,
    });
    await unrecognised.start();
    try {
      expect(
        unrecognised.agentCard().skills.map((skill) => skill.id),
      ).not.toContain("mesh.watch");
    } finally {
      await unrecognised.stop();
    }

    // The unary path refuses with the streaming answer, never a gate refusal:
    // watching is not executing, so the dispatch gate is untouched.
    const registry = createSkillRegistry({ sessionsRoot: root });
    await expect(registry.invoke("mesh.watch", {})).rejects.toMatchObject({
      code: -32004,
      message: expect.stringMatching(/requires message\/stream/),
    });
    const bare = createSkillRegistry({
      sessionsRoot: join(root, "no-such-sessions-root"),
    });
    await expect(bare.invoke("mesh.watch", {})).rejects.toMatchObject({
      code: -32004,
      message: expect.stringMatching(/recognised session layout/),
    });
  });

  it("discriminating: an added session arrives on the open watch with no list fallback", async () => {
    const root = await testRoot();
    const directory = await projectDir(root, "/fixture/project");
    const serverIdentity = {
      peerId: "11111111-1111-4111-8111-111111111111",
      name: "server",
    };
    const server = createAgentServer({
      host: "127.0.0.1",
      port: 0,
      sessionsRoot: root,
      swarmKey: testKey,
      identity: serverIdentity,
      watchPollIntervalMs: 50,
      watchReconcileIntervalMs: HUGE_INTERVAL,
    });
    const address = await server.start();
    // The sync and list fallbacks are forbidden for the duration: the watch's
    // own bootstrap is the single permitted listing. With the delta path
    // deleted, the added frame below never arrives and this fails by name -
    // not by timeout naming something else.
    const listSpy = vi.spyOn(SessionStore.prototype, "list");
    try {
      const frames = openWatch(address.port, serverIdentity.peerId);
      const taskFrame = await frames.next();
      expect(taskFrame.done).toBe(false);
      const snapshotFrame = await frames.next();
      expect(snapshotFrame.done).toBe(false);
      expect(
        (resultOf(snapshotFrame.value as Record<string, unknown>) as { type?: string })
          ?.type,
      ).toBe("snapshot");

      const secret = "a named session created after the watch opened";
      await writeFile(
        join(directory, "named.jsonl"),
        sessionContent(
          sessionIdA,
          "named-session",
          "2024-01-01T00:00:02.000Z",
          secret,
        ),
      );
      let added: unknown;
      // Below the harness timeout by design (GOTCHAS): a bound above it
      // would die as a generic harness timeout instead of this named clause.
      const deadline = Date.now() + 3_000;
      for (;;) {
        const next = await Promise.race([
          frames.next(),
          sleep(Math.max(1, deadline - Date.now())).then(
            (): AsyncIteratorResult<Record<string, unknown>> => {
              throw new Error(
                "discriminating: the added session never arrived on the open watch",
              );
            },
          ),
        ]);
        if (next.done) {
          throw new Error(
            "discriminating: the watch ended before the added session arrived",
          );
        }
        const result = resultOf(next.value) as { type?: string } | undefined;
        if (result?.type === "added") {
          added = result;
          break;
        }
      }
      expect((added as { session: { id: string; name: string } }).session).toMatchObject({
        id: sessionIdA,
        name: "named-session",
      });
      expect(JSON.stringify(added)).not.toContain(secret);
      // Bootstrap only: no sync, no second list, no fallback for the duration.
      expect(listSpy.mock.calls).toHaveLength(1);
      await frames.return?.(undefined);
    } finally {
      listSpy.mockRestore();
      await server.stop();
    }
  });
});
