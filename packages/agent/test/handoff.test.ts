// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentCard } from "@pi-mesh/protocol";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAgentServer,
  createPiSpawner,
  createSkillRegistry,
  JobManager,
  parseSpawnPolicy,
  signedHeaders,
  type BonjourLike,
  type BonjourPublishOptions,
} from "../src/index.js";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174099";
const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const CALLER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const KEY = Buffer.from("pi-mesh-vector-key-0123456789abc");
const PI_BINARY = fileURLToPath(
  new URL("./fixtures/pi-binary", import.meta.url),
);
const HANDOFF_SKILLS = ["mesh.handoff", "process.spawn"].sort();

const serverIdentity = { peerId: SERVER_ID, name: "handoff-server" };
const callerIdentity = { peerId: CALLER_ID, name: "handoff-caller" };
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type RpcResponse = {
  result?: {
    task?: {
      id?: string;
      status?: {
        state?: string;
        message?: { parts?: { data?: { result?: unknown } }[] };
      };
    };
    message?: { parts?: { data?: { result?: unknown } }[] };
    id?: string;
    status?: { state?: string };
  };
  error?: { code?: number; message?: string };
};

type Harness = {
  binary: string;
  jobs: JobManager;
  port: number;
  project: string;
  root: string;
  sessionsRoot: string;
  stop: () => Promise<void>;
};

function handoffInput(overrides: Record<string, unknown> = {}) {
  return {
    task: "inspect the exact handoff fixture",
    project: "project",
    context: {},
    preferred_agent: null,
    deadline_ms: 2_000,
    ...overrides,
  };
}

function sendMessage(skill: string, input: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        messageId: "handoff-message",
        role: "ROLE_USER",
        parts: [{ data: { skill, input } }],
      },
    },
  };
}

function post(
  port: number,
  body: Record<string, unknown>,
): Promise<RpcResponse> {
  const text = JSON.stringify(body);
  const headers = signedHeaders(KEY, callerIdentity, {
    method: "POST",
    path: "/",
    recipientPeerId: SERVER_ID,
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
        let received = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (received += chunk));
        response.on("end", () => resolve(JSON.parse(received) as RpcResponse));
      },
    );
    client.on("error", reject);
    client.end(text);
  });
}

function skillResult(response: RpcResponse): unknown {
  return (
    response.result?.task?.status?.message?.parts?.[0]?.data?.result ??
    response.result?.message?.parts?.[0]?.data?.result
  );
}

