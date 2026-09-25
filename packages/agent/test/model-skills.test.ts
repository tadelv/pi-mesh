// SPDX-License-Identifier: GPL-3.0-or-later

import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@pi-mesh/shared";
import { JobManager } from "../src/jobs.js";
import { createAgentServer, signedHeaders } from "../src/index.js";
import {
  createSkillRegistry,
  EXECUTION_SKILLS,
  servedSkills,
} from "../src/skills.js";
import {
  assertExecutionAllowed,
  parseSpawnPolicy,
} from "../src/spawn-policy.js";

const fixture = fileURLToPath(
  new URL("./fixtures/model-rpc-stub.mjs", import.meta.url),
);
const MODEL = {
  id: "exact-model-v1",
  provider: "fixture-provider",
  name: "Fixture Exact",
};

async function setup(mode = "catalog", timeoutMs = 1_000, ttlMs = 30_000) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "pi-mesh-models-")),
  );
  const binary = join(parent, "pi-model-fixture.mjs");
  const counts = join(parent, "counts");
  const commands = join(parent, "commands");
  const pidFile = join(parent, "pid");
  await writeFile(
    binary,
    `#!/usr/bin/env node\nprocess.env.MODEL_STUB_MODE = ${JSON.stringify(mode)};\nprocess.env.MODEL_STUB_COUNT = ${JSON.stringify(counts)};\nprocess.env.MODEL_STUB_COMMANDS = ${JSON.stringify(commands)};\nprocess.env.MODEL_STUB_PID = ${JSON.stringify(pidFile)};\nawait import(${JSON.stringify(pathToFileURL(fixture).href)});\n`,
  );
  await chmod(binary, 0o755);
  const jobs = new JobManager({
    spawnJob: (spec, report) => {
      const { PiRpcClient } = requireRpc;
      const rpc = new PiRpcClient({
        piBinary: binary,
        sessionDir: parent,
        cwd: parent,
        name: spec.name,
      });
      rpc.on("exit", report.exited);
      rpc.on("stderr", report.output);
      const ready = (async () => {
        await rpc.ready;
        const response = await rpc.request({ type: "get_state" });
        report.session((response.data as { sessionId: string }).sessionId);
      })();
      return {
        pid: rpc.child.pid,
        argv: rpc.argv,
        get stdioClosed() {
          return rpc.stdioClosed;
        },
        command: (command) => rpc.request(command),
        close: () => rpc.close(),
        ready,
      };
    },
    unacknowledgedTtlMs: 5_000,
  });
  const skills = createSkillRegistry({
    jobs,
    piBinary: binary,
    modelCatalogTtlMs: ttlMs,
    modelCatalogTimeoutMs: timeoutMs,
  });
  return {
    parent,
    binary,
    counts,
    commands,
    pidFile,
    jobs,
    skills,
    // Close the registry BEFORE the jobs: the catalog helper is a process this
    // test owns, and a leaked one would outlive the file. Then remove the root,
    // so a failing run does not leave a temp directory behind either.
    async close() {
      await skills.close();
      await jobs.shutdown();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

// Keep the RPC import explicit but outside setup's per-test process construction.
import { PiRpcClient } from "../src/rpc.js";
const requireRpc = { PiRpcClient };

async function startJob(state?: "running" | "stopping") {
  const env = await setup();
  const job = await env.jobs.startReady({
    peerId: "peer",
    project: "fixture",
    cwd: env.parent,
    name: "fixture",
  });
  if (state === "stopping") job.state = "stopping";
  return { ...env, job };
}

async function count(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

/** Whether a process is still running, by pid. Signal 0 tests existence only. */
function alive(pid: number): boolean {
  // Guard the pids that would interrogate the WRONG process: kill(0, ...)
  // signals the caller's own process group, and a negative pid targets a group.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function helperPid(env: { pidFile: string }): Promise<number> {
  try {
    return Number((await readFile(env.pidFile, "utf8")).trim());
  } catch {
    return 0; // the child has not written it yet
  }
}

/** Poll a condition, and fail with the NAMED clause rather than a bare timeout. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

/** Helper temp directories, so a leaked one is observable. */
async function catalogDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) =>
    name.startsWith("pi-mesh-model-catalog-"),
  );
}

