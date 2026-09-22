// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { Event, StreamResponse } from "@pi-mesh/protocol";
import { describe, expect, it } from "vitest";
import {
  createAgentServer,
  createPiSpawner,
  createSkillRegistry,
  getSessionStorageDir,
  JobManager,
  parseSpawnPolicy,
  resolvePiBinary,
  sendSkill,
  signedHeaders,
  type PeerRecord,
} from "../src/index.js";

const sessionId = "123e4567-e89b-42d3-a456-426614174099";
const key = Buffer.from("pi-mesh-vector-key-0123456789abc");
const serverIdentity = {
  peerId: "11111111-1111-4111-8111-111111111111",
  name: "server",
};
const deniedIdentity = {
  peerId: "22222222-2222-4222-8222-222222222222",
  name: "denied-peer",
};
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ADR 0009 defines `source` as the new discriminator but does not replace the
// existing wire payload: file streaming currently puts Event.data in the A2A
// result, while live streaming puts the raw Pi RPC event there.
type StreamFrame = {
  id?: unknown;
  type?: unknown;
  source?: unknown;
  entryId?: unknown;
  assistantMessageEvent?: {
    type?: unknown;
    delta?: unknown;
    contentDelta?: unknown;
  };
};

type RunningTest = {
  jobs: JobManager;
  jobId: string;
  marker: string;
  peer: PeerRecord;
  port: number;
  stop: () => Promise<void>;
};

function options() {
  return { swarmKey: key, identity: deniedIdentity, timeoutMs: 5_000 };
}

function peer(port: number): PeerRecord {
  return {
    id: serverIdentity.peerId,
    name: serverIdentity.name,
    serviceType: "mesh",
    host: "127.0.0.1",
    port,
    txt: {},
    lastSeen: Date.now(),
  };
}

function streamBody(id: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "message/stream",
    params: {
      message: {
        messageId: "message-1",
        role: "ROLE_USER",
        parts: [{ data: { skill: "session.stream", input: { id } } }],
      },
    },
  });
}

/** Drive the SSE route with the signed loopback HTTP pattern from server.test.ts. */
async function* streamFrames(
  port: number,
  id: string,
): AsyncGenerator<StreamResponse> {
  const body = streamBody(id);
  const headers = signedHeaders(key, deniedIdentity, {
    method: "POST",
    path: "/",
    recipientPeerId: serverIdentity.peerId,
    body,
  });
  const client = request({
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
  });
  const response = await new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => {
      client.once("response", resolve);
      client.once("error", reject);
      client.end(body);
    },
  );
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`session.stream returned HTTP ${response.statusCode}`);
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
        if (data.length > 0) yield JSON.parse(data) as StreamResponse;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") throw error;
  } finally {
    response.destroy();
    client.destroy();
  }
}

function eventFromFrame(frame: StreamResponse): StreamFrame | undefined {
  const result = (
    frame.message?.parts[0]?.data as { result?: unknown } | undefined
  )?.result;
  return result !== null && typeof result === "object"
    ? (result as StreamFrame)
    : undefined;
}

function isTextDelta(frame: StreamFrame): boolean {
  return (
    frame.type === "message_update" &&
    frame.assistantMessageEvent?.type === "text_delta"
  );
}

function deltaText(frame: StreamFrame): unknown {
  return (
    frame.assistantMessageEvent?.delta ??
    frame.assistantMessageEvent?.contentDelta
  );
}

