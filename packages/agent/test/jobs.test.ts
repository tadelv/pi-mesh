// SPDX-License-Identifier: GPL-3.0-or-later

import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@pi-mesh/shared";
import { AGENT_CARD_ROUTE } from "@pi-mesh/protocol";
import {
  createAgentServer,
  signedHeaders,
  type JobHandle,
  type JobReporter,
  JobManager,
} from "../src/index.js";
import { SkillRegistry } from "../src/skills.js";
import { PiRpcClient } from "../src/rpc.js";

const testIdentity = {
  peerId: "22222222-2222-4222-8222-222222222222",
  name: "test",
};
const testKey = Buffer.from("pi-mesh-vector-key-0123456789abc");

const fixture = fileURLToPath(
  new URL("./fixtures/rpc-stub.mjs", import.meta.url),
);

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type Running = { pid: number; rpc: PiRpcClient };

function realSpawner(running: Running[]) {
  return (
    spec: {
      readonly project: string;
      readonly cwd: string;
      readonly name: string;
      readonly peerId: string;
    },
    report: JobReporter,
  ): JobHandle => {
    const rpc = new PiRpcClient({
      piBinary: process.execPath,
      binaryArgs: [fixture],
      sessionDir: spec.cwd,
      name: spec.name,
      shutdownTimeoutMs: 100,
      logger: silentLogger,
      env: { ...process.env, PI_RPC_STUB_MODE: "ignoreterm" },
    });
    const pid = rpc.child.pid;
    if (pid === undefined) throw new Error("fixture did not expose a pid");
    rpc.on("exit", report.exited);
    rpc.on("stderr", (line: string) => report.output(line));
    running.push({ pid, rpc });
    return {
      pid,
      argv: rpc.argv,
      get stdioClosed() {
        return rpc.stdioClosed;
      },
      close: () => rpc.close(),
    };
  };
}

function spec(peerId = "peer-1") {
  return { peerId, project: "project", cwd: process.cwd(), name: "test" };
}

function assertGone(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow();
}

/** GET the unauthenticated agent card: proof the server still answers. */
function cardStatus(port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const probe = request(
      { host: "127.0.0.1", port, method: "GET", path: AGENT_CARD_ROUTE },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    probe.on("error", reject);
    probe.end();
  });
}