const TEST_KEY = Buffer.from("pi-mesh-vector-key-0123456789abc");
const CALLEE = { peerId: "22222222-2222-4222-8222-222222222222", name: "test" };
const CALLER = {
  peerId: "33333333-3333-4333-8333-333333333333",
  name: "caller",
};

/** One signed message/send over the real server, so the WIRE error shape is what gets asserted. */
function post(port: number, skill: string, input: unknown): Promise<string> {
  const text = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        messageId: "m-1",
        role: "ROLE_USER",
        parts: [{ data: { skill, input } }],
      },
    },
  });
  const headers = signedHeaders(TEST_KEY, CALLER, {
    method: "POST",
    path: "/",
    body: text,
    recipientPeerId: CALLEE.peerId,
  });
  return new Promise((resolve, reject) => {
    const client = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(text),
          "A2A-Version": "1.0",
          ...headers,
        },
      },
      (response) => {
        let received = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (received += chunk));
        response.on("end", () => resolve(received));
      },
    );
    client.on("error", reject);
    client.end(text);
  });
}

async function serve(
  skills: ReturnType<typeof createSkillRegistry>,
  sessionsRoot: string,
) {
  const server = createAgentServer({
    host: "127.0.0.1",
    port: 0,
    swarmKey: TEST_KEY,
    identity: CALLEE,
    sessionsRoot,
    skillRegistry: skills,
    spawnPolicy: parseSpawnPolicy("*"),
  });
  const listening = await server.start();
  return { port: listening.port, stop: () => server.stop() };
}

