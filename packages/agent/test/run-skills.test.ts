// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * M8-5 (`run.list` / `run.findings`) with M8-3's capability classification.
 *
 * Agent test style throughout: injected roots, in-process servers and
 * registries, no machine state. Real calls over the signed wire for the
 * honesty clauses, fixtures under a temp dir for everything else.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KillFn } from "@pi-mesh/runs";
import {
  createAgentServer,
  createSkillRegistry,
  getSessionStorageDir,
  isExecutionSkill,
  JobManager,
  servedSkills,
  signedHeaders,
  SKILL_CLASSIFICATION,
  type AgentServer,
} from "../src/index.js";

const testIdentity = {
  peerId: "22222222-2222-4222-8222-222222222222",
  name: "run-skills-test",
};
const testKey = Buffer.from("pi-mesh-vector-key-0123456789abc");
const sessionId = "123e4567-e89b-42d3-a456-426614174099";
const homeDir = homedir();

const ALWAYS_SKILLS = [
  "mesh.peers",
  "mesh.watch",
  "session.list",
  "session.read",
  "session.stream",
  "session.models",
];
const JOB_SKILLS = [
  "process.list",
  "process.stop",
  "session.abort",
  "session.commands",
  "session.status",
];
const EXECUTION_SKILLS = [
  "process.spawn",
  "session.steer",
  "session.resume",
  "session.set_model",
  "mesh.handoff",
];
const RUN_SKILLS = ["run.list", "run.findings"];
// M8-8 run control: gated execution needing a recognised run layout (never
// a JobManager). Advertised only where the layout exists and the gate is
// open - which is exactly the full fixture below.
const RUN_CONTROL_SKILLS = ["run.stop", "run.steer"];

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A JobManager that starts nothing: every spawn is answered in-process. */
function stubJobs(): JobManager {
  return new JobManager({
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
}

type HttpResult = { status: number; body: string };

interface WireRpcResponse {
  error?: { code?: number; message?: string };
  result?: {
    message?: { parts?: Array<{ data?: { result?: unknown } }> };
  };
}

function skillResult(parsed: WireRpcResponse): Record<string, unknown> {
  const result = parsed.result?.message?.parts?.[0]?.data?.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return {};
  }
  return result as Record<string, unknown>;
}

function postRpc(
  port: number,
  body: unknown,
): Promise<{ status: number; parsed: WireRpcResponse }> {
  const text = JSON.stringify(body);
  const headers = signedHeaders(testKey, testIdentity, {
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

function streamRpc(port: number, body: unknown): Promise<HttpResult> {
  const text = JSON.stringify(body);
  const headers = signedHeaders(testKey, testIdentity, {
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
        response.once("error", () => undefined);
        response.once("data", (chunk: Buffer) => {
          resolve({
            status: response.statusCode ?? 0,
            body: chunk.toString("utf8"),
          });
          client.destroy();
        });
      },
    );
    client.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") {
        reject(error);
      }
    });
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

function inputFor(skill: string): Record<string, unknown> {
  switch (skill) {
    case "session.read":
      return { id: "123e4567-e89b-42d3-a456-426614174098" };
    case "process.stop":
    case "session.abort":
    case "session.commands":
    case "session.status":
      return { job_id: "missing" };
    // project is the operator's real home directory: it always resolves
    // inside the default workspace root on any machine, so the accident
    // guard passes deterministically and the stub JobManager decides.
    case "process.spawn":
      return { project: homeDir, prompt: "hi" };
    case "session.steer":
      return { job_id: "missing", message: "hi" };
    case "session.resume":
      return { session_id: "123e4567-e89b-42d3-a456-426614174101" };
    // A named job exercises the handler's job lookup (deterministic
    // -32103) instead of the Pi model catalog, which answers success on
    // any machine with a real `pi` binary and -32106 elsewhere.
    case "session.models":
      return { job_id: "missing" };
    case "session.set_model":
      return { job_id: "missing", provider: "p", model_id: "m" };
    case "mesh.handoff":
      return {
        task: "t",
        project: homeDir,
        context: {},
        preferred_agent: testIdentity.peerId,
        deadline_ms: 1000,
      };
    case "run.stop":
      return { run_id: "missing" };
    case "run.steer":
      return { run_id: "missing", message: "hi" };
    default:
      return {};
  }
}

/**
 * What a served skill answers with the fixtures below: success, or the
 * specific refusal that proves the handler ran. The point of naming every
 * code is that -32004 (or anything else unlisted) fails the clause by name.
 */
const FULL_CODES: Record<string, number | "ok"> = {
  "mesh.peers": "ok",
  "session.list": "ok",
  "process.list": "ok",
  "run.list": "ok",
  "run.findings": "ok",
  "session.read": -32101,
  "session.models": -32103,
  "process.stop": -32103,
  "session.abort": -32103,
  "session.commands": -32103,
  "session.status": -32103,
  "session.steer": -32103,
  "session.set_model": -32103,
  "process.spawn": -32105,
  "session.resume": -32602,
  "mesh.handoff": -32105,
  "mesh.watch": -32004,
  // Full fixture has a layout but no such run: unknown run proves the
  // control handler ran (a -32004 here would mean the requirement failed).
  "run.stop": -32108,
  "run.steer": -32108,
};

const allowAll = { allows: () => true, enabled: true };

let layoutTmp = "";
let emptyTmp = "";
let sessionsRoot = "";
let fullPort = 0;
let minimalPort = 0;
let servers: AgentServer[] = [];
let jobs: JobManager | undefined;

beforeAll(async () => {
  layoutTmp = await mkdtemp(join(tmpdir(), "pi-mesh-runs-layout-"));
  await mkdir(join(layoutTmp, "pi-subagents-a", "async-subagent-runs"), {
    recursive: true,
  });
  emptyTmp = await mkdtemp(join(tmpdir(), "pi-mesh-runs-empty-"));

  sessionsRoot = await mkdtemp(join(tmpdir(), "pi-mesh-runs-sessions-"));
  const directory = getSessionStorageDir("/fixture/project", sessionsRoot);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "session.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2024-01-01T00:00:00Z", cwd: "/fixture/project" })}\n`,
  );

  jobs = stubJobs();
  const full = createAgentServer({
    port: 0,
    swarmKey: testKey,
    identity: testIdentity,
    jobs,
    runsTmp: layoutTmp,
    rulesPath: join(layoutTmp, "no-such-rules.json"),
    sessionsRoot,
    spawnPolicy: allowAll,
  });
  const minimal = createAgentServer({
    port: 0,
    swarmKey: testKey,
    identity: testIdentity,
    runsTmp: emptyTmp,
    sessionsRoot,
    spawnPolicy: allowAll,
  });
  servers = [full, minimal];
  fullPort = (await full.start()).port;
  minimalPort = (await minimal.start()).port;
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()));
  servers = [];
  await jobs?.shutdown();
  jobs = undefined;
  await rm(layoutTmp, { recursive: true, force: true });
  await rm(emptyTmp, { recursive: true, force: true });
  await rm(sessionsRoot, { recursive: true, force: true });
});

async function cardSkills(port: number): Promise<string[]> {
  const response = await fetch(
    `http://127.0.0.1:${port}/.well-known/agent-card.json`,
  );
  const card = (await response.json()) as { skills: Array<{ id: string }> };
  return card.skills.map((skill) => skill.id).sort();
}

