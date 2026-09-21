// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@pi-mesh/shared";
import {
  createSkillRegistry,
  JobManager,
  servedSkills,
  type JobRecord,
} from "../src/index.js";
import { PiRpcClient } from "../src/rpc.js";

const fixture = fileURLToPath(
  new URL("./fixtures/rpc-stub.mjs", import.meta.url),
);

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function setup(mode: string): Promise<{
  jobs: JobManager;
  close: () => Promise<void>;
  record: () => Promise<JobRecord>;
  output: string[];
  events: Record<string, unknown>[];
}> {
  const parent = await mkdtemp(join(tmpdir(), "pi-mesh-control-"));
  const root = join(parent, "workspace");
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  const output: string[] = [];
  const events: Record<string, unknown>[] = [];
  const running: PiRpcClient[] = [];
  const jobs = new JobManager({
    spawnJob: (spec, report) => {
      const rpc = new PiRpcClient({
        piBinary: process.execPath,
        binaryArgs: [fixture],
        sessionDir: spec.cwd,
        name: spec.name,
        cwd: spec.cwd,
        env: { ...process.env, PI_RPC_STUB_MODE: mode },
        logger,
      });
      rpc.on("exit", report.exited);
      rpc.on("stderr", (line: string) => {
        output.push(line);
        report.output(line);
      });
      rpc.on("event", (event: Record<string, unknown>) => events.push(event));
      const ready = (async (): Promise<void> => {
        await rpc.ready;
        const response = await rpc.request({ type: "get_state" });
        const data = response.data as { sessionId?: unknown };
        if (typeof data.sessionId !== "string")
          throw new Error("fixture did not report a session id");
        report.session(data.sessionId);
      })();
      running.push(rpc);
      return {
        pid: rpc.child.pid,
        argv: rpc.argv,
        get stdioClosed() {
          return rpc.stdioClosed;
        },
        command: (command: Record<string, unknown>) => rpc.request(command),
        close: () => rpc.close(),
        ready,
      };
    },
    logger,
    unacknowledgedTtlMs: 5_000,
  });
  const close = async (): Promise<void> => {
    await jobs.shutdown();
    await Promise.all(running.map((rpc) => rpc.close()));
  };
  const record = async (): Promise<JobRecord> => {
    const started = await jobs.startReady({
      peerId: "peer-1",
      project: "project",
      cwd,
      name: "control-test",
    });
    return started;
  };
  return { jobs, close, record, output, events };
}

function withDeadline<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("operation did not settle")), ms),
    ),
  ]);
}