describe("JobManager", () => {
  it("escalates an ignore-term child to SIGKILL and observes the real exit", async () => {
    const running: Running[] = [];
    const jobs = new JobManager({
      spawnJob: realSpawner(running),
      logger: silentLogger,
      unacknowledgedTtlMs: 2_000,
    });
    try {
      const record = jobs.start(spec());
      await running[0]!.rpc.ready;
      await jobs.stop(record.id);
      expect(record.exit?.signal).toBe("SIGKILL");
      assertGone(record.pid!);
    } finally {
      await jobs.shutdown();
      for (const child of running) await child.rpc.close();
    }
  });

  it("stops a job exactly once, even raced with itself", async () => {
    // This used to assert `second === first`, which is trivially true because
    // stop() hands back the same record object either way: the test passed with
    // the dedupe and the exited-early-return deleted, so it never observed the
    // thing it was named for. Counting close() calls is what actually proves
    // "stopping twice is safe" - each escalation the manager fails to dedupe
    // shows up as an extra close().
    let closes = 0;
    const jobs = new JobManager({
      spawnJob: () => ({
        pid: undefined,
        argv: [],
        stdioClosed: true,
        close: async () => {
          closes += 1;
        },
      }),
      logger: silentLogger,
    });
    const record = jobs.start(spec());
    const [first, second] = await Promise.all([
      jobs.stop(record.id),
      jobs.stop(record.id),
    ]);
    expect(first).toBe(record);
    expect(second).toBe(record);
    expect(closes).toBe(1);
    await jobs.stop(record.id);
    expect(closes).toBe(1);
    await jobs.shutdown();
  });

  it("records the session id the spawner reports", async () => {
    // The plan's first M2-4 bullet: one authoritative record per job, session
    // id included. M2-5 learns it from `get_state` once the child is ready.
    let reporter: JobReporter | undefined;
    const jobs = new JobManager({
      spawnJob: (_spec, report) => {
        reporter = report;
        return {
          pid: undefined,
          argv: [],
          stdioClosed: true,
          close: async () => undefined,
        };
      },
      logger: silentLogger,
    });
    const record = jobs.start(spec());
    expect(jobs.get(record.id)?.sessionId).toBeUndefined();
    reporter!.session("session-abc");
    expect(jobs.get(record.id)?.sessionId).toBe("session-abc");
    await jobs.shutdown();
  });

  it("refuses an unknown job", async () => {
    const jobs = new JobManager({
      spawnJob: () => {
        throw new Error("must not spawn");
      },
      logger: silentLogger,
    });
    await expect(jobs.stop("missing")).rejects.toMatchObject({
      code: ErrorCode.UnknownJob,
    });
  });

  it("enforces concurrency, rate, output, and acknowledgement bounds", async () => {
    const reports: JobReporter[] = [];
    const handles: JobHandle[] = [];
    const jobs = new JobManager({
      maxJobs: 1,
      perPeerStartLimit: { limit: 1, windowMs: 60_000 },
      maxRetainedOutputLines: 2,
      spawnJob: (_spec, report) => {
        reports.push(report);
        const handle: JobHandle = {
          pid: undefined,
          argv: [],
          stdioClosed: true,
          close: async () => undefined,
        };
        handles.push(handle);
        return handle;
      },
      logger: silentLogger,
    });
    const first = jobs.start(spec());
    reports[0]!.output("one");
    reports[0]!.output("two");
    reports[0]!.output("three");
    expect(jobs.output(first.id)).toEqual(["two", "three"]);
    expect(() => jobs.start(spec())).toThrowError(
      expect.objectContaining({ code: ErrorCode.TooManyJobs }),
    );
    reports[0]!.exited({ code: 0, signal: null });
    jobs.acknowledge(first.id);
    expect(jobs.get(first.id)?.acknowledged).toBe(true);
    await jobs.shutdown();
    expect(handles).toHaveLength(1);

    const rateJobs = new JobManager({
      perPeerStartLimit: { limit: 1, windowMs: 60_000 },
      spawnJob: (_spec, report) => ({
        pid: undefined,
        argv: [],
        stdioClosed: true,
        close: async () => report.exited({ code: 0, signal: null }),
      }),
      logger: silentLogger,
    });
    rateJobs.start(spec());
    expect(() => rateJobs.start(spec())).toThrowError(
      expect.objectContaining({ code: ErrorCode.TooManyJobs }),
    );
  });

  it("reaps a disconnected request after the delivery deadline", async () => {
    const running: Running[] = [];
    const jobs = new JobManager({
      spawnJob: realSpawner(running),
      unacknowledgedTtlMs: 40,
      logger: silentLogger,
    });
    const skills = new SkillRegistry();
    let started: ReturnType<JobManager["start"]> | undefined;
    skills.registerExecution("process.spawn", async (input) => {
      started = jobs.start({
        peerId: "peer-1",
        project: String(input.project ?? "project"),
        cwd: process.cwd(),
        name: "disconnect-test",
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { job: started };
    });
    const server = createAgentServer({
      port: 0,
      host: "127.0.0.1",
      swarmKey: testKey,
      identity: testIdentity,
      skillRegistry: skills,
      jobs,
      spawnPolicy: { allows: () => true, enabled: true },
    });
    const address = await server.start();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          messageId: "message-1",
          role: "ROLE_USER",
          parts: [
            { data: { skill: "process.spawn", input: { project: "p" } } },
          ],
        },
      },
    });
    const headers = signedHeaders(testKey, testIdentity, {
      method: "POST",
      path: "/",
      recipientPeerId: testIdentity.peerId,
      body,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const client = request({
          host: "127.0.0.1",
          port: address.port,
          method: "POST",
          path: "/",
          headers: {
            ...headers,
            "A2A-Version": "1.0",
            "content-type": "application/json",
          },
        });
        client.on("error", (error) => {
          if ((error as NodeJS.ErrnoException).code !== "ECONNRESET")
            reject(error);
        });
        client.end(body);
        setTimeout(() => {
          client.destroy();
          resolve();
        }, 10);
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      // A REAL liveness probe. The old assertion here was
      // `expect(() => process.kill(process.pid, 0)).not.toThrow()` - the server
      // runs inside this very process, so that line could never fail and proved
      // nothing about surviving the disconnect. Asking the agent card proves
      // the server is still serving requests.
      await expect(cardStatus(address.port)).resolves.toBe(200);
      expect(started).toBeDefined();
      assertGone(started!.pid!);
    } finally {
      await server.stop();
      await jobs.shutdown();
      for (const child of running) await child.rpc.close();
    }
  });

  it("does not reap an acknowledged job at the delivery deadline", async () => {
    const reports: JobReporter[] = [];
    const jobs = new JobManager({
      unacknowledgedTtlMs: 20,
      spawnJob: (_spec, report) => {
        reports.push(report);
        return {
          pid: undefined,
          argv: [],
          stdioClosed: true,
          close: async () => report.exited({ code: 0, signal: null }),
        };
      },
      logger: silentLogger,
    });
    const record = jobs.start(spec());
    jobs.acknowledge(record.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(jobs.get(record.id)).toBe(record);
    expect(record.state).toBe("running");
    reports[0]!.exited({ code: 0, signal: null });
    await jobs.shutdown();
  });

  it("reaps every child on shutdown", async () => {
    const running: Running[] = [];
    const jobs = new JobManager({
      spawnJob: realSpawner(running),
      logger: silentLogger,
    });
    try {
      const first = jobs.start(spec());
      const second = jobs.start(spec("peer-2"));
      await Promise.all(running.map(({ rpc }) => rpc.ready));
      await jobs.shutdown();
      assertGone(first.pid!);
      assertGone(second.pid!);
    } finally {
      await jobs.shutdown();
      for (const child of running) await child.rpc.close();
    }
  });
});