describe("M8-5 capability honesty over the signed wire", () => {
  it("honesty-advertised-minimal: with no jobs and no run layout, exactly the six always skills are advertised", async () => {
    await expect(
      cardSkills(minimalPort),
      "honesty-advertised-minimal: advertisement must be exactly the always-served set",
    ).resolves.toEqual([...ALWAYS_SKILLS].sort());
  });

  it("honesty-advertised-full: with jobs, an open gate and a layout, all twenty skills are advertised", async () => {
    await expect(
      cardSkills(fullPort),
      "honesty-advertised-full: advertisement must be the full served set",
    ).resolves.toEqual(
      [
        ...ALWAYS_SKILLS,
        ...JOB_SKILLS,
        ...EXECUTION_SKILLS,
        ...RUN_SKILLS,
        ...RUN_CONTROL_SKILLS,
      ].sort(),
    );
  });

  for (const skill of [
    ...JOB_SKILLS,
    ...EXECUTION_SKILLS,
    ...RUN_SKILLS,
    ...RUN_CONTROL_SKILLS,
  ]) {
    it(`honesty-minimal: unadvertised ${skill} answers -32004 with a stated reason`, async () => {
      const { parsed } = await postRpc(
        minimalPort,
        call(skill, inputFor(skill)),
      );
      expect(
        parsed.error?.code,
        `honesty-minimal: ${skill} is not advertised, so it must answer -32004 (got ${JSON.stringify(parsed).slice(0, 200)})`,
      ).toBe(-32004);
      if (RUN_SKILLS.includes(skill) || RUN_CONTROL_SKILLS.includes(skill)) {
        expect(
          parsed.error?.message,
          `honesty-minimal: ${skill} must name the missing run layout`,
        ).toMatch(/recognised run layout/);
      } else {
        expect(
          parsed.error?.message,
          `honesty-minimal: ${skill} must name the missing job manager`,
        ).toMatch(/requires a job manager/);
      }
    });
  }

  for (const skill of Object.keys(FULL_CODES)) {
    it(`honesty-full: advertised ${skill} answers (never -32004)`, async () => {
      const expected = FULL_CODES[skill]!;
      const { parsed } = await postRpc(fullPort, call(skill, inputFor(skill)));
      if (expected === "ok") {
        expect(
          parsed.error,
          `honesty-full: advertised ${skill} must be served (got error ${JSON.stringify(parsed.error)?.slice(0, 200)})`,
        ).toBeUndefined();
      } else {
        expect(
          parsed.error?.code,
          `honesty-full: advertised ${skill} must answer ${expected}, proving the handler ran (got ${JSON.stringify(parsed).slice(0, 200)})`,
        ).toBe(expected);
      }
    });
  }

  it("honesty-full: advertised session.stream streams (never -32004)", async () => {
    const response = await streamRpc(fullPort, {
      ...call("session.stream", { id: sessionId }),
      method: "message/stream",
    });
    expect(
      response.status,
      "honesty-full: advertised session.stream must stream",
    ).toBe(200);
    expect(
      response.body,
      "honesty-full: advertised session.stream must stream a task",
    ).toContain('"task"');
  });

  it("honesty-full: advertised mesh.watch streams inventory facts (never -32004)", async () => {
    const response = await streamRpc(fullPort, {
      ...call("mesh.watch", {}),
      method: "message/stream",
    });
    expect(
      response.status,
      "honesty-full: advertised mesh.watch must stream",
    ).toBe(200);
    expect(
      response.body,
      "honesty-full: advertised mesh.watch must stream a task",
    ).toContain('"task"');
  });

  it("honesty-full: run.findings with no rules file uses the module defaults", async () => {
    const { parsed } = await postRpc(fullPort, call("run.findings", {}));
    expect(parsed.error).toBeUndefined();
    expect(skillResult(parsed).config).toEqual({
      staleMs: 5 * 60 * 1000,
      longMs: 30 * 60 * 1000,
      maxCostUsd: 5,
      maxTokens: 2_000_000,
      failureStreak: 3,
    });
  });
});

