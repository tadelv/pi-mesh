// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@pi-mesh/shared";
import {
  ALWAYS_SERVED_SKILLS,
  createAgentServer,
  createSkillRegistry,
  EXECUTION_SKILLS,
  JOB_SKILLS,
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

/**
 * Wait for the fixture to have recorded something, bounded.
 *
 * The fixture records a request on stderr while the response to it travels on
 * stdout, so the two pipes can be re-ordered and a line emitted just before an
 * acknowledgement can be read just after it. Asserting immediately makes the test
 * flaky rather than wrong: it passed on a laptop and failed on a slower CI runner.
 * Waiting does not weaken the clause - the recorded message is still asserted
 * exactly, and a fixture that recorded nothing still fails once the wait expires.
 */
async function waitForOutput(output: string[], ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (output.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

  it("T6 session.steer DELIVERS the message, which pi's steer command alone does not", async () => {
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
      // A successful RPC response proves only that the command was accepted. The
      // fixture distinguishes acceptance from delivery the way pi does: `steer`
      // is queued onto the in-flight turn and never read on an idle session,
      // while a `prompt` marked streamingBehavior:"steer" reaches it. Sending
      // `steer` here fails this line - which is the bug that shipped, reproduced
      // on hardware: success:true and a transcript that never changed.
      await waitForOutput(test.output, 2_000);
      expect(test.output).toHaveLength(1);
      expect(test.output[0]).toContain(
        "steer-delivered=specific steering message",
      );
    } finally {
      await test.close();
    }
  });

  it("T7 limits session.steer messages to 4096 UTF-8 bytes", async () => {
    const test = await setup("steer");
    try {
      const started = await test.record();
      const registry = createSkillRegistry({ jobs: test.jobs });
      const exactAscii = "a".repeat(4096);
      await expect(
        registry.invoke("session.steer", {
          job_id: started.id,
          message: exactAscii,
        }),
      ).resolves.toMatchObject({ success: true, accepted: true });
      const asciiDelivery = `steer-delivered=${exactAscii}\n`;
      const asciiDeadline = Date.now() + 2_000;
      while (
        !test.output.join("").includes(asciiDelivery) &&
        Date.now() < asciiDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(
        test.output.join(""),
        "exact 4096-byte steer reaches the fixture",
      ).toContain(asciiDelivery);

      await expect(
        registry.invoke("session.steer", {
          job_id: started.id,
          message: "a".repeat(4097),
        }),
      ).rejects.toMatchObject({
        code: -32602,
        message: expect.stringMatching(/message.*4096.*UTF-8 bytes/i),
      });
      expect(test.output.join("").match(/steer-delivered=/g)).toHaveLength(1);

      const exactMultibyte = "é".repeat(2048);
      await expect(
        registry.invoke("session.steer", {
          job_id: started.id,
          message: exactMultibyte,
        }),
      ).resolves.toMatchObject({ success: true, accepted: true });
      // stderr is emitted in arbitrary chunks. Count complete ASCII record
      // prefixes, not array entries; chunk.toString() may split UTF-8 bytes.
      const secondDeadline = Date.now() + 2_000;
      while (
        (test.output.join("").match(/steer-delivered=/g) ?? []).length < 2 &&
        Date.now() < secondDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(
        test.output.join("").match(/steer-delivered=/g),
        "multibyte boundary sends a second prompt",
      ).toHaveLength(2);
      await expect(
        registry.invoke("session.steer", {
          job_id: started.id,
          message: "é".repeat(2049),
        }),
      ).rejects.toMatchObject({
        code: -32602,
        message: expect.stringMatching(/message.*4096.*UTF-8 bytes/i),
      });
      expect(test.output.join("").match(/steer-delivered=/g)).toHaveLength(2);
    } finally {
      await test.close();
    }
  });

  it("T8 advertises only what the machine can serve, from two separate facts", () => {
    // No job manager: the job skills are absent, and so are the execution skills
    // whose handler needs one.
    expect(servedSkills(false)).toHaveLength(4);
    for (const skill of ["process.list", "process.stop", "session.abort"]) {
      expect(servedSkills(false)).not.toContain(skill);
      expect(servedSkills(true, true)).toContain(skill);
    }
    // A manager WITHOUT an open gate: the job skills are honest, because the
    // manager really can serve them, but execution is not advertised because the
    // gate would refuse it. This is the combination the exported server
    // constructor allows, and the reason servedSkills takes two flags.
    const managerOnly = servedSkills(true, false);
    expect(managerOnly).toEqual([...ALWAYS_SERVED_SKILLS, ...JOB_SKILLS]);
    for (const skill of EXECUTION_SKILLS) {
      expect(managerOnly).not.toContain(skill);
    }
    // An open gate WITHOUT a manager advertises no execution skill at all:
    // mesh.handoff delegates to the local process.spawn, so it needs the manager
    // too - the indirection that made this wrong twice.
    expect(servedSkills(false, true)).toEqual([...ALWAYS_SERVED_SKILLS]);
    expect(servedSkills(true, true)).toHaveLength(10);
    expect(servedSkills(true, true)).toContain("session.steer");
  });

  it("T12 refuses every execution skill when there is no job manager", async () => {
    // Behavioural, not a list of names: this is what makes the advertisement
    // rule (execution needs BOTH a manager and the gate) true rather than
    // declared. A future execution skill that does not refuse here would fail
    // this test, and its author has to decide which side it belongs on.
    //
    // mesh.handoff is the reason this test exists: it never mentions
    // options.jobs, it delegates to the local process.spawn, so a grep for the
    // manager finds nothing and the dependency is easy to miss.
    const skills = createSkillRegistry();
    const local = "11111111-1111-4111-8111-111111111111";
    const inputs: Record<string, unknown> = {
      "process.spawn": { project: "p", prompt: "hi" },
      "session.steer": { job_id: "j", message: "hi" },
      "mesh.handoff": {
        task: "t",
        project: "p",
        context: {},
        preferred_agent: local,
        deadline_ms: 1_000,
        _localPeerId: local,
      },
    };
    for (const skill of EXECUTION_SKILLS) {
      // Registered, so the refusal below cannot be the registry's own "Skill is
      // not supported" - which is ALSO -32004, and would let an unregistered
      // skill satisfy this test without ever needing a manager.
      expect(skills.has(skill), `${skill} must be registered`).toBe(true);
      await expect(
        skills.invoke(skill, inputs[skill]),
        `${skill} must need a job manager`,
      ).rejects.toMatchObject({
        code: -32004,
        message: expect.stringContaining("requires a job manager"),
      });
    }
  });

  it("T13 advertises no execution skill when a manager exists but the gate is closed", async () => {
    // The exported constructor takes jobs and spawnPolicy independently, so this
    // state is reachable outside the CLI. It must not advertise execution the
    // dispatch gate would answer with -32102.
    const test = await setup("abort");
    const server = createAgentServer({
      port: 0,
      swarmKey: Buffer.alloc(32, 7),
      identity: {
        peerId: "22222222-2222-4222-8222-222222222222",
        name: "capability-honesty",
      },
      jobs: test.jobs,
    });
    try {
      const address = await server.start();
      const response = await fetch(
        `http://127.0.0.1:${address.port}/.well-known/agent-card.json`,
      );
      const card = (await response.json()) as { skills: Array<{ id: string }> };
      const advertised = card.skills.map((skill) => skill.id);
      expect(advertised).toContain("process.list");
      for (const skill of EXECUTION_SKILLS) {
        expect(advertised).not.toContain(skill);
      }
    } finally {
      await server.stop();
      await test.close();
    }
  });

  it("T10 process.list requires a job manager and exposes only the reduced job shape", async () => {
    const missingManager = createSkillRegistry();
    await expect(
      missingManager.invoke("process.list", {}),
    ).rejects.toMatchObject({
      code: -32004,
      message: "process.list requires a job manager",
    });

    const test = await setup("abort");
    try {
      const started = await test.record();
      const registry = createSkillRegistry({ jobs: test.jobs });
      const result = (await registry.invoke("process.list", {})) as {
        jobs: Array<Record<string, unknown>>;
      };
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]).toMatchObject({
        job_id: started.id,
        session_id: expect.any(String),
        pid: expect.any(Number),
        project: "project",
        cwd: expect.stringContaining("/workspace/project"),
        state: "running",
        started_at: expect.any(String),
      });
      expect(Object.keys(result.jobs[0]!)).toEqual([
        "job_id",
        "session_id",
        "pid",
        "project",
        "cwd",
        "state",
        "started_at",
      ]);
      expect(result.jobs[0]).not.toHaveProperty("argv");
      expect(result.jobs[0]).not.toHaveProperty("peerId");
    } finally {
      await test.close();
    }
  });

  it("T9 registers all three controls in the real registry", async () => {
    const jobs = new JobManager({
      spawnJob: (_spec, report) => ({
        pid: undefined,
        argv: [],
        stdioClosed: true,
        command: async (command) => ({ ...command, success: true }),
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
    // A prompt marked as a steer, not pi's `steer`: only the former reaches a
    // session that is alive but between turns (see the skill's comment and T6).
    await expect(
      registry.invoke("session.steer", {
        job_id: started.id,
        message: "hello",
      }),
    ).resolves.toMatchObject({ type: "prompt", streamingBehavior: "steer" });
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