function nextWithDeadline<T>(
  iterator: AsyncIterator<T>,
  label: string,
  milliseconds = 5_000,
): Promise<IteratorResult<T>> {
  return Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`${label} did not settle within ${milliseconds}ms`)),
        milliseconds,
      ),
    ),
  ]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function stubSource(marker: string): string {
  return `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let input = "";
const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const response = (id, value = {}) => write({ type: "response", id, ...value });
const delta = (text, padding = "") => write({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta: text, padding },
});
const settle = () => {
  writeFileSync(${JSON.stringify(marker)}, "settled");
  write({ type: "turn_end" });
  write({ type: "agent_settled" });
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline = input.indexOf("\\n");
  while (newline !== -1) {
    const line = input.slice(0, newline).replace(/\\r$/, "");
    input = input.slice(newline + 1);
    if (line) {
      const command = JSON.parse(line);
      if (command.type === "get_state") {
        response(command.id, {
          command: "get_state",
          success: true,
          data: { sessionId: ${JSON.stringify(sessionId)}, sessionFile: process.cwd() + "/session.jsonl" },
        });
      } else if (command.type === "prompt") {
        response(command.id, { success: true, accepted: true });
        write({ type: "turn_start" });
        if (command.message === "bounded history") {
          for (let index = 0; index < 300; index += 1) {
            delta("history-" + index, "x".repeat(400));
          }
          process.stderr.write("history-ready\\n");
          setTimeout(() => delta("live-tail"), 1000);
          setTimeout(settle, 1500);
        } else {
          setTimeout(() => delta("first-live-delta"), 30);
          setTimeout(() => delta("second-live-delta"), 60);
          setTimeout(settle, 1000);
        }
      } else {
        response(command.id, { success: false, error: "unsupported command" });
      }
    }
    newline = input.indexOf("\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;
}

async function startStub(prompt: string): Promise<RunningTest> {
  const parent = await mkdtemp(join(tmpdir(), "pi-mesh-live-"));
  const root = join(parent, "workspace");
  const cwd = join(root, "project");
  const sessionsRoot = join(parent, "sessions");
  const marker = join(parent, "settled");
  const binary = join(parent, "pi-stub.mjs");
  await mkdir(cwd, { recursive: true });
  await writeFile(binary, stubSource(marker));
  await chmod(binary, 0o755);

  const jobs = new JobManager({
    spawnJob: createPiSpawner({
      workspaceRoot: root,
      piBinary: binary,
      sessionsRoot,
      logger,
    }),
    logger,
    unacknowledgedTtlMs: 60_000,
  });
  const skills = createSkillRegistry({ jobs, workspaceRoot: root });
  const server = createAgentServer({
    host: "127.0.0.1",
    port: 0,
    swarmKey: key,
    identity: serverIdentity,
    sessionsRoot,
    skillRegistry: skills,
    jobs,
    spawnPolicy: parseSpawnPolicy(undefined, undefined),
  });
  const address = await server.start();
  const started = (await skills.invoke("process.spawn", {
    project: "test",
    cwd,
    prompt,
    _peerId: deniedIdentity.peerId,
  })) as { job_id: string; session_id: string };
  expect(started.session_id).toBe(sessionId);
  jobs.acknowledge(started.job_id);

  return {
    jobs,
    jobId: started.job_id,
    marker,
    peer: peer(address.port),
    port: address.port,
    stop: async () => {
      await server.stop();
      await jobs.shutdown();
    },
  };
}

async function collectUntil(
  iterator: AsyncIterator<StreamResponse>,
  predicate: (event: StreamFrame, events: StreamFrame[]) => boolean,
  label: string,
  milliseconds = 5_000,
): Promise<StreamFrame[]> {
  const events: StreamFrame[] = [];
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    let result: IteratorResult<StreamResponse>;
    try {
      result = await nextWithDeadline(
        iterator,
        label,
        Math.max(1, deadline - Date.now()),
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("did not settle")) {
        return events;
      }
      throw error;
    }
    if (result.done) return events;
    const event = eventFromFrame(result.value);
    if (event === undefined) continue;
    events.push(event);
    if (predicate(event, events)) return events;
  }
  throw new Error(`${label}: deadline elapsed`);
}

async function writeDurableSession(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-mesh-live-file-"));
  const directory = getSessionStorageDir("/fixture/project", root);
  await mkdir(directory, { recursive: true });
  const rows = [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2025-01-01T00:00:00.000Z",
      cwd: "/fixture/project",
    },
    {
      type: "message",
      id: "file-entry-1",
      parentId: null,
      timestamp: "2025-01-01T00:00:01.000Z",
      message: { role: "user", content: "first" },
    },
    {
      type: "message",
      id: "file-entry-2",
      parentId: "file-entry-1",
      timestamp: "2025-01-01T00:00:02.000Z",
      message: { role: "assistant", content: "second" },
    },
  ];
  await writeFile(
    join(directory, "session.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  return root;
}

describe("M2-11 live session streaming", () => {
  it("streams two live deltas before settlement, without a cursor, to an execution-denied peer", async () => {
    const running = await startStub("live ordering");
    const iterator = streamFrames(running.port, sessionId);
    try {
      await expect(
        sendSkill(
          running.peer,
          "process.spawn",
          { project: "test", prompt: "must be denied" },
          options(),
        ),
      ).rejects.toMatchObject({ code: -32102 });

      const events = await collectUntil(
        iterator,
        (_event, seen) => seen.filter(isTextDelta).length === 2,
        "missing observation: two text_delta frames while the turn was running",
      );
      const deltas = events.filter(isTextDelta);
      expect(
        deltas.map(deltaText),
        "missing observation: the two distinct text deltas",
      ).toEqual(["first-live-delta", "second-live-delta"]);
      expect(
        deltas.every((event) => event.source === "live"),
        'missing observation: source: "live" on both deltas',
      ).toBe(true);
      expect(
        deltas.every((event) => !("entryId" in event)),
        "live frames must not promise entryId resumption",
      ).toBe(true);
      expect(
        await exists(running.marker),
        "missing observation: both deltas before turn_end/agent_settled",
      ).toBe(false);
      expect(
        running.jobs.get(running.jobId)?.state,
        "missing observation: the process still running after the second delta",
      ).toBe("running");
    } finally {
      await iterator.return?.(undefined);
      await running.stop();
    }
  });

  it("replays a bounded recent ring before the live tail for a mid-turn subscriber", async () => {
    const running = await startStub("bounded history");
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (running.jobs.output(running.jobId).includes("history-ready\n"))
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(running.jobs.output(running.jobId)).toContain("history-ready\n");

      const iterator = streamFrames(running.port, sessionId);
      try {
        const events = await collectUntil(
          iterator,
          (event) => deltaText(event) === "live-tail",
          "bounded replay followed by the live tail",
          3_000,
        );
        const deltas = events.filter(isTextDelta);
        const tailIndex = deltas.findIndex(
          (event) => deltaText(event) === "live-tail",
        );
        const replay = deltas.slice(0, tailIndex);
        expect(
          tailIndex,
          "missing live tail after bounded replay",
        ).toBeGreaterThan(0);
        expect(
          replay.length,
          "the 256-event cap must bound replay",
        ).toBeLessThanOrEqual(256);
        expect(
          replay.reduce(
            (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)),
            0,
          ),
          "the 64 KiB cap must bound replay",
        ).toBeLessThanOrEqual(64 * 1024);
        expect(
          replay.length,
          "a late subscriber must receive recent history",
        ).toBeGreaterThan(0);
        expect(
          replay.some((event) => deltaText(event) === "history-0"),
          "the bounded ring must drop old history",
        ).toBe(false);
        expect(deltas.every((event) => event.source === "live")).toBe(true);
      } finally {
        await iterator.return?.(undefined);
      }
    } finally {
      await running.stop();
    }
  });

  it("keeps non-live sessions on resumable source: file frames", async () => {
    const sessionsRoot = await writeDurableSession();
    const server = createAgentServer({
      host: "127.0.0.1",
      port: 0,
      swarmKey: key,
      identity: serverIdentity,
      sessionsRoot,
      spawnPolicy: parseSpawnPolicy(undefined, undefined),
    });
    const address = await server.start();
    const remote = peer(address.port);
    const iterator = streamFrames(address.port, sessionId);
    try {
      const events = await collectUntil(
        iterator,
        (event) =>
          event.entryId === "file-entry-1" || event.id === "file-entry-1",
        'missing observation: source: "file" frame with entryId cursor',
      );
      expect(events.at(-1)).toMatchObject({
        source: "file",
        id: "file-entry-1",
      });

      const resumed = (await sendSkill(
        remote,
        "session.read",
        { id: sessionId, since: "file-entry-1" },
        options(),
      )) as { entries: Event[] };
      expect(resumed.entries.map((event) => event.entryId)).toEqual([
        "file-entry-2",
      ]);
    } finally {
      await iterator.return?.(undefined);
      await server.stop();
    }
  });

  let realPi: string | undefined;
  try {
    realPi = resolvePiBinary();
  } catch {
    realPi = undefined;
  }

  // A real turn needs real model credentials, and a runner without them does not
  // fail fast: the child hangs until the test timeout, and it writes a template
  // auth.json into HOME on the way, so a suite that is supposed to touch nothing
  // leaves files behind. Guard on the credentials too, not only the binary.
  const piAgentDir =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const hasPiCredentials = existsSync(join(piAgentDir, "auth.json"));

  it.skipIf(realPi === undefined || !hasPiCredentials)(
    "delivers multiple real-Pi text deltas before the real turn settles or exits",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "pi-mesh-live-real-"));
      const root = join(parent, "workspace");
      const cwd = join(root, "project");
      const sessionsRoot = join(parent, "sessions");
      const marker = join(parent, "settled");
      const wrapper = join(parent, "pi-observer.mjs");
      await mkdir(cwd, { recursive: true });
      await writeFile(
        wrapper,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(${JSON.stringify(realPi)}, process.argv.slice(2), { stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
process.stdin.pipe(child.stdin);
child.stderr.pipe(process.stderr);
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let terminal;
    try {
      const value = JSON.parse(line);
      terminal = value.type === "turn_end" || value.type === "agent_settled";
    } catch {
      terminal = false;
    }
    if (terminal) {
      setTimeout(() => {
        writeFileSync(${JSON.stringify(marker)}, "settled");
        process.stdout.write(line + "\\n");
      }, 1000);
    } else {
      process.stdout.write(line + "\\n");
    }
    newline = buffer.indexOf("\\n");
  }
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`,
      );
      await chmod(wrapper, 0o755);

      const jobs = new JobManager({
        spawnJob: createPiSpawner({
          workspaceRoot: root,
          piBinary: wrapper,
          sessionsRoot,
          readinessTimeoutMs: 30_000,
          logger,
        }),
        logger,
        unacknowledgedTtlMs: 60_000,
      });
      const skills = createSkillRegistry({ jobs, workspaceRoot: root });
      const server = createAgentServer({
        host: "127.0.0.1",
        port: 0,
        swarmKey: key,
        identity: serverIdentity,
        sessionsRoot,
        skillRegistry: skills,
        jobs,
        spawnPolicy: parseSpawnPolicy(undefined, undefined),
      });
      const address = await server.start();
      let iterator: AsyncGenerator<StreamResponse> | undefined;
      try {
        const started = (await skills.invoke("process.spawn", {
          project: "real-pi-test",
          cwd,
          prompt:
            "Write the integers from 1 through 40, one integer per line, with no other text and no tool calls.",
          _peerId: deniedIdentity.peerId,
        })) as { job_id: string; session_id: string };
        jobs.acknowledge(started.job_id);
        iterator = streamFrames(address.port, started.session_id);

        const events = await collectUntil(
          iterator,
          (_event, seen) => seen.filter(isTextDelta).length === 2,
          "missing observation: real Pi emitted two text_delta frames before settling",
          60_000,
        );
        const deltas = events.filter(isTextDelta);
        expect(
          deltas.length,
          "missing observation: two real-Pi text_delta frames",
        ).toBeGreaterThanOrEqual(2);
        expect(
          await exists(marker),
          "missing observation: real-Pi deltas arrived before turn_end/agent_settled",
        ).toBe(false);
        expect(
          jobs.get(started.job_id)?.state,
          "missing observation: real Pi was still running after the second delta",
        ).toBe("running");
      } finally {
        await iterator?.return?.(undefined);
        await server.stop();
        await jobs.shutdown();
      }
    },
    90_000,
  );
});