describe("M8-3 one classification table", () => {
  it("one-source-requirement: dropping run.list's run-layout requirement advertises and serves it together", async () => {
    const previous = SKILL_CLASSIFICATION["run.list"];
    SKILL_CLASSIFICATION["run.list"] = { exposure: "peer", requires: "none" };
    try {
      expect(
        servedSkills(false, false, false),
        "one-source-requirement: the advertisement must follow the table",
      ).toContain("run.list");
      const registry = createSkillRegistry({
        runsTmp: emptyTmp,
        rulesPath: join(emptyTmp, "no-such-rules.json"),
      });
      const result = (await registry.invoke("run.list", {})) as {
        runs: unknown[];
        coverage: { layout_recognised: boolean };
      };
      expect(
        result.runs,
        "one-source-requirement: the server answer must follow the table",
      ).toEqual([]);
      // Coverage still tells the truth: served is not the same as recognised.
      expect(result.coverage.layout_recognised).toBe(false);
    } finally {
      SKILL_CLASSIFICATION["run.list"] = previous;
    }
  });

  it("one-source-exposure: gating session.list removes it from the advertisement and puts it behind the gate", () => {
    const previous = SKILL_CLASSIFICATION["session.list"];
    SKILL_CLASSIFICATION["session.list"] = {
      exposure: "gated",
      requires: "none",
    };
    try {
      expect(
        servedSkills(false, false, false),
        "one-source-exposure: a gated skill must leave the closed-gate advertisement",
      ).not.toContain("session.list");
      expect(
        servedSkills(false, true, false),
        "one-source-exposure: a gated skill must join the open-gate advertisement",
      ).toContain("session.list");
      expect(
        isExecutionSkill("session.list"),
        "one-source-exposure: the dispatch gate reads the same table",
      ).toBe(true);
    } finally {
      SKILL_CLASSIFICATION["session.list"] = previous;
    }
    expect(isExecutionSkill("session.list")).toBe(false);
  });
});