function fixtureSource(delayMs: number): string {
  return `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const delay = ${delayMs};
let input = "";
const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const response = (id, value) => write({ type: "response", id, ...value });
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
        setTimeout(() => response(command.id, {
          command: "get_state",
          success: true,
          data: { sessionId: ${JSON.stringify(SESSION_ID)}, sessionFile: join(process.cwd(), "session.jsonl") },
        }), delay);
      } else if (command.type === "prompt") {
        if (typeof command.message !== "string") throw new Error("prompt must be a string");
        process.stderr.write("prompt=" + JSON.stringify(command.message) + "\\n");
        appendFileSync(join(process.cwd(), "accepted-prompts.jsonl"), JSON.stringify(command.message) + "\\n");
        const sessionDirIndex = process.argv.indexOf("--session-dir");
        if (sessionDirIndex !== -1) {
          const sessionDir = process.argv[sessionDirIndex + 1];
          mkdirSync(sessionDir, { recursive: true });
          writeFileSync(join(sessionDir, "accepted-" + process.pid + ".jsonl"), JSON.stringify({ id: ${JSON.stringify(SESSION_ID)} }) + "\\n");
        }
        response(command.id, { success: true, accepted: true });
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

async function startHarness(options: {
  allowExecution: boolean;
  readinessDelayMs?: number;
}): Promise<Harness> {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "pi-mesh-handoff-")),
  );
  const root = join(parent, "workspace");
  const project = join(root, "project");
  const sessionsRoot = join(parent, "sessions");
  const binary = join(parent, "pi-handoff-fixture.mjs");
  await mkdir(project, { recursive: true });
  await writeFile(binary, fixtureSource(options.readinessDelayMs ?? 0));
  await chmod(binary, 0o755);

  const jobs = new JobManager({
    spawnJob: createPiSpawner({
      workspaceRoot: root,
      piBinary: binary,
      sessionsRoot,
      readinessTimeoutMs: 2_000,
      logger,
    }),
    unacknowledgedTtlMs: 5_000,
    logger,
  });
  const skillRegistry = createSkillRegistry({ jobs, workspaceRoot: root });
  const server = createAgentServer({
    host: "127.0.0.1",
    port: 0,
    swarmKey: KEY,
    identity: serverIdentity,
    sessionsRoot,
    skillRegistry,
    jobs,
    spawnPolicy: parseSpawnPolicy(options.allowExecution ? "*" : undefined, ""),
  });
  const address = await server.start();
  return {
    binary,
    jobs,
    port: address.port,
    project,
    root,
    sessionsRoot,
    stop: async () => {
      await server.stop();
      await jobs.shutdown();
    },
  };
}

function promptLines(jobs: JobManager): string[] {
  return jobs
    .list()
    .flatMap((job) => jobs.output(job.id))
    .filter((line) => line.startsWith("prompt="))
    .map((line) => JSON.parse(line.slice("prompt=".length)) as string);
}

function fixturePids(binary: string): number[] {
  const rows = execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  }).split("\n");
  return rows
    .filter((row) => row.includes(binary))
    .map((row) => Number(row.trim().split(/\s+/, 1)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function filesBelow(path: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const relative = join(prefix, entry.name);
      result.push(relative);
      if (entry.isDirectory())
        await visit(join(directory, entry.name), relative);
    }
  }
  await visit(path, "");
  return result.sort();
}

async function waitForNoFixture(binary: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fixturePids(binary).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function acceptedControl(
  harness: Harness,
  task: string,
  clause: "Clause 2" | "Clause 4",
) {
  const response = await post(
    harness.port,
    sendMessage("mesh.handoff", handoffInput({ task })),
  );
  expect(
    response.error,
    `${clause} control: an enabled, reachable peer must accept a handoff before no-start assertions can mean anything`,
  ).toBeUndefined();
  const result = skillResult(response) as
    { task_id?: string; session_id?: string; job_id?: string } | undefined;
  expect(
    result?.job_id,
    `${clause} control: the accepted handoff must expose a real job_id`,
  ).toBeTypeOf("string");
  return { response, result: result! };
}

describe("M3-1 mesh.handoff", () => {
  it("clause 1: starts exactly one prompted session and returns task_id, session_id, and job_id", async () => {
    const harness = await startHarness({ allowExecution: true });
    try {
      const task = "review the handoff patch";
      const context = { ticket: "M3-1", priority: 7 };
      const response = await post(
        harness.port,
        sendMessage(
          "mesh.handoff",
          handoffInput({ task, context, preferred_agent: SERVER_ID }),
        ),
      );
      expect(
        response.error,
        "Clause 1: an enabled, reachable peer must accept mesh.handoff",
      ).toBeUndefined();

      const jobs = harness.jobs.list();
      expect(jobs.length, "Clause 1: exactly one session must start").toBe(1);
      expect(
        promptLines(harness.jobs).length,
        "Clause 1: exactly one initial prompt must be sent",
      ).toBe(1);
      const prompt = promptLines(harness.jobs)[0];
      expect(prompt, "Clause 1: the prompt must begin with the task").toMatch(
        /^review the handoff patch/,
      );
      expect(
        prompt,
        "Clause 1: non-empty context must be in the same prompt under a Context heading",
      ).toContain("Context");
      expect(
        prompt,
        "Clause 1: the prompt must contain context ticket M3-1",
      ).toContain("M3-1");
      expect(
        prompt,
        "Clause 1: the prompt must contain context priority 7",
      ).toContain("7");

      const wireTask = response.result?.task;
      expect(
        skillResult(response),
        "Clause 1: success must return the exact three watcher handles",
      ).toEqual({
        task_id: wireTask?.id,
        session_id: SESSION_ID,
        job_id: jobs[0]?.id,
      });
      expect(
        Object.keys((skillResult(response) ?? {}) as object).sort(),
        "Clause 1: success must return task_id, session_id, and job_id",
      ).toEqual(["job_id", "session_id", "task_id"]);
    } finally {
      await harness.stop();
    }
  });

  it("clause 2: preferred_agent rejection is a settled rejected task and starts no process, session, or file", async () => {
    const harness = await startHarness({ allowExecution: true });
    try {
      const control = await acceptedControl(
        harness,
        "positive control",
        "Clause 2",
      );
      expect(
        fixturePids(harness.binary).length,
        "Clause 2 control: the process table must observe one running fixture",
      ).toBe(1);
      expect(
        harness.jobs.list().length,
        "Clause 2 control: the job table must be observably non-empty",
      ).toBe(1);
      expect(
        (await filesBelow(harness.sessionsRoot)).length,
        "Clause 2 control: the accepted session must create observable session storage",
      ).toBeGreaterThan(0);

      await harness.jobs.stop(control.result.job_id!);
      await waitForNoFixture(harness.binary);
      const jobIdsBefore = harness.jobs.list().map((job) => job.id);
      const sessionIdsBefore = harness.jobs
        .list()
        .map((job) => job.sessionId)
        .filter((id) => id !== undefined);
      const filesBefore = await filesBelow(harness.sessionsRoot);
      const workspaceFilesBefore = await filesBelow(harness.root);

      const rejected = await post(
        harness.port,
        sendMessage(
          "mesh.handoff",
          handoffInput({
            task: "must be rejected",
            preferred_agent: OTHER_ID,
          }),
        ),
      );
      expect(
        rejected.error,
        "Clause 2: preferred_agent rejection must not be a JSON-RPC error",
      ).toBeUndefined();
      expect(
        rejected.result?.task?.status?.state,
        "Clause 2: preferred_agent must positively settle a rejected task",
      ).toBe("TASK_STATE_REJECTED");

      const taskId = rejected.result?.task?.id;
      const settled = await post(harness.port, {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/get",
        params: { id: taskId },
      });
      expect(
        settled.result?.status?.state,
        "Clause 2: tasks/get must retain the settled rejection",
      ).toBe("TASK_STATE_REJECTED");
      expect(
        harness.jobs.list().map((job) => job.id),
        "Clause 2: rejection must add no job or process",
      ).toEqual(jobIdsBefore);
      expect(
        harness.jobs
          .list()
          .map((job) => job.sessionId)
          .filter((id) => id !== undefined),
        "Clause 2: rejection must add no session",
      ).toEqual(sessionIdsBefore);
      expect(
        await filesBelow(harness.sessionsRoot),
        "Clause 2: rejection must create no session file",
      ).toEqual(filesBefore);
      expect(
        await filesBelow(harness.root),
        "Clause 2: rejection must create no workspace file",
      ).toEqual(workspaceFilesBefore);
      expect(
        fixturePids(harness.binary),
        "Clause 2: rejection must leave no fixture process running",
      ).toEqual([]);
    } finally {
      await harness.stop();
    }
  });

  it("clause 3: execution-disabled handoff is exactly -32102", async () => {
    const harness = await startHarness({ allowExecution: false });
    try {
      const denied = await post(
        harness.port,
        sendMessage("mesh.handoff", handoffInput()),
      );
      expect(
        denied.error?.code,
        "Clause 3: execution-disabled mesh.handoff must be PI_MESH_SPAWN_DENIED",
      ).toBe(-32102);
      expect(
        harness.jobs.list(),
        "Clause 3: policy denial must start no job",
      ).toEqual([]);
    } finally {
      await harness.stop();
    }
  });

  it("clause 4: expiry before acceptance settles cleanly and leaves nothing running", async () => {
    const harness = await startHarness({
      allowExecution: true,
      readinessDelayMs: 150,
    });
    try {
      const control = await acceptedControl(
        harness,
        "deadline control",
        "Clause 4",
      );
      expect(
        fixturePids(harness.binary).length,
        "Clause 4 control: a long deadline must leave one accepted process observable",
      ).toBe(1);
      await harness.jobs.stop(control.result.job_id!);
      await waitForNoFixture(harness.binary);
      const baselineIds = new Set(harness.jobs.list().map((job) => job.id));

      const expired = await post(
        harness.port,
        sendMessage(
          "mesh.handoff",
          handoffInput({ task: "deadline must expire", deadline_ms: 10 }),
        ),
      );
      expect(
        expired.error,
        "Clause 4: an acceptance deadline is a clean settled failure, not a JSON-RPC error",
      ).toBeUndefined();
      expect(
        expired.result?.task?.status?.state,
        "Clause 4: expiry before acceptance must settle as TASK_STATE_REJECTED",
      ).toBe("TASK_STATE_REJECTED");

      await waitForNoFixture(harness.binary);
      expect(
        fixturePids(harness.binary),
        "Clause 4: expiry must leave no pi fixture in ps",
      ).toEqual([]);
      expect(
        harness.jobs
          .list()
          .filter((job) => !baselineIds.has(job.id) && job.state !== "exited"),
        "Clause 4: expiry must leave no accepted or running job-table entry",
      ).toEqual([]);
    } finally {
      await harness.stop();
    }
  });

  it("clause 5: project traversal and an outside symlink get the same -32102 containment refusal as process.spawn", async () => {
    const harness = await startHarness({ allowExecution: true });
    const outside = join(harness.root, "..", "outside");
    await mkdir(outside);
    await symlink(outside, join(harness.root, "escape"));
    try {
      for (const project of ["../outside", "escape"]) {
        const spawn = await post(
          harness.port,
          sendMessage("process.spawn", {
            project: "containment-control",
            cwd: project,
            prompt: "must not start",
          }),
        );
        const handoff = await post(
          harness.port,
          sendMessage(
            "mesh.handoff",
            handoffInput({ task: "must not start", project }),
          ),
        );
        expect(
          [spawn.error?.code, handoff.error?.code],
          `Clause 5: project ${project} must match process.spawn containment`,
        ).toEqual([-32102, -32102]);
      }
      expect(
        harness.jobs.list(),
        "Clause 5: neither containment escape may start a job",
      ).toEqual([]);
      expect(
        fixturePids(harness.binary),
        "Clause 5: neither containment escape may start a process",
      ).toEqual([]);
    } finally {
      await harness.stop();
    }
  });

  it("clause 6: preferred-agent rejection and policy denial have distinct exact representations", async () => {
    const allowed = await startHarness({ allowExecution: true });
    const denied = await startHarness({ allowExecution: false });
    try {
      const rejection = await post(
        allowed.port,
        sendMessage(
          "mesh.handoff",
          handoffInput({ preferred_agent: OTHER_ID }),
        ),
      );
      const denial = await post(
        denied.port,
        sendMessage(
          "mesh.handoff",
          handoffInput({ preferred_agent: SERVER_ID }),
        ),
      );
      expect(
        {
          rejectionCode: rejection.error?.code,
          rejectionState: rejection.result?.task?.status?.state,
          denialCode: denial.error?.code,
          denialState: denial.result?.task?.status?.state,
        },
        "Clause 6: rejection must be TASK_STATE_REJECTED while denial must be -32102",
      ).toEqual({
        rejectionCode: undefined,
        rejectionState: "TASK_STATE_REJECTED",
        denialCode: -32102,
        denialState: undefined,
      });
    } finally {
      await allowed.stop();
      await denied.stop();
    }
  });
});

class PublishedBonjour implements BonjourLike {
  readonly published: BonjourPublishOptions[] = [];

  publish(options: BonjourPublishOptions): void {
    this.published.push(options);
  }

  find(): { stop(): void } {
    return { stop: () => undefined };
  }

  destroy(): void {}
}

type CapabilityObservation = { card: string[]; caps: string[] };

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not settle`)), 5_000),
    ),
  ]);
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("loopback listener did not expose a port");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