describe("model skills", () => {
  it("returns the exact non-empty catalog from a running job", async () => {
    const env = await startJob();
    try {
      await expect(
        env.skills.invoke("session.models", { job_id: env.job.id }),
      ).resolves.toEqual({ models: [MODEL] });
    } finally {
      await env.close();
    }
  });

  it("distinguishes an empty Pi catalog from an unavailable helper", async () => {
    const empty = await setup("empty");
    const failed = await setup("fail");
    try {
      await expect(empty.skills.invoke("session.models", {})).resolves.toEqual({
        models: [],
      });
      await expect(
        failed.skills.invoke("session.models", {}),
      ).rejects.toMatchObject({ code: ErrorCode.CatalogUnavailable });
    } finally {
      await empty.close();
      await failed.close();
    }
  });

  it("distinguishes an unknown job from a tracked stopping job, with running positive control", async () => {
    const env = await startJob();
    try {
      await expect(
        env.skills.invoke("session.models", { job_id: "missing" }),
      ).rejects.toMatchObject({ code: ErrorCode.UnknownJob });
      await expect(
        env.skills.invoke("session.models", { job_id: env.job.id }),
      ).resolves.toMatchObject({ models: [MODEL] });
      env.job.state = "stopping";
      await expect(
        env.skills.invoke("session.set_model", {
          job_id: env.job.id,
          provider: MODEL.provider,
          model_id: MODEL.id,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.JobNotRunning });
      await expect(
        env.skills.invoke("session.models", { job_id: env.job.id }),
      ).rejects.toMatchObject({ code: ErrorCode.JobNotRunning });
    } finally {
      await env.close();
    }
  });

  it("refuses unlisted and fuzzy-prefix models without dispatch, while listed pair dispatches exact wire shape", async () => {
    const env = await startJob();
    try {
      await expect(
        env.skills.invoke("session.set_model", {
          job_id: env.job.id,
          provider: "fixture-provider",
          model_id: "exact-model",
        }),
      ).rejects.toMatchObject({ code: -32602 });
      // A wholly unlisted pair too, not only a prefix of a listed id: the two
      // fail for the same equality rule, but only a second case shows the check
      // is not prefix-specific.
      await expect(
        env.skills.invoke("session.set_model", {
          job_id: env.job.id,
          provider: "other-provider",
          model_id: MODEL.id,
        }),
      ).rejects.toMatchObject({ code: -32602 });
      expect(await count(env.commands)).toBe(0);
      await expect(
        env.skills.invoke("session.set_model", {
          job_id: env.job.id,
          provider: MODEL.provider,
          model_id: MODEL.id,
        }),
      ).resolves.toEqual(MODEL);
      expect(await readFile(env.commands, "utf8")).toBe(
        JSON.stringify({
          type: "set_model",
          provider: MODEL.provider,
          modelId: MODEL.id,
        }) + "\n",
      );
    } finally {
      await env.close();
    }
  });

  it("uses the execution gate only for set_model", () => {
    expect(EXECUTION_SKILLS).toContain("session.set_model");
    expect(servedSkills(true, false)).not.toContain("session.set_model");
    expect(servedSkills(true, false)).toContain("session.models");
    expect(servedSkills(true, true)).toContain("session.set_model");
    expect(() =>
      assertExecutionAllowed(parseSpawnPolicy(), "peer", "session.set_model"),
    ).toThrowError(expect.objectContaining({ code: -32102 }));
    expect(() =>
      assertExecutionAllowed(parseSpawnPolicy(), "peer", "session.models"),
    ).not.toThrow();
  });

  it("single-flights concurrent helper calls and caches within the TTL", async () => {
    const env = await setup();
    try {
      const both = await Promise.all([
        env.skills.invoke("session.models", {}),
        env.skills.invoke("session.models", {}),
      ]);
      expect(both).toEqual([{ models: [MODEL] }, { models: [MODEL] }]);
      expect(await count(env.counts)).toBe(1);
      await env.skills.invoke("session.models", {});
      expect(await count(env.counts)).toBe(1);
    } finally {
      await env.close();
    }
  });

  it("maps a helper timeout to catalog unavailable", async () => {
    const env = await setup("hang", 150);
    try {
      await expect(
        env.skills.invoke("session.models", {}),
      ).rejects.toMatchObject({ code: ErrorCode.CatalogUnavailable });
    } finally {
      await env.close();
    }
  });

  it("re-queries after the TTL rather than caching a catalog forever", async () => {
    // Without this, a cache that never expires passes every other test: the
    // only other cache assertion checks reuse WITHIN the TTL.
    const env = await setup("catalog", 1_000, 120);
    try {
      await env.skills.invoke("session.models", {});
      await env.skills.invoke("session.models", {});
      expect(await count(env.counts)).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await env.skills.invoke("session.models", {});
      expect(await count(env.counts)).toBe(2);
    } finally {
      await env.close();
    }
  });

  it("kills the helper child and removes its temp directory when the catalog times out", async () => {
    const env = await setup("hang", 150);
    const before = await catalogDirs();
    try {
      await expect(
        env.skills.invoke("session.models", {}),
      ).rejects.toMatchObject({ code: ErrorCode.CatalogUnavailable });
      // The child must be OBSERVED alive-by-pid before asserting it died: an
      // unreadable pid file reads as pid 0, which alive() calls false, so
      // without this the death assertion passes before a child ever ran. That
      // is exactly how the first version of this test passed with child
      // teardown deleted.
      await waitFor(
        async () => (await helperPid(env)) > 0,
        "helper child never reported its pid",
      );
      await waitFor(
        async () => !alive(await helperPid(env)),
        "helper child survived the catalog timeout",
      );
      await waitFor(
        async () =>
          (await catalogDirs()).filter((name) => !before.includes(name))
            .length === 0,
        "helper temp directory was not removed after the catalog timeout",
      );
    } finally {
      await env.close();
    }
  });

  it("kills an in-flight helper when the registry closes (agent shutdown)", async () => {
    // The helper used to close only when its own request finished, so a
    // get_available_models that never answers outlived the agent. This is the
    // shutdown path that skill-registry close() exists for.
    const env = await setup("hang", 30_000);
    try {
      const pending = env.skills.invoke("session.models", {}).then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      await waitFor(
        async () => alive(await helperPid(env)),
        "helper child never started",
      );
      await env.skills.close();
      // Assert the EFFECT first: with the kill removed, awaiting the pending
      // request first reports a bare 5s timeout, which is a non-answer
      // (AGENTS.md: the failure line must name the clause).
      await waitFor(
        async () => !alive(await helperPid(env)),
        "in-flight helper child was not killed when the registry closed",
      );
      const outcome = await pending;
      expect(outcome).toMatchObject({ code: ErrorCode.CatalogUnavailable });
    } finally {
      await env.close();
    }
  });

  it("does not start a helper when close() wins the race with the spawn", async () => {
    // close() can run while load() is awaiting mkdtemp. Without a recheck there,
    // the child spawned AFTER shutdown and killed itself only at its request
    // timeout, so close() did not settle. The bound is well ABOVE mkdtemp's real
    // latency (so the fixed path is not flaky on a slow runner) and well BELOW
    // the helper's own timeout (so a regression is caught here rather than by
    // the test timeout).
    const env = await setup("hang", 4_000);
    try {
      const pending = env.skills.invoke("session.models", {}).then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      const outcome = await Promise.race([
        env.skills.close().then(() => "closed" as const),
        new Promise((resolve) =>
          setTimeout(() => resolve("still-closing" as const), 1_500),
        ),
      ]);
      expect(
        outcome,
        "close() did not stop a helper that would have spawned after shutdown",
      ).toBe("closed");
      expect(await pending).toMatchObject({
        code: ErrorCode.CatalogUnavailable,
      });
    } finally {
      await env.close();
    }
  });

  it("a second close() does not resolve before the in-flight helper is dead", async () => {
    // Without a memoised close, the second call read and cleared active/flight
    // before awaiting, so it returned while the child was still being killed.
    const env = await setup("hang", 1_500);
    try {
      const pending = env.skills.invoke("session.models", {}).then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      await waitFor(
        async () => alive(await helperPid(env)),
        "helper child never started",
      );
      const first = env.skills.close();
      const second = env.skills.close();
      await second;
      expect(
        alive(await helperPid(env)),
        "a second close() resolved before the in-flight helper was killed",
      ).toBe(false);
      await first;
      await pending;
    } finally {
      await env.close();
    }
  });

  it("preserves Pi's own message when the change is refused at the wire", async () => {
    // ADR 0017: Pi is the authority after a valid selection, and its refusal is
    // surfaced with its message. Before the fix the transport answered a bare
    // -32603 "Internal error" and threw the diagnostic away.
    const env = await setup("refuse-set");
    const job = await env.jobs.startReady({
      peerId: "peer",
      project: "fixture",
      cwd: env.parent,
      name: "fixture",
    });
    const app = await serve(env.skills, env.parent);
    try {
      const body = JSON.parse(
        await post(app.port, "session.set_model", {
          job_id: job.id,
          provider: MODEL.provider,
          model_id: MODEL.id,
        }),
      ) as { error: { code: number; message: string } };
      expect(body.error.code).toBe(-32603);
      expect(body.error.message).toContain(
        "Model not found: fixture-provider/exact-model-v1",
      );
    } finally {
      await app.stop();
      await env.close();
    }
  });

  it("carries a PI_MESH reason for the new refusals on the wire", async () => {
    const env = await setup();
    const job = await env.jobs.startReady({
      peerId: "peer",
      project: "fixture",
      cwd: env.parent,
      name: "fixture",
    });
    const app = await serve(env.skills, env.parent);
    try {
      job.state = "stopping";
      const stopped = JSON.parse(
        await post(app.port, "session.set_model", {
          job_id: job.id,
          provider: MODEL.provider,
          model_id: MODEL.id,
        }),
      ) as {
        error: { code: number; data?: { details?: { reason?: string }[] } };
      };
      expect(stopped.error.code).toBe(ErrorCode.JobNotRunning);
      expect(stopped.error.data?.details?.[0]?.reason).toBe(
        "PI_MESH_JOB_NOT_RUNNING",
      );
    } finally {
      await app.stop();
      await env.close();
    }

    // A machine with no resolvable `pi`: the helper fails, and the wire says so
    // with the documented reason rather than an empty catalog.
    const noPi = createSkillRegistry({ piBinary: "/nonexistent/pi" });
    const app2 = await serve(noPi, env.parent);
    try {
      const unavailable = JSON.parse(
        await post(app2.port, "session.models", {}),
      ) as {
        error: { code: number; data?: { details?: { reason?: string }[] } };
      };
      expect(unavailable.error.code).toBe(ErrorCode.CatalogUnavailable);
      expect(unavailable.error.data?.details?.[0]?.reason).toBe(
        "PI_MESH_CATALOG_UNAVAILABLE",
      );
    } finally {
      await app2.stop();
    }
  });
});