const NOW = 1_750_000_000_000;

async function writeStatus(
  tmp: string,
  scope: string,
  runId: string,
  status: Record<string, unknown>,
): Promise<void> {
  const dir = join(tmp, scope, "async-subagent-runs", runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "status.json"), JSON.stringify(status));
}

describe("M8-5 run.list against fixtures", () => {
  it("list-tristate: liveness is tri-state with evidence, and the ADR 0021 fields are mapped", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-mesh-runs-list-"));
    try {
      await writeStatus(tmp, "pi-subagents-a", "run-alive", {
        runId: "run-alive",
        state: "running",
        pid: 101,
        sessionId: "/parent/a.jsonl",
        sessionFile: "/child/a/session.jsonl",
        mode: "async",
        startedAt: NOW - 60_000,
        lastUpdate: NOW - 1_000,
        steps: [{ agent: "coder", status: "ok", sessionFile: "s" }],
        totalTokens: { input: 1, output: 2, total: 3 },
        totalCost: { costUsd: 1.5 },
      });
      await writeStatus(tmp, "pi-subagents-a", "run-dead", {
        runId: "run-dead",
        state: "running",
        pid: 102,
        startedAt: NOW - 60_000,
        lastUpdate: NOW - 1_000,
      });
      await writeStatus(tmp, "pi-subagents-a", "run-nopid", {
        runId: "run-nopid",
        state: "paused",
        startedAt: NOW - 60_000,
        lastUpdate: NOW - 1_000,
      });
      await writeStatus(tmp, "pi-subagents-a", "run-eperm", {
        runId: "run-eperm",
        state: "queued",
        pid: 103,
        startedAt: NOW - 60_000,
        lastUpdate: NOW - 1_000,
      });
      const signals: Array<{ pid: number; signal: 0 }> = [];
      const kill: KillFn = (pid: number, signal: 0) => {
        signals.push({ pid, signal });
        if (pid === 102) {
          throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        }
        if (pid === 103) {
          throw Object.assign(new Error("operation not permitted"), {
            code: "EPERM",
          });
        }
      };
      // No JobManager anywhere near this registry: the read starts no
      // process, and the injected probe observes every signal it sends.
      const registry = createSkillRegistry({
        runsTmp: tmp,
        rulesPath: join(tmp, "no-such-rules.json"),
        runsNow: () => NOW,
        runsLiveness: { kill, platform: "darwin" },
      });
      const result = (await registry.invoke("run.list", {})) as {
        runs: Array<{
          run_id: string;
          state?: string;
          pid?: number;
          parent_session?: string;
          child_session?: string;
          agent?: string;
          mode?: string;
          started_at?: string;
          last_update?: string;
          status_age_ms?: number;
          steps?: unknown[];
          tokens?: unknown;
          cost_usd?: number;
          liveness?: {
            state?: string;
            reason?: string;
            probed_at?: string;
            status_age_ms?: number;
          };
        }>;
        coverage: Record<string, unknown>;
        evaluated_at: string;
      };
      expect(
        result.runs.map((run) => run.run_id).sort(),
        "list-tristate: every fixture run is listed",
      ).toEqual(["run-alive", "run-dead", "run-eperm", "run-nopid"]);
      const byId = Object.fromEntries(
        result.runs.map((run) => [run.run_id, run]),
      );
      expect(byId["run-alive"]!.liveness).toMatchObject({
        state: "alive",
        reason: "pid-alive",
        probed_at: new Date(NOW).toISOString(),
        status_age_ms: 1_000,
      });
      // A run claiming `running` with a dead pid is not alive.
      expect(byId["run-dead"]!.liveness).toMatchObject({
        state: "dead",
        reason: "pid-dead",
      });
      expect(byId["run-nopid"]!.liveness).toMatchObject({
        state: "unknown",
        reason: "no-pid",
      });
      // EPERM is unknown, not alive.
      expect(byId["run-eperm"]!.liveness).toMatchObject({
        state: "unknown",
        reason: "permission-denied",
      });
      // The ADR 0021 decision-1 fields travel with the run.
      expect(byId["run-alive"]).toMatchObject({
        state: "running",
        pid: 101,
        parent_session: "/parent/a.jsonl",
        child_session: "/child/a/session.jsonl",
        agent: "coder",
        mode: "async",
        started_at: new Date(NOW - 60_000).toISOString(),
        last_update: new Date(NOW - 1_000).toISOString(),
        status_age_ms: 1_000,
        tokens: { input: 1, output: 2, total: 3 },
        cost_usd: 1.5,
      });
      expect(byId["run-alive"]!.steps ?? []).toHaveLength(1);
      expect(result.coverage).toMatchObject({
        layout_recognised: true,
        last_error: null,
      });
      expect(typeof result.coverage.last_success).toBe("string");
      expect(result.evaluated_at).toBe(new Date(NOW).toISOString());
      // Only signal 0 is ever sent - and the probe ran, so this is a
      // positive control, not a vacuous pass over an empty spy.
      expect(signals.length).toBeGreaterThan(0);
      for (const { signal } of signals) {
        expect(signal).toBe(0);
      }
      expect(
        signals.map(({ pid }) => pid).sort((a, b) => a - b),
        "list-tristate: every pid run was probed exactly once",
      ).toEqual([101, 102, 103]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("list-malformed: a malformed status.json is not a run", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-mesh-runs-malformed-"));
    try {
      await writeStatus(tmp, "pi-subagents-a", "run-good", {
        runId: "run-good",
        state: "complete",
        startedAt: NOW - 1_000,
        lastUpdate: NOW - 500,
      });
      const badDir = join(
        tmp,
        "pi-subagents-a",
        "async-subagent-runs",
        "run-bad",
      );
      await mkdir(badDir, { recursive: true });
      await writeFile(join(badDir, "status.json"), "{not json");
      const noStatus = join(
        tmp,
        "pi-subagents-a",
        "async-subagent-runs",
        "run-nostatus",
      );
      await mkdir(noStatus, { recursive: true });
      const registry = createSkillRegistry({
        runsTmp: tmp,
        rulesPath: join(tmp, "no-such-rules.json"),
        runsNow: () => NOW,
        runsLiveness: { platform: "darwin" },
      });
      const result = (await registry.invoke("run.list", {})) as {
        runs: Array<{ run_id: string }>;
      };
      expect(
        result.runs.map((run) => run.run_id),
        "list-malformed: malformed and missing status files are skipped, never fabricated",
      ).toEqual(["run-good"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("list-window: an old active run is still listed; only terminal runs age out", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-mesh-runs-window-"));
    try {
      await writeStatus(tmp, "pi-subagents-a", "run-old-active", {
        runId: "run-old-active",
        state: "running",
        startedAt: NOW - 1_000_000,
        lastUpdate: NOW - 1_000_000,
      });
      await writeStatus(tmp, "pi-subagents-a", "run-old-terminal", {
        runId: "run-old-terminal",
        state: "complete",
        startedAt: NOW - 1_000_000,
        lastUpdate: NOW - 1_000_000,
      });
      const registry = createSkillRegistry({
        runsTmp: tmp,
        rulesPath: join(tmp, "no-such-rules.json"),
        runsNow: () => NOW,
        runsMaxAgeMs: 1_000,
        runsLiveness: { platform: "darwin" },
      });
      const result = (await registry.invoke("run.list", {})) as {
        runs: Array<{ run_id: string; status_age_ms: number }>;
      };
      expect(
        result.runs.map((run) => run.run_id),
        "list-window: no window drops live work",
      ).toEqual(["run-old-active"]);
      expect(result.runs[0]!.status_age_ms).toBeGreaterThan(1_000);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("M8-5 run.findings suppression epoch", () => {
  it("findings-once: fires once per epoch, re-arms only after it clears, and a restart may notify again", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-mesh-runs-findings-"));
    try {
      const stale = {
        runId: "run-stale",
        state: "running",
        startedAt: NOW - 60_000,
        lastUpdate: NOW - 30_000,
      };
      const fresh = {
        runId: "run-stale",
        state: "running",
        startedAt: NOW - 60_000,
        lastUpdate: NOW,
      };
      await writeStatus(tmp, "pi-subagents-a", "run-stale", stale);
      const rulesPath = join(tmp, "rules.json");
      await writeFile(rulesPath, JSON.stringify({ staleMs: 1_000 }));
      const registry = createSkillRegistry({
        runsTmp: tmp,
        rulesPath,
        runsNow: () => NOW,
        runsLiveness: { platform: "darwin" },
      });
      const first = (await registry.invoke("run.findings", {})) as {
        findings: Array<Record<string, unknown>>;
        config: Record<string, unknown>;
        coverage: Record<string, unknown>;
        evaluated_at: string;
      };
      expect(
        first.findings.map((finding) => finding.rule),
        "findings-once: the stale run fires",
      ).toEqual(["run-stale"]);
      expect(first.findings[0]).toMatchObject({
        run_id: "run-stale",
        actual: 30_000,
        threshold: 1_000,
      });
      expect(first.config).toMatchObject({ staleMs: 1_000 });
      expect(first.coverage).toMatchObject({ layout_recognised: true });
      expect(first.evaluated_at).toBe(new Date(NOW).toISOString());

      const second = (await registry.invoke("run.findings", {})) as {
        findings: unknown[];
      };
      expect(
        second.findings,
        "findings-once: notify once - the still-firing finding is suppressed",
      ).toEqual([]);

      await writeStatus(tmp, "pi-subagents-a", "run-stale", fresh);
      const third = (await registry.invoke("run.findings", {})) as {
        findings: unknown[];
      };
      expect(
        third.findings,
        "findings-once: a cleared finding stays cleared",
      ).toEqual([]);

      await writeStatus(tmp, "pi-subagents-a", "run-stale", stale);
      const fourth = (await registry.invoke("run.findings", {})) as {
        findings: Array<Record<string, unknown>>;
      };
      expect(
        fourth.findings.map((finding) => finding.rule),
        "findings-once: re-arms only after the finding clears",
      ).toEqual(["run-stale"]);

      // A restart is a new epoch: the same firing finding notifies again,
      // and that is expected rather than a bug.
      const restarted = createSkillRegistry({
        runsTmp: tmp,
        rulesPath,
        runsNow: () => NOW,
        runsLiveness: { platform: "darwin" },
      });
      const fifth = (await restarted.invoke("run.findings", {})) as {
        findings: Array<Record<string, unknown>>;
      };
      expect(
        fifth.findings.map((finding) => finding.rule),
        "findings-once: a restarted agent may notify again",
      ).toEqual(["run-stale"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("findings-malformed-rules: a malformed rules.json refuses with a stated reason", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-mesh-runs-badrules-"));
    try {
      await writeStatus(tmp, "pi-subagents-a", "run-stale", {
        runId: "run-stale",
        state: "running",
        startedAt: NOW - 60_000,
        lastUpdate: NOW - 30_000,
      });
      const rulesPath = join(tmp, "rules.json");
      await writeFile(rulesPath, "{not json");
      const registry = createSkillRegistry({
        runsTmp: tmp,
        rulesPath,
        runsNow: () => NOW,
        runsLiveness: { platform: "darwin" },
      });
      await expect(
        registry.invoke("run.findings", {}),
        "findings-malformed-rules: invalid JSON must refuse, never fall back to defaults",
      ).rejects.toMatchObject({
        message: expect.stringMatching(/not valid JSON/),
      });
      await writeFile(rulesPath, JSON.stringify({ staleMs: "a while" }));
      await expect(
        registry.invoke("run.findings", {}),
        "findings-malformed-rules: a non-numeric threshold must refuse with the key named",
      ).rejects.toMatchObject({
        message: expect.stringMatching(/staleMs.*non-numeric/),
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