async function observeCapabilities(
  gate: string | undefined,
): Promise<CapabilityObservation> {
  const port = await unusedLoopbackPort();
  const bonjour = new PublishedBonjour();
  const previous = {
    port: process.env.PI_MESH_PORT,
    gate: process.env.PI_MESH_ALLOW_SPAWN,
    workspace: process.env.PI_MESH_WORKSPACE,
    binary: process.env.PI_MESH_PI_BINARY,
  };
  process.env.PI_MESH_PORT = String(port);
  process.env.PI_MESH_WORKSPACE = process.cwd();
  process.env.PI_MESH_PI_BINARY = PI_BINARY;
  if (gate === undefined) delete process.env.PI_MESH_ALLOW_SPAWN;
  else process.env.PI_MESH_ALLOW_SPAWN = gate;

  vi.resetModules();
  const { run } = await import("../src/cli.js");
  const running = run(["start"], {
    stdout: { write: () => true },
    stderr: { write: () => true },
    bonjour,
    identity: serverIdentity,
    swarmKey: KEY,
  });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (bonjour.published.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (bonjour.published.length !== 1) {
      throw new Error("agent did not publish exactly one DNS-SD record");
    }
    const response = await fetch(
      `http://127.0.0.1:${port}/.well-known/agent-card.json`,
      { signal: AbortSignal.timeout(2_000) },
    );
    const card = (await response.json()) as AgentCard;
    const caps = bonjour.published[0]?.txt?.caps;
    return {
      card: card.skills.map((skill) => skill.id).sort(),
      caps: typeof caps === "string" ? caps.split(",").sort() : [],
    };
  } finally {
    process.emit("SIGINT");
    await withDeadline(running, "agent shutdown");
    if (previous.port === undefined) delete process.env.PI_MESH_PORT;
    else process.env.PI_MESH_PORT = previous.port;
    if (previous.gate === undefined) delete process.env.PI_MESH_ALLOW_SPAWN;
    else process.env.PI_MESH_ALLOW_SPAWN = previous.gate;
    if (previous.workspace === undefined) delete process.env.PI_MESH_WORKSPACE;
    else process.env.PI_MESH_WORKSPACE = previous.workspace;
    if (previous.binary === undefined) delete process.env.PI_MESH_PI_BINARY;
    else process.env.PI_MESH_PI_BINARY = previous.binary;
  }
}

