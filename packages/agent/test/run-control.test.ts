// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * M8-8 run control behind the folded grant (ADR 0021 decision 2).
 *
 * Ten named tests, one per clause, each failing for its own reason. Agent
 * test style throughout: injected roots, in-process servers and registries,
 * no machine state. Real signed wire for the gate and refusal-vs-transport
 * clauses; fixtures under a temp dir for everything else.
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import * as fsSync from "node:fs";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { TERMINAL_RUN_STATES } from "@pi-mesh/runs";
import {
  createAgentServer,
  createSkillRegistry,
  JobManager,
  sendSkill,
  signedHeaders,
  PeerUnreachableError,
  type AgentServer,
} from "../src/index.js";

const testIdentity = {
  peerId: "22222222-2222-4222-8222-222222222222",
  name: "run-control-test",
};
const testKey = Buffer.from("pi-mesh-vector-key-0123456789abc");
const callerA = {
  peerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "caller-a",
};
const callerB = {
  peerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "caller-b",
};

const NOW = 1_750_000_000_000;
const SCOPE = "pi-subagents-test";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type WireRpcResponse = {
  error?: { code?: number; message?: string };
  result?: { message?: { parts?: Array<{ data?: { result?: unknown } }> } };
};

function skillResult(parsed: WireRpcResponse): Record<string, unknown> {
  const result = parsed.result?.message?.parts?.[0]?.data?.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return {};
  }
  return result as Record<string, unknown>;
}

function postRpc(
  port: number,
  caller: { peerId: string; name: string },
  body: unknown,
): Promise<{ status: number; parsed: WireRpcResponse }> {
  const text = JSON.stringify(body);
  const headers = signedHeaders(testKey, caller, {
    method: "POST",
    path: "/",
    recipientPeerId: testIdentity.peerId,
    body: text,
  });
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
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (raw += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            parsed: JSON.parse(raw),
          }),
        );
      },
    );
    client.on("error", reject);
    client.end(text);
  });
}

function call(
  skill: string,
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        messageId: "message-1",
        role: "ROLE_USER",
        parts: [{ data: { skill, input } }],
      },
    },
  };
}

async function makeLayoutTmp(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "pi-mesh-run-control-"));
  await mkdir(join(tmp, SCOPE, "async-subagent-runs"), { recursive: true });
  return tmp;
}

async function writeRun(
  tmp: string,
  scope: string,
  runId: string,
  status: Record<string, unknown>,
): Promise<string> {
  const dir = join(tmp, scope, "async-subagent-runs", runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "status.json"), JSON.stringify(status));
  return dir;
}

function liveStatus(
  runId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId,
    state: "running",
    pid: 4242,
    startedAt: NOW - 60_000,
    lastUpdate: NOW - 1_000,
    ...overrides,
  };
}

function terminalStatus(
  runId: string,
  state: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId,
    state,
    startedAt: NOW - 60_000,
    lastUpdate: NOW - 1_000,
    ...overrides,
  };
}

async function listDirFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((e) => e.endsWith(".json") && !e.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

async function runInboxFiles(runDir: string): Promise<{
  stop: string[];
  steer: string[];
}> {
  return {
    stop: await listDirFiles(join(runDir, "control", "stop-requests")),
    steer: await listDirFiles(join(runDir, "control", "steer-requests")),
  };
}

async function allInboxFiles(tmp: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry === "stop-requests" || entry === "steer-requests") {
        for (const f of await listDirFiles(full)) {
          found.push(join(full, f));
        }
        continue;
      }
      let s;
      try {
        s = await stat(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) await walk(full);
    }
  }
  await walk(tmp);
  return found.sort();
}