describe("process and session control skills", () => {
  it("T1 refuses an unknown process.stop job through the registry", async () => {
    const jobs = new JobManager({
      spawnJob: () => {
        throw new Error("must not spawn");
      },
      logger,
    });
    const registry = createSkillRegistry({ jobs });
    await expect(
      registry.invoke("process.stop", { job_id: "missing" }),
    ).rejects.toMatchObject({
      code: ErrorCode.UnknownJob,
    });
  });

  it("T2 never treats a PID as a process.stop job id", async () => {
    const test = await setup("abort");
    try {
      const started = await test.record();
      expect(started.pid).toBeGreaterThan(0);
      const registry = createSkillRegistry({ jobs: test.jobs });
      // Liveness is asserted BEHAVIOURALLY, never with `process.kill(pid, 0)`.
      // That call returns success for a zombie, and this assertion runs before
      // the event loop has reaped the child, so a stop() that DID signal the
      // PID still reads as alive and the clause goes unverified. Measured:
      // immediately after SIGKILL, kill(pid, 0) says alive while `ps -o stat=`
      // reports "Z". A live fixture keeps emitting on its 20ms timer; a killed
      // one cannot.
      const before = test.jobs.output(started.id).length;
      for (const id of [
        String(started.pid),
        "1",
        "123e4567-e89b-42d3-a456-426614174099",
      ]) {
        await expect(
          registry.invoke("process.stop", { job_id: id }),
        ).rejects.toMatchObject({ code: ErrorCode.UnknownJob });
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(test.jobs.output(started.id).length).toBeGreaterThan(before);
    } finally {
      await test.close();
    }
  });

  it("T3 stops a job and makes process.stop idempotent", async () => {
    const test = await setup("abort");
    try {
      const started = await test.record();
      const registry = createSkillRegistry({ jobs: test.jobs });
      await expect(
        registry.invoke("process.stop", { job_id: started.id }),
      ).resolves.toMatchObject({
        job_id: started.id,
        state: "exited",
        pid: started.pid,
      });
      await expect(
        registry.invoke("process.stop", { job_id: started.id }),
      ).resolves.toMatchObject({
        job_id: started.id,
        state: "exited",
        pid: started.pid,
      });
    } finally {
      await test.close();
    }
  });

  it("T4 abort returns, retains no later output, and emits a terminal RPC event", async () => {
    const test = await setup("abort");
    try {
      const started = await test.record();
      const registry = createSkillRegistry({ jobs: test.jobs });
      const response = await withDeadline(
        registry.invoke("session.abort", { job_id: started.id }),
      );
      expect(response).toMatchObject({ success: true });
      // Let anything already in flight land before taking the baseline. The
      // child writes its timer to stderr while the abort response travels on
      // stdout, so the two pipes can be re-ordered and a line emitted just
      // before the abort can arrive just after it. Comparing immediately makes
      // this flaky rather than wrong; the clause is about what comes after.
      await new Promise((resolve) => setTimeout(resolve, 80));
      const snapshot = [...test.jobs.output(started.id)];
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(test.jobs.output(started.id)).toEqual(snapshot);
      expect(test.events).toContainEqual({
        type: "agent_end",
        reason: "aborted",
      });
      await test.jobs.stop(started.id);
      expect(test.jobs.get(started.id)?.state).toBe("exited");
    } finally {
      await test.close();
    }
  });

  it("T5 session.abort refuses an unknown job through the registry", async () => {
    const jobs = new JobManager({
      spawnJob: () => {
        throw new Error("must not spawn");
      },
      logger,
    });
    const registry = createSkillRegistry({ jobs });
    await expect(
      registry.invoke("session.abort", { job_id: "missing" }),
    ).rejects.toMatchObject({
      code: ErrorCode.UnknownJob,
    });
  });

  it("T6 session.steer delivers the supplied message", async () => {
    const test = await setup("steer");
    try {
      const started = await test.record();
      const registry = createSkillRegistry({ jobs: test.jobs });
      await expect(
        registry.invoke("session.steer", {
          job_id: started.id,
          message: "specific steering message",
        }),
      ).resolves.toMatchObject({ success: true, accepted: true });
      // A real RPC response alone cannot prove which request was sent; the
      // fixture records the exact message on stderr in its explicit steer mode.
      expect(test.output).toHaveLength(1);
      expect(test.output[0]).toContain("steer=specific steering message");
    } finally {
      await test.close();
    }
  });

  it("T8 advertises ungated controls and only gated steering when enabled", () => {
    expect(servedSkills(false)).toContain("process.stop");
    expect(servedSkills(false)).toContain("session.abort");
    expect(servedSkills(false)).not.toContain("session.steer");
    expect(servedSkills(true)).toContain("session.steer");
  });

  it("T9 registers all three controls in the real registry", async () => {
    const jobs = new JobManager({
      spawnJob: (_spec, report) => ({
        pid: undefined,
        argv: [],
        stdioClosed: true,
        command: async (command) => ({ type: command.type, success: true }),
        close: async () => report.exited({ code: 0, signal: null }),
      }),
      logger,
    });
    const registry = createSkillRegistry({ jobs });
    expect(registry.has("process.stop")).toBe(true);
    expect(registry.has("session.abort")).toBe(true);
    expect(registry.has("session.steer")).toBe(true);
    const started = jobs.start({
      peerId: "peer-1",
      project: "project",
      cwd: process.cwd(),
      name: "registry-test",
    });
    await expect(
      registry.invoke("session.steer", {
        job_id: started.id,
        message: "hello",
      }),
    ).resolves.toMatchObject({ type: "steer" });
    await expect(
      registry.invoke("session.abort", { job_id: started.id }),
    ).resolves.toMatchObject({
      type: "abort",
    });
    await expect(
      registry.invoke("process.stop", { job_id: started.id }),
    ).resolves.toMatchObject({
      state: "exited",
    });
    await jobs.shutdown();
  });
});