describe("M3-1 clause 3 capability honesty", () => {
  let disabled: CapabilityObservation;
  let enabled: CapabilityObservation;

  beforeAll(async () => {
    disabled = await observeCapabilities(undefined);
    enabled = await observeCapabilities("*");
  });

  it("advertises the exact process.spawn + mesh.handoff pair at the card and DNS-SD caps boundaries only when enabled", () => {
    expect(
      disabled.card.filter((skill) => HANDOFF_SKILLS.includes(skill)),
      "Clause 3: disabled HTTP card must advertise neither process.spawn nor mesh.handoff",
    ).toEqual([]);
    expect(
      disabled.caps.filter((skill) => HANDOFF_SKILLS.includes(skill)),
      "Clause 3: disabled DNS-SD caps must advertise neither process.spawn nor mesh.handoff",
    ).toEqual([]);
    expect(
      enabled.card.filter((skill) => HANDOFF_SKILLS.includes(skill)),
      "Clause 3: enabled HTTP card must advertise exactly mesh.handoff and process.spawn",
    ).toEqual(HANDOFF_SKILLS);
    expect(
      enabled.caps.filter((skill) => HANDOFF_SKILLS.includes(skill)),
      "Clause 3: enabled DNS-SD caps must advertise exactly mesh.handoff and process.spawn",
    ).toEqual(HANDOFF_SKILLS);
    expect(
      { disabledAgreement: disabled.card, enabledAgreement: enabled.card },
      "Clause 3: HTTP card and DNS-SD caps must agree in both gate states",
    ).toEqual({
      disabledAgreement: disabled.caps,
      enabledAgreement: enabled.caps,
    });
  });
});