describe("M8-8 run control behind the folded grant", () => {
  it("closed-grant-writes-nothing: both verbs return exactly -32102 and every inbox stays empty", async () => {
    const tmp = await makeLayoutTmp();
    const servers: AgentServer[] = [];
    try {
      const runStop = await writeRun(
        tmp,
        SCOPE,
        "run-closed-stop",
        liveStatus("run-closed-stop"),
      );
      const runSteer = await writeRun(
        tmp,
        SCOPE,
        "run-closed-steer",
        liveStatus("run-closed-steer"),
      );
      const denyAll = { allows: () => false, enabled: false };
      const closed = createAgentServer({
        port: 0,
        swarmKey: testKey,
        identity: testIdentity,
        runsTmp: tmp,
        spawnPolicy: denyAll,
      });
      servers.push(closed);
      const closedPort = (await closed.start()).port;
      for (const [skill, input] of [
        ["run.stop", { run_id: "run-closed-stop" }],
        ["run.steer", { run_id: "run-closed-steer", message: "hello" }],
      ] as const) {
        const { parsed } = await postRpc(
          closedPort,
          callerA,
          call(skill, input),
        );
        expect(
          parsed.error?.code,
          `closed-grant-writes-nothing: ${skill} with a closed grant must answer exactly -32102`,
        ).toBe(-32102);
      }
      expect(
        await allInboxFiles(tmp),
        "closed-grant-writes-nothing: a closed grant writes nothing",
      ).toEqual([]);
      expect(
        await runInboxFiles(runStop),
        "closed-grant-writes-nothing: stop inbox stays empty",
      ).toEqual({
        stop: [],
        steer: [],
      });
      expect(
        await runInboxFiles(runSteer),
        "closed-grant-writes-nothing: steer inbox stays empty",
      ).toEqual({
        stop: [],
        steer: [],
      });

      // Positive control: the same calls with the grant open write exactly
      // one request per isolated call.
      const allowAll = { allows: () => true, enabled: true };
      const open = createAgentServer({
        port: 0,
        swarmKey: testKey,
        identity: testIdentity,
        runsTmp: tmp,
        runsNow: () => NOW,
        spawnPolicy: allowAll,
      });
      servers.push(open);
      const openPort = (await open.start()).port;
      const { parsed: stopParsed } = await postRpc(
        openPort,
        callerA,
        call("run.stop", { run_id: "run-closed-stop" }),
      );
      expect(stopParsed.error).toBeUndefined();
      expect(skillResult(stopParsed).requested).toBe(true);
      const { parsed: steerParsed } = await postRpc(
        openPort,
        callerA,
        call("run.steer", { run_id: "run-closed-steer", message: "hello" }),
      );
      expect(steerParsed.error).toBeUndefined();
      expect(skillResult(steerParsed).requested).toBe(true);
      expect(
        (await runInboxFiles(runStop)).stop,
        "closed-grant-writes-nothing positive control: one stop request",
      ).toHaveLength(1);
      expect(
        (await runInboxFiles(runSteer)).steer,
        "closed-grant-writes-nothing positive control: one steer request",
      ).toHaveLength(1);
    } finally {
      await Promise.all(servers.map((s) => s.stop()));
      await rm(tmp, { recursive: true, force: true });
    }
  });

  for (const state of TERMINAL_RUN_STATES) {
    it(`terminal-stop-status-first: stop on terminal ${state} succeeds with null id and zero writes`, async () => {
      const tmp = await makeLayoutTmp();
      try {
        const runDir = await writeRun(
          tmp,
          SCOPE,
          `run-terminal-${state}`,
          terminalStatus(`run-terminal-${state}`, state),
        );
        // Open inbox: the zero-write assertion below must fail because the
        // status check was deleted, not because a closed marker refused it.
        const registry = createSkillRegistry({
          runsTmp: tmp,
          runsNow: () => NOW,
        });
        const result = (await registry.invoke("run.stop", {
          run_id: `run-terminal-${state}`,
        })) as Record<string, unknown>;
        expect(result).toEqual({
          run_id: `run-terminal-${state}`,
          request_id: null,
          requested: false,
          observed_state: state,
        });
        expect(
          await runInboxFiles(runDir),
          `terminal-stop-status-first: stop on terminal ${state} must write nothing`,
        ).toEqual({ stop: [], steer: [] });
        expect(
          await allInboxFiles(tmp),
          `terminal-stop-status-first: zero writer calls for terminal ${state}`,
        ).toEqual([]);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  }

  it("terminal-stop-status-first: an old retained artifact outside the listing window is still a known run", async () => {
    const tmp = await makeLayoutTmp();
    try {
      // 30 days old: far outside any listing window, but the UNWINDOWED
      // lookup must still resolve it. A windowed lookup would answer -32108
      // for a run that plainly exists.
      const old = NOW - 30 * 24 * 60 * 60 * 1000;
      await writeRun(
        tmp,
        SCOPE,
        "run-old-terminal",
        terminalStatus("run-old-terminal", "complete", {
          startedAt: old,
          lastUpdate: old,
        }),
      );
      const registry = createSkillRegistry({
        runsTmp: tmp,
        runsNow: () => NOW,
        runsMaxAgeMs: 1_000,
      });
      const result = (await registry.invoke("run.stop", {
        run_id: "run-old-terminal",
      })) as Record<string, unknown>;
      expect(result).toEqual({
        run_id: "run-old-terminal",
        request_id: null,
        requested: false,
        observed_state: "complete",
      });
      expect(
        await allInboxFiles(tmp),
        "terminal-stop-status-first: old retained artifact writes nothing",
      ).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("terminal-stop-status-first: live-run positive control writes exactly one request", async () => {
    const tmp = await makeLayoutTmp();
    try {
      const runDir = await writeRun(
        tmp,
        SCOPE,
        "run-live",
        liveStatus("run-live"),
      );
      const registry = createSkillRegistry({
        runsTmp: tmp,
        runsNow: () => NOW,
      });
      const result = (await registry.invoke("run.stop", {
        run_id: "run-live",
      })) as Record<string, unknown>;
      expect(result.requested).toBe(true);
      expect(typeof result.request_id).toBe("string");
      expect(result.observed_state).toBe("running");
      expect(
        (await runInboxFiles(runDir)).stop,
        "terminal-stop-status-first positive control: a live run writes exactly one request",
      ).toHaveLength(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("request-not-outcome: exact keys and types, id matches the committed file, no outcome claimed", async () => {
    const tmp = await makeLayoutTmp();
    try {
      const stopDir = await writeRun(
        tmp,
        SCOPE,
        "run-req-stop",
        liveStatus("run-req-stop"),
      );
      const steerDir = await writeRun(
        tmp,
        SCOPE,
        "run-req-steer",
        liveStatus("run-req-steer"),
      );
      const registry = createSkillRegistry({
        runsTmp: tmp,
        runsNow: () => NOW,
      });
      const stopResult = (await registry.invoke("run.stop", {
        run_id: "run-req-stop",
      })) as Record<string, unknown>;
      expect(
        Object.keys(stopResult).sort(),
        "request-not-outcome: stop result has exactly the documented keys",
      ).toEqual(["observed_state", "request_id", "requested", "run_id"]);
      expect(typeof stopResult.run_id).toBe("string");
      expect(typeof stopResult.request_id).toBe("string");
      expect(typeof stopResult.requested).toBe("boolean");
      expect(typeof stopResult.observed_state).toBe("string");
      expect(stopResult.requested).toBe(true);
      expect(stopResult.observed_state).toBe("running");
      const stopId = stopResult.request_id as string;
      expect(stopId).not.toContain("/");
      expect(stopId).not.toContain("\\");
      expect(
        await listDirFiles(join(stopDir, "control", "stop-requests")),
        "request-not-outcome: stop id matches the committed filename",
      ).toEqual([`${stopId}.json`]);
      expect(stopResult).not.toHaveProperty("stopped");
      expect(stopResult).not.toHaveProperty("delivered");
      expect(JSON.stringify(stopResult)).not.toContain("delivered");

      const steerResult = (await registry.invoke("run.steer", {
        run_id: "run-req-steer",
        message: "keep going",
      })) as Record<string, unknown>;
      expect(
        Object.keys(steerResult).sort(),
        "request-not-outcome: steer result has exactly the documented keys",
      ).toEqual(["observed_state", "request_id", "requested", "run_id"]);
      const steerId = steerResult.request_id as string;
      expect(steerId).not.toContain("/");
      const steerFiles = await listDirFiles(
        join(steerDir, "control", "steer-requests"),
      );
      expect(
        steerFiles,
        "request-not-outcome: steer id matches the committed filename",
      ).toEqual([`${steerId}.json`]);
      const payload = JSON.parse(
        await readFile(
          join(steerDir, "control", "steer-requests", `${steerId}.json`),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(payload.type).toBe("steer");
      expect(payload.message).toBe("keep going");
      expect(steerResult).not.toHaveProperty("stopped");
      expect(steerResult).not.toHaveProperty("delivered");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("closed-inboxes-preserve-code: the steer marker and the public stop throw both become -32109 with no leftovers", async () => {
    const tmp = await makeLayoutTmp();
    try {
      const steerDir = await writeRun(
        tmp,
        SCOPE,
        "run-closed-steer",
        liveStatus("run-closed-steer"),
      );
      await mkdir(join(steerDir, "control"), { recursive: true });
      await writeFile(
        join(steerDir, "control", "steer-inbox-closed.json"),
        JSON.stringify({ version: 1 }),
      );
      const stopDir = await writeRun(
        tmp,
        SCOPE,
        "run-closed-stop",
        liveStatus("run-closed-stop"),
      );
      await mkdir(join(stopDir, "control"), { recursive: true });
      await writeFile(
        join(stopDir, "control", "stop-inbox-closed.json"),
        JSON.stringify({ version: 1 }),
      );
      const registry = createSkillRegistry({
        runsTmp: tmp,
        runsNow: () => NOW,
      });
      await expect(
        registry.invoke("run.steer", {
          run_id: "run-closed-steer",
          message: "hi",
        }),
        "closed-inboxes-preserve-code: closed steer inbox is -32109, not a throw",
      ).rejects.toMatchObject({ code: -32109 });
      await expect(
        registry.invoke("run.stop", { run_id: "run-closed-stop" }),
        "closed-inboxes-preserve-code: public stop closed-inbox throw is -32109",
      ).rejects.toMatchObject({ code: -32109 });
      expect(
        await runInboxFiles(steerDir),
        "closed-inboxes-preserve-code: closed steer leaves no leftover file",
      ).toEqual({ stop: [], steer: [] });
      expect(
        await runInboxFiles(stopDir),
        "closed-inboxes-preserve-code: closed stop leaves no leftover file",
      ).toEqual({ stop: [], steer: [] });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("unknown-run-preserves-code: -32108 with no writes", async () => {
    const tmp = await makeLayoutTmp();
    try {
      await writeRun(tmp, SCOPE, "run-real", liveStatus("run-real"));
      const registry = createSkillRegistry({
        runsTmp: tmp,
        runsNow: () => NOW,
      });
      await expect(
        registry.invoke("run.stop", { run_id: "run-missing" }),
        "unknown-run-preserves-code: stop on an unknown run is -32108",
      ).rejects.toMatchObject({ code: -32108 });
      await expect(
        registry.invoke("run.steer", { run_id: "run-missing", message: "hi" }),
        "unknown-run-preserves-code: steer on an unknown run is -32108",
      ).rejects.toMatchObject({ code: -32108 });
      expect(
        await allInboxFiles(tmp),
        "unknown-run-preserves-code: an unknown run writes nothing",
      ).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("external-run-never-signalled: no path signals a pid for a run this agent did not start", async () => {
    const tmp = await makeLayoutTmp();
    let child: ChildProcess | undefined;
    const origKill = process.kill;
    const signals: Array<{ pid: number; signal: number | string | undefined }> =
      [];
    let jobsStopCalls = 0;
    try {
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        stdio: "ignore",
      });
      const pid = child.pid;
      expect(
        typeof pid,
        "external-run-never-signalled: fixture child has a real pid",
      ).toBe("number");
      await writeRun(
        tmp,
        SCOPE,
        "run-external",
        liveStatus("run-external", { pid }),
      );
      // Fail loudly on any non-zero signal: pid existence proves no identity.
      (process as unknown as { kill: typeof process.kill }).kill = ((
        target: number,
        signal?: number | string,
      ): boolean => {
        signals.push({ pid: target, signal });
        if (signal !== undefined && signal !== 0) {
          throw new Error(
            `external-run-never-signalled: non-zero signal ${String(signal)} sent to ${target}`,
          );
        }
        return origKill(target, signal as 0);
      }) as typeof process.kill;
      const jobs = new JobManager({
        spawnJob: () => ({
          pid: 4242,
          argv: [],
          stdioClosed: true,
          ready: Promise.resolve(),
          command: async (command: Record<string, unknown>) => ({
            success: true,
            ...command,
          }),
          close: async () => undefined,
        }),
        logger,
      });
      const origJobsStop = jobs.stop.bind(jobs);
      jobs.stop = (async (id: string) => {
        jobsStopCalls += 1;
        return origJobsStop(id);
      }) as typeof jobs.stop;
      const registry = createSkillRegistry({
        jobs,
        runsTmp: tmp,
        runsNow: () => NOW,
      });
      const stopResult = (await registry.invoke("run.stop", {
        run_id: "run-external",
      })) as Record<string, unknown>;
      expect(stopResult.requested).toBe(true);
      const steerResult = (await registry.invoke("run.steer", {
        run_id: "run-external",
        message: "nudge",
      })) as Record<string, unknown>;
      expect(steerResult.requested).toBe(true);
      expect(
        signals.filter((s) => s.signal !== 0 && s.signal !== undefined),
        "external-run-never-signalled: no non-zero signal may be sent",
      ).toEqual([]);
      expect(
        jobsStopCalls,
        "external-run-never-signalled: external-run control never routes through JobManager.stop",
      ).toBe(0);
      expect(
        child.exitCode,
        "external-run-never-signalled: the fixture must keep running",
      ).toBe(null);
      expect(
        child.signalCode,
        "external-run-never-signalled: the fixture must keep running",
      ).toBe(null);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = origKill;
      child?.kill("SIGKILL");
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("refusal-is-not-transport: JSON-RPC code, preserved skill code, and unreachable instead", async () => {
    const tmp = await makeLayoutTmp();
    let server: AgentServer | undefined;
    try {
      server = createAgentServer({
        port: 0,
        swarmKey: testKey,
        identity: testIdentity,
        runsTmp: tmp,
        runsNow: () => NOW,
        spawnPolicy: { allows: () => true, enabled: true },
      });
      const { port } = await server.start();
      // 1. The JSON-RPC error.code names the refusal.
      const { parsed } = await postRpc(
        port,
        callerA,
        call("run.stop", { run_id: "run-nope" }),
      );
      expect(
        parsed.error?.code,
        "refusal-is-not-transport: the JSON-RPC error.code must be -32108",
      ).toBe(-32108);
      // 2. The skill client preserves the agent's code (a refusal is an
      // application result, never a 502/transport).
      const peer = {
        id: testIdentity.peerId,
        name: testIdentity.name,
        serviceType: "mesh" as const,
        host: "127.0.0.1",
        port,
        txt: {},
        lastSeen: Date.now(),
      };
      const result = sendSkill(
        peer,
        "run.stop",
        { run_id: "run-nope" },
        {
          identity: callerA,
          swarmKey: testKey,
        },
      );
      await expect(
        result,
        "refusal-is-not-transport: the preserved skill code must be -32108",
      ).rejects.toMatchObject({ code: -32108, name: "PiMeshError" });
      // 3. A disconnected agent is transport, not refusal.
      await server.stop();
      server = undefined;
      await expect(
        sendSkill(
          peer,
          "run.stop",
          { run_id: "run-nope" },
          {
            identity: callerA,
            swarmKey: testKey,
          },
        ),
        "refusal-is-not-transport: a disconnected agent must produce PeerUnreachableError",
      ).rejects.toBeInstanceOf(PeerUnreachableError);
    } finally {
      await server?.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("exit-between-status-and-write: closure injected after observation is -32109 with no request", async () => {
    const tmp = await makeLayoutTmp();
    try {
      const steerDir = await writeRun(
        tmp,
        SCOPE,
        "run-race-steer",
        liveStatus("run-race-steer"),
      );
      const stopDir = await writeRun(
        tmp,
        SCOPE,
        "run-race-stop",
        liveStatus("run-race-stop"),
      );
      const registry = createSkillRegistry({
        runsTmp: tmp,
        runsNow: () => NOW,
        runsBeforeWrite: (runDir: string) => {
          if (runDir === steerDir) {
            fsSync.mkdirSync(join(runDir, "control"), { recursive: true });
            fsSync.writeFileSync(
              join(runDir, "control", "steer-inbox-closed.json"),
              JSON.stringify({ version: 1 }),
            );
          }
          if (runDir === stopDir) {
            fsSync.mkdirSync(join(runDir, "control"), { recursive: true });
            fsSync.writeFileSync(
              join(runDir, "control", "stop-inbox-closed.json"),
              JSON.stringify({ version: 1 }),
            );
          }
        },
      });
      await expect(
        registry.invoke("run.steer", {
          run_id: "run-race-steer",
          message: "late",
        }),
        "exit-between-status-and-write: closure after observation is -32109",
      ).rejects.toMatchObject({ code: -32109 });
      await expect(
        registry.invoke("run.stop", { run_id: "run-race-stop" }),
        "exit-between-status-and-write: closure after observation is -32109",
      ).rejects.toMatchObject({ code: -32109 });
      expect(
        await runInboxFiles(steerDir),
        "exit-between-status-and-write: no request may be left behind",
      ).toEqual({ stop: [], steer: [] });
      expect(
        await runInboxFiles(stopDir),
        "exit-between-status-and-write: no request may be left behind",
      ).toEqual({ stop: [], steer: [] });

      // Without observed closure, success means "requested", not "consumed":
      // the response carries a request id and the observed state, never a
      // claim that the runner consumed it.
      const cleanTmp = await makeLayoutTmp();
      try {
        await writeRun(cleanTmp, SCOPE, "run-clean", liveStatus("run-clean"));
        const clean = createSkillRegistry({
          runsTmp: cleanTmp,
          runsNow: () => NOW,
        });
        const result = (await clean.invoke("run.steer", {
          run_id: "run-clean",
          message: "nudge",
        })) as Record<string, unknown>;
        expect(result.requested).toBe(true);
        expect(typeof result.request_id).toBe("string");
        expect(result).not.toHaveProperty("delivered");
        expect(JSON.stringify(result)).not.toContain("consumed");
      } finally {
        await rm(cleanTmp, { recursive: true, force: true });
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("two-controls-distinct-requests: two signed callers produce two distinct complete requests", async () => {
    const tmp = await makeLayoutTmp();
    let server: AgentServer | undefined;
    try {
      const runDir = await writeRun(
        tmp,
        SCOPE,
        "run-shared",
        liveStatus("run-shared"),
      );
      server = createAgentServer({
        port: 0,
        swarmKey: testKey,
        identity: testIdentity,
        runsTmp: tmp,
        runsNow: () => NOW,
        spawnPolicy: { allows: () => true, enabled: true },
      });
      const { port } = await server.start();
      const first = await postRpc(
        port,
        callerA,
        call("run.steer", { run_id: "run-shared", message: "first" }),
      );
      const second = await postRpc(
        port,
        callerB,
        call("run.steer", { run_id: "run-shared", message: "second" }),
      );
      expect(first.parsed.error).toBeUndefined();
      expect(second.parsed.error).toBeUndefined();
      const firstResult = skillResult(first.parsed);
      const secondResult = skillResult(second.parsed);
      expect(firstResult.requested).toBe(true);
      expect(secondResult.requested).toBe(true);
      const firstId = firstResult.request_id as string;
      const secondId = secondResult.request_id as string;
      expect(typeof firstId).toBe("string");
      expect(typeof secondId).toBe("string");
      expect(
        firstId,
        "two-controls-distinct-requests: two callers must not share one request",
      ).not.toBe(secondId);
      const files = await listDirFiles(
        join(runDir, "control", "steer-requests"),
      );
      expect(
        files,
        "two-controls-distinct-requests: two distinct committed requests",
      ).toHaveLength(2);
      expect(files).toContain(`${firstId}.json`);
      expect(files).toContain(`${secondId}.json`);
      for (const [id, message] of [
        [firstId, "first"],
        [secondId, "second"],
      ] as const) {
        const payload = JSON.parse(
          await readFile(
            join(runDir, "control", "steer-requests", `${id}.json`),
            "utf8",
          ),
        ) as Record<string, unknown>;
        expect(payload).toMatchObject({ type: "steer", message });
        expect(payload.id).toBeDefined();
      }
      expect(firstResult).not.toHaveProperty("delivered");
      expect(secondResult).not.toHaveProperty("delivered");
    } finally {
      await server?.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("ambiguity: two runs claiming one id are -32602 and write nothing", async () => {
    const tmp = await makeLayoutTmp();
    try {
      await writeRun(tmp, "pi-subagents-a", "run-dup", liveStatus("run-dup"));
      await writeRun(tmp, "pi-subagents-b", "run-dup", liveStatus("run-dup"));
      const registry = createSkillRegistry({
        runsTmp: tmp,
        runsNow: () => NOW,
      });
      await expect(
        registry.invoke("run.stop", { run_id: "run-dup" }),
        "ambiguity: two runs claiming one id must be -32602, never a pick",
      ).rejects.toMatchObject({
        code: -32602,
        message: expect.stringMatching(/two runs claim it/),
      });
      await expect(
        registry.invoke("run.steer", { run_id: "run-dup", message: "hi" }),
        "ambiguity: two runs claiming one id must be -32602, never a pick",
      ).rejects.toMatchObject({ code: -32602 });
      expect(
        await allInboxFiles(tmp),
        "ambiguity: no write may happen",
      ).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("malformed-input: blank ids, blank messages, extra fields and oversize messages are -32602", async () => {
    const tmp = await makeLayoutTmp();
    try {
      await writeRun(tmp, SCOPE, "run-ok", liveStatus("run-ok"));
      const registry = createSkillRegistry({
        runsTmp: tmp,
        runsNow: () => NOW,
      });
      const cases: Array<[string, Record<string, unknown>]> = [
        ["blank run_id", { run_id: "   " }],
        ["missing run_id", {}],
        ["non-string run_id", { run_id: 42 }],
        ["extra field on stop", { run_id: "run-ok", surprise: 1 }],
      ];
      for (const [label, input] of cases) {
        await expect(
          registry.invoke("run.stop", input),
          `malformed-input: stop ${label} is -32602`,
        ).rejects.toMatchObject({ code: -32602 });
      }
      const steerCases: Array<[string, Record<string, unknown>]> = [
        ["blank message", { run_id: "run-ok", message: "   " }],
        ["missing message", { run_id: "run-ok" }],
        [
          "extra field on steer",
          { run_id: "run-ok", message: "hi", writer: "x" },
        ],
        [
          "oversize message",
          { run_id: "run-ok", message: "x".repeat(128 * 1024 + 1) },
        ],
      ];
      for (const [label, input] of steerCases) {
        await expect(
          registry.invoke("run.steer", input),
          `malformed-input: steer ${label} is -32602`,
        ).rejects.toMatchObject({ code: -32602 });
      }
      expect(
        await allInboxFiles(tmp),
        "malformed-input: malformed input writes nothing",
      ).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("unsupported-version: an installed version outside the pin is -32109 with no write", async () => {
    const tmp = await makeLayoutTmp();
    try {
      const runDir = await writeRun(
        tmp,
        SCOPE,
        "run-versioned",
        liveStatus("run-versioned"),
      );
      const registry = createSkillRegistry({
        runsTmp: tmp,
        runsNow: () => NOW,
        runsInstalledVersion: "0.77.0",
      });
      await expect(
        registry.invoke("run.stop", { run_id: "run-versioned" }),
        "unsupported-version: stop outside the pin is -32109",
      ).rejects.toMatchObject({ code: -32109 });
      await expect(
        registry.invoke("run.steer", {
          run_id: "run-versioned",
          message: "hi",
        }),
        "unsupported-version: steer outside the pin is -32109",
      ).rejects.toMatchObject({ code: -32109 });
      expect(
        await runInboxFiles(runDir),
        "unsupported-version: no write outside the pin",
      ).toEqual({
        stop: [],
        steer: [],
      });
      expect(
        existsSync(join(runDir, "control")),
        "unsupported-version: no inbox may be created",
      ).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("interrupted-publication: inbox I/O failure is -32603 with no partial final file", async () => {
    const tmp = await makeLayoutTmp();
    try {
      const runDir = await writeRun(
        tmp,
        SCOPE,
        "run-broken",
        liveStatus("run-broken"),
      );
      // Block the writer: a file where the inbox directory must be makes the
      // mkdir fail, which the writer reports as a typed I/O failure.
      await mkdir(join(runDir, "control"), { recursive: true });
      await writeFile(join(runDir, "control", "steer-requests"), "blocked");
      const registry = createSkillRegistry({
        runsTmp: tmp,
        runsNow: () => NOW,
      });
      await expect(
        registry.invoke("run.steer", { run_id: "run-broken", message: "hi" }),
        "interrupted-publication: inbox I/O failure is -32603",
      ).rejects.toMatchObject({ code: -32603 });
      // No partial final request: the blocking file is not a request, and no
      // .json request may appear beside it.
      expect(
        await runInboxFiles(runDir),
        "interrupted-publication: no partial final file",
      ).toEqual({
        stop: [],
        steer: [],
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("no-second-gate: run control has no handler-local grant test and never touches jobs or signals", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, "..", "src", "skills.ts"), "utf8");
    const stopIndex = source.indexOf('registerExecution("run.stop"');
    const steerIndex = source.indexOf('registerExecution("run.steer"');
    expect(
      stopIndex,
      "no-second-gate: run.stop must be registered via registerExecution",
    ).toBeGreaterThan(-1);
    expect(
      steerIndex,
      "no-second-gate: run.steer must be registered via registerExecution",
    ).toBeGreaterThan(-1);
    const endIndex = source.indexOf("return skills;", steerIndex);
    const block = source.slice(
      stopIndex,
      endIndex === -1 ? undefined : endIndex,
    );
    for (const forbidden of [
      "assertExecutionAllowed",
      "spawnPolicy",
      "allows(",
      "JobManager",
      "jobs.stop",
      "jobs.send",
      "options.jobs",
      "process.kill",
      "kill(",
    ]) {
      expect(
        block,
        `no-second-gate: run control must not contain a handler-local grant or signal (${forbidden}) - a second gate is a second truth about who may execute`,
      ).not.toContain(forbidden);
    }
    // Behavioural positive control: a registry with no JobManager at all
    // still serves run control where a layout exists - proving the requirement
    // is the run layout, not a job manager.
    const tmp = await makeLayoutTmp();
    try {
      await writeRun(tmp, SCOPE, "run-nogate", liveStatus("run-nogate"));
      const registry = createSkillRegistry({
        runsTmp: tmp,
        runsNow: () => NOW,
      });
      const result = (await registry.invoke("run.stop", {
        run_id: "run-nogate",
      })) as Record<string, unknown>;
      expect(result.requested).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
