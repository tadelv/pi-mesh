// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@pi-mesh/shared";
import { JobManager } from "../src/jobs.js";
import { createSkillRegistry } from "../src/skills.js";
import {
  assertInsideWorkspace,
  buildSpawnEnv,
  createPiSpawner,
  resolvePiBinary,
  resolveWorkspaceRoot,
  sessionDirectory,
} from "../src/index.js";

const fixture = fileURLToPath(
  new URL("./fixtures/rpc-stub.mjs", import.meta.url),
);
const modelFixture = fileURLToPath(
  new URL("./fixtures/model-rpc-stub.mjs", import.meta.url),
);

/**
 * The model-catalog helper fixture, as the `pi` the catalog would ask. Kept
 * separate from the session binary: the session stub answers `get_state` and
 * `prompt`, the model stub answers `get_available_models`.
 */
async function modelCatalogBinary(
  parent: string,
  mode = "catalog",
): Promise<string> {
  const path = join(parent, `pi-model-${mode}.mjs`);
  await writeFile(
    path,
    `#!/usr/bin/env node\nprocess.env.MODEL_STUB_MODE = ${JSON.stringify(mode)};\nawait import(${JSON.stringify(pathToFileURL(modelFixture).href)});\n`,
  );
  await chmod(path, 0o755);
  return path;
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A workspace with the fixture wired up as the "pi" binary. */
async function workspace(): Promise<{
  parent: string;
  root: string;
  cwd: string;
  sessionsRoot: string;
  binary: string;
}> {
  // realpath immediately. On macOS `tmpdir()` is `/var/...` which is a symlink
  // to `/private/var/...`, so resolving the root but not the candidate makes the
  // symlink-escape test refuse for an unrelated reason (a `/var` vs
  // `/private/var` mismatch) and pass without testing containment at all - it
  // was non-discriminating on macOS and would have failed on Linux. Deriving
  // every path from the real location makes the check the only thing deciding.
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "pi-mesh-spawner-")),
  );
  const root = join(parent, "workspace");
  const cwd = join(root, "project");
  const sessionsRoot = join(parent, "sessions");
  await mkdir(cwd, { recursive: true });
  const binary = await wrapperFor(parent, "state");
  return { parent, root, cwd, sessionsRoot, binary };
}

async function wrapperFor(parent: string, mode: string): Promise<string> {
  const path = join(parent, `pi-${mode}.mjs`);
  await writeFile(
    path,
    `#!/usr/bin/env node\nprocess.env.PI_RPC_STUB_MODE = ${JSON.stringify(mode)};\nawait import(${JSON.stringify(pathToFileURL(fixture).href)});\n`,
  );
  await chmod(path, 0o755);
  return path;
}

function withDeadline<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("operation did not settle")), ms),
    ),
  ]);
}

function processStatus(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

/** The registry the server would build, without an HTTP layer in the way. */
function registryFor(options: {
  root: string;
  binary: string;
  sessionsRoot: string;
  catalogBinary?: string;
}): { skills: ReturnType<typeof createSkillRegistry>; jobs: JobManager } {
  const spawner = createPiSpawner({
    workspaceRoot: options.root,
    piBinary: options.binary,
    sessionsRoot: options.sessionsRoot,
    logger,
  });
  const jobs = new JobManager({
    spawnJob: spawner,
    logger,
    unacknowledgedTtlMs: 5_000,
  });
  const skills = createSkillRegistry({
    jobs,
    workspaceRoot: options.root,
    // Injected only by the model tests: the catalog asks this binary, while
    // the session itself runs on `binary`. Without it the helper would try the
    // real `pi`, which CI does not have.
    ...(options.catalogBinary === undefined
      ? {}
      : { piBinary: options.catalogBinary }),
  });
  return { skills, jobs };
}

describe("spawn policy primitives", () => {
  it("uses real paths for workspace containment", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-mesh-spawner-"));
    const root = join(parent, "workspace");
    const outside = join(parent, "outside");
    const link = join(root, "link");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, link);
    expect(() =>
      assertInsideWorkspace(root, join(root, "..", "outside")),
    ).toThrow(/outside the configured workspace/);
    expect(() => assertInsideWorkspace(root, link)).toThrow(
      /outside the configured workspace/,
    );
  });

  it("defaults the workspace to home and still contains spawned cwd", async () => {
    const w = await workspace();
    const home = join(w.parent, "home");
    const project = join(home, "project");
    const outside = join(w.parent, "outside");
    await mkdir(project, { recursive: true });
    await mkdir(outside);
    const oldHome = process.env.HOME;
    const oldWorkspace = process.env.PI_MESH_WORKSPACE;
    process.env.HOME = home;
    delete process.env.PI_MESH_WORKSPACE;
    try {
      expect(resolveWorkspaceRoot()).toBe(await realpath(home));
      const spawner = createPiSpawner({
        piBinary: w.binary,
        sessionsRoot: w.sessionsRoot,
        logger,
      });
      const jobs = new JobManager({ spawnJob: spawner, logger });
      const skills = createSkillRegistry({ jobs });
      const result = (await skills.invoke("process.spawn", {
        project: "p",
        cwd: "project",
        prompt: "home default",
        _peerId: "peer",
      })) as { job_id: string };
      await expect(
        skills.invoke("process.spawn", {
          project: "p",
          cwd: outside,
          prompt: "outside home",
          _peerId: "peer",
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SpawnDenied });
      await jobs.shutdown();
      expect(result.job_id).toBeTypeOf("string");
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldWorkspace === undefined) delete process.env.PI_MESH_WORKSPACE;
      else process.env.PI_MESH_WORKSPACE = oldWorkspace;
    }
  });

  it("inherits the normal environment while refusing every mesh variable", () => {
    const env = buildSpawnEnv({
      PATH: "/bin",
      HOME: "/home/test",
      CC: "/opt/toolchain/cc",
      PI_MESH_SWARM_KEY: "secret",
      PI_MESH_SPAWN_ENV_PASSTHROUGH: "PI_MESH_SWARM_KEY",
      CUSTOM_VALUE: "kept",
    });
    expect(env).toMatchObject({
      PATH: "/bin",
      HOME: "/home/test",
      CC: "/opt/toolchain/cc",
      CUSTOM_VALUE: "kept",
    });
    expect(
      Object.keys(env).filter((key) => key.startsWith("PI_MESH_")),
    ).toEqual([]);
  });

  it("T1 sends the supplied initial prompt to the child", async () => {
    const w = await workspace();
    const { skills, jobs } = registryFor({
      root: w.root,
      binary: await wrapperFor(w.parent, "prompt"),
      sessionsRoot: w.sessionsRoot,
    });
    try {
      const result = (await skills.invoke("process.spawn", {
        project: "p",
        cwd: "project",
        prompt: "exact initial prompt",
        _peerId: "peer",
      })) as { job_id: string };
      expect(jobs.output(result.job_id)).toContain(
        "prompt=exact initial prompt\n",
      );
    } finally {
      await jobs.shutdown();
    }
  });

  it("T2 refuses missing and blank prompts before starting anything", async () => {
    const w = await workspace();
    const { skills, jobs } = registryFor({
      root: w.root,
      binary: w.binary,
      sessionsRoot: w.sessionsRoot,
    });
    try {
      for (const prompt of [undefined, "   "]) {
        await expect(
          skills.invoke("process.spawn", {
            project: "p",
            cwd: "project",
            ...(prompt === undefined ? {} : { prompt }),
            _peerId: "peer",
          }),
        ).rejects.toMatchObject({
          code: -32602,
          message: "process.spawn requires a non-blank prompt",
        });
        expect(jobs.list()).toEqual([]);
      }
    } finally {
      await jobs.shutdown();
    }
  });

  it("T3 stops a job when the child refuses its initial prompt", async () => {
    const w = await workspace();
    const { skills, jobs } = registryFor({
      root: w.root,
      binary: await wrapperFor(w.parent, "prompt-refused"),
      sessionsRoot: w.sessionsRoot,
    });
    try {
      await expect(
        skills.invoke("process.spawn", {
          project: "p",
          cwd: "project",
          prompt: "refused prompt",
          _peerId: "peer",
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SpawnFailed });
      const records = jobs.list();
      expect(records.filter((record) => record.state !== "exited")).toEqual([]);
      const pid = records[0]?.pid;
      expect(pid).toBeTypeOf("number");
      expect(processStatus(pid!)).toMatch(/^$|^Z/);
    } finally {
      await jobs.shutdown();
    }
  });

  it("T4 checks containment before starting a valid prompted spawn", async () => {
    // The DoD's two escapes, through the real skill rather than the primitive:
    // a peer that will not take no for an answer should meet the refusal.
    const w = await workspace();
    const outside = join(w.parent, "outside");
    await mkdir(outside);
    await symlink(outside, join(w.root, "escape"));
    const { skills, jobs } = registryFor({
      root: w.root,
      binary: w.binary,
      sessionsRoot: w.sessionsRoot,
    });
    try {
      await expect(
        skills.invoke("process.spawn", {
          project: "p",
          cwd: join(w.root, "..", "outside"),
          prompt: "outside prompt",
          _peerId: "peer",
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SpawnDenied });
      await expect(
        skills.invoke("process.spawn", {
          project: "p",
          cwd: join(w.root, "escape"),
          prompt: "escape prompt",
          _peerId: "peer",
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SpawnDenied });
      expect(jobs.list()).toEqual([]);
    } finally {
      await jobs.shutdown();
    }
  });

  it("T5 returns after prompt acceptance while the turn is still running", async () => {
    const w = await workspace();
    const { skills, jobs } = registryFor({
      root: w.root,
      binary: await wrapperFor(w.parent, "prompt-long"),
      sessionsRoot: w.sessionsRoot,
    });
    try {
      const started = await withDeadline(
        skills.invoke("process.spawn", {
          project: "p",
          cwd: "project",
          prompt: "long-running prompt",
          _peerId: "peer",
        }),
      );
      const result = started as { job_id: string };
      expect(jobs.get(result.job_id)?.state).toBe("running");
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(
        jobs
          .output(result.job_id)
          .some((line) => line.includes("turn-running")),
      ).toBe(true);
    } finally {
      await jobs.shutdown();
    }
  });

  it("accepts a relative cwd as relative to the workspace, not the agent", async () => {
    // Resolving against the agent's own process.cwd() would refuse this or land
    // somewhere unrelated; `..` is still refused through the same path.
    const w = await workspace();
    const { skills, jobs } = registryFor({
      root: w.root,
      binary: w.binary,
      sessionsRoot: w.sessionsRoot,
    });
    try {
      const result = (await skills.invoke("process.spawn", {
        project: "p",
        cwd: "project",
        prompt: "relative prompt",
        _peerId: "peer",
      })) as { job_id?: string; session_id?: string };
      expect(result.job_id).toBeTypeOf("string");
      expect(result.session_id).toBe("123e4567-e89b-42d3-a456-426614174099");
      await expect(
        skills.invoke("process.spawn", {
          project: "p",
          cwd: "../outside",
          prompt: "escaping prompt",
          _peerId: "peer",
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SpawnDenied });
    } finally {
      await jobs.shutdown();
    }
  });

  it("defaults the workspace to the home directory when none is configured", async () => {
    // The root is optional now, and this is the only thing that would notice if
    // it silently became required again (spawn would start refusing everything)
    // or if the default moved somewhere useless. Both directions matter, so the
    // test asserts an acceptance AND a refusal.
    const w = await workspace();
    const previous = process.env.PI_MESH_WORKSPACE;
    delete process.env.PI_MESH_WORKSPACE;
    const spawner = createPiSpawner({
      piBinary: w.binary,
      sessionsRoot: w.sessionsRoot,
      logger,
    });
    const jobs = new JobManager({
      spawnJob: spawner,
      logger,
      unacknowledgedTtlMs: 5_000,
    });
    // No `workspaceRoot` option at all, which is the case a daemon hits when the
    // operator never sets the variable.
    const skills = createSkillRegistry({ jobs });
    try {
      await expect(
        skills.invoke("process.spawn", {
          project: "p",
          prompt: "default root",
          _peerId: "peer",
        }),
      ).resolves.toBeDefined();
      // The parent of the home directory is outside it, so the default root must
      // still refuse this. If the default ever became "/" this would pass and the
      // guard would be gone.
      await expect(
        skills.invoke("process.spawn", {
          project: "p",
          cwd: join(homedir(), ".."),
          prompt: "outside the default root",
          _peerId: "peer",
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SpawnDenied });
    } finally {
      await jobs.shutdown();
      if (previous !== undefined) process.env.PI_MESH_WORKSPACE = previous;
    }
  });

  it("gives the child an environment with no PI_MESH_ variable in it", async () => {
    // Asserted POSITIVELY. Checking only that the swarm key is absent passes
    // when the child's environment is empty, which is a different bug entirely.
    const w = await workspace();
    const binary = await wrapperFor(w.parent, "env");
    const previous = process.env.PI_MESH_SWARM_KEY;
    const previousKey = process.env.ANTHROPIC_API_KEY;
    const previousCc = process.env.CC;
    const previousPassthrough = process.env.PI_MESH_SPAWN_ENV_PASSTHROUGH;
    process.env.PI_MESH_SWARM_KEY = "must-not-be-inherited";
    process.env.PI_MESH_SPAWN_ENV_PASSTHROUGH = "PI_MESH_SWARM_KEY";
    process.env.ANTHROPIC_API_KEY = "sk-test-credential";
    process.env.CC = "/opt/toolchain/cc";
    const spawner = createPiSpawner({
      workspaceRoot: w.root,
      piBinary: binary,
      sessionsRoot: w.sessionsRoot,
      logger,
    });
    const output: string[] = [];
    try {
      const handle = spawner(
        { peerId: "peer", project: "p", cwd: w.cwd, name: "job" },
        {
          output: (line) => output.push(line),
          session: () => undefined,
          exited: () => undefined,
        },
      );
      await handle.ready;
      const line = output.find((entry) => entry.includes("envkeys="));
      expect(line).toBeDefined();
      const keys = JSON.parse(
        line!.slice(line!.indexOf("envkeys=") + 8),
      ) as string[];
      expect(keys).toContain("PATH");
      expect(keys).toContain("HOME");
      expect(keys.filter((key) => key.startsWith("PI_MESH_"))).toEqual([]);
      // A provider credential must survive, or the session cannot do any work.
      expect(keys).toContain("ANTHROPIC_API_KEY");
      expect(keys).toContain("CC");
      await handle.close();
    } finally {
      if (previous === undefined) delete process.env.PI_MESH_SWARM_KEY;
      else process.env.PI_MESH_SWARM_KEY = previous;
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
      if (previousCc === undefined) delete process.env.CC;
      else process.env.CC = previousCc;
      if (previousPassthrough === undefined)
        delete process.env.PI_MESH_SPAWN_ENV_PASSTHROUGH;
      else process.env.PI_MESH_SPAWN_ENV_PASSTHROUGH = previousPassthrough;
    }
  });

  it("M6-4 places a validated model in the spawned argv and refuses unlisted or malformed models before starting", async () => {
    const w = await workspace();
    const { skills, jobs } = registryFor({
      root: w.root,
      binary: await wrapperFor(w.parent, "state"),
      sessionsRoot: w.sessionsRoot,
      catalogBinary: await modelCatalogBinary(w.parent),
    });
    try {
      // Each of these is refused by the equality check, not by Pi, and each
      // must leave the job table empty - a refusal that still spawned would be
      // the argv hole this bound exists to close.
      for (const model of [
        { provider: "fixture-provider", model_id: "exact-model" }, // a prefix, not equal
        { provider: "other-provider", model_id: "exact-model-v1" },
        { provider: "fixture-provider" }, // missing model_id
        { provider: "", model_id: "exact-model-v1" },
      ]) {
        await expect(
          skills.invoke("process.spawn", {
            project: "p",
            cwd: "project",
            prompt: "refused model",
            model,
            _peerId: "peer",
          }),
        ).rejects.toMatchObject({ code: -32602 });
      }
      expect(jobs.list()).toEqual([]);

      // The listed pair reaches the argv the spawner. Removing the flags from
      // the spawner makes this fail on the argv clause, not on a timeout.
      const listed = (await skills.invoke("process.spawn", {
        project: "p",
        cwd: "project",
        prompt: "listed model",
        model: { provider: "fixture-provider", model_id: "exact-model-v1" },
        _peerId: "peer",
      })) as { job_id: string };
      const argv = jobs.get(listed.job_id)?.argv ?? [];
      const providerAt = argv.indexOf("--provider");
      expect(
        providerAt,
        "the spawner placed --provider in the launched argv",
      ).toBeGreaterThanOrEqual(0);
      // Adjacent pairs, not scattered flags: arrayContaining would accept the
      // right values in a wrong order, which real Pi would not read as a model.
      expect(argv.slice(providerAt, providerAt + 4)).toEqual([
        "--provider",
        "fixture-provider",
        "--model",
        "exact-model-v1",
      ]);

      // Positive control: omitting the model still spawns, and adds neither flag.
      const plain = (await skills.invoke("process.spawn", {
        project: "p",
        cwd: "project",
        prompt: "no model",
        _peerId: "peer",
      })) as { job_id: string };
      const plainArgv = jobs.get(plain.job_id)?.argv ?? [];
      expect(plainArgv).not.toContain("--model");
      expect(plainArgv).not.toContain("--provider");
    } finally {
      await jobs.shutdown();
    }
  });

  it("M6-4 refuses a chosen model when the catalog is unavailable, before starting any process", async () => {
    const w = await workspace();
    const { skills, jobs } = registryFor({
      root: w.root,
      binary: await wrapperFor(w.parent, "state"),
      sessionsRoot: w.sessionsRoot,
      catalogBinary: await modelCatalogBinary(w.parent, "fail"),
    });
    try {
      await expect(
        skills.invoke("process.spawn", {
          project: "p",
          cwd: "project",
          prompt: "unavailable catalog",
          model: { provider: "fixture-provider", model_id: "exact-model-v1" },
          _peerId: "peer",
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CatalogUnavailable });
      expect(jobs.list()).toEqual([]);
    } finally {
      await jobs.shutdown();
    }
  });

  // A real `pi`, when one is installed. CI has no binary and no model provider,
  // so this skips there; M2-9 runs it for real on two machines. It is here
  // because the fixture is written by the same hand as the code it tests, and a
  // stub that answers regardless of the request SHAPE is how a
  // `{command:"get_state"}` request - which real Pi cannot recognise - survived
  // a fully green suite.
  let realPi: string | undefined;
  try {
    realPi = resolvePiBinary();
  } catch {
    realPi = undefined;
  }

  it.skipIf(realPi === undefined)(
    "becomes ready against real Pi and files its session where the reader looks",
    async () => {
      const w = await workspace();
      // Keep the real binary's config inside this test's temp tree. Pi writes
      // ~/.pi/agent/{auth,models-store}.json on startup, so without this the
      // suite stops being hermetic: `HOME=$(mktemp -d) pnpm -r test` would
      // leave files behind. The allowlist passes PI_CODING_AGENT_DIR through.
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = join(w.parent, "agent-dir");
      const spawner = createPiSpawner({
        workspaceRoot: w.root,
        piBinary: realPi!,
        sessionsRoot: w.sessionsRoot,
        readinessTimeoutMs: 30_000,
        logger,
      });
      let exited = false;
      const handle = spawner(
        { peerId: "peer", project: "p", cwd: w.cwd, name: "real-pi" },
        {
          output: () => undefined,
          session: (id) => {
            expect(id).toMatch(/^[0-9a-f-]{36}$/);
          },
          exited: () => {
            exited = true;
          },
        },
      );
      try {
        await handle.ready;
        const pid = handle.pid!;
        expect(pid).toBeGreaterThan(0);
        await handle.close();
        expect(exited).toBe(true);
        // The whole point of passing a computed --session-dir: a flat file
        // directly under the sessions root is invisible to sessionFiles().
        const expected = sessionDirectory(
          await realpath(w.cwd),
          w.sessionsRoot,
        );
        expect(expected.startsWith(w.sessionsRoot)).toBe(true);
      } finally {
        await handle.close();
        if (previousAgentDir === undefined)
          delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    },
  );

  it("launches in the contained cwd with the pinned argv", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-mesh-spawner-"));
    const root = join(parent, "workspace");
    const cwd = join(root, "project");
    const sessionsRoot = join(parent, "sessions");
    await mkdir(cwd, { recursive: true });
    const wrapper = join(parent, "pi-wrapper.mjs");
    await writeFile(
      wrapper,
      `#!/usr/bin/env node\nprocess.env.PI_RPC_STUB_MODE = "state";\nawait import(${JSON.stringify(pathToFileURL(fixture).href)});\n`,
    );
    await chmod(wrapper, 0o755);
    const reports: string[] = [];
    const spawner = createPiSpawner({
      workspaceRoot: root,
      piBinary: wrapper,
      sessionsRoot,
      logger,
    });
    const handle = spawner(
      { peerId: "peer", project: "project", cwd, name: "job" },
      {
        output: () => undefined,
        session: (id) => reports.push(id),
        exited: () => undefined,
      },
    );
    await handle.ready;
    const realCwd = await realpath(cwd);
    const realWrapper = await realpath(wrapper);
    expect(handle.argv).toEqual([
      realWrapper,
      "--mode",
      "rpc",
      "--session-dir",
      sessionDirectory(realCwd, sessionsRoot),
      "--no-approve",
      "--name",
      "job",
    ]);
    expect(reports).toEqual(["123e4567-e89b-42d3-a456-426614174099"]);
    await expect(handle.command({ type: "get_state" })).resolves.toMatchObject({
      success: true,
      data: { sessionId: "123e4567-e89b-42d3-a456-426614174099" },
    });
    await handle.close();
  });

  it.skipIf(realPi === undefined)(
    "launches real Pi on the requested model, and the running process reports it",
    async () => {
      // The effective-model clause M6-4 requires: not that a flag was recorded,
      // but that the process Pi started is on the chosen model. Real Pi's own
      // config is read (not overridden) because this needs the machine's real
      // catalog; the test skips in CI, where no `pi` exists.
      const w = await workspace();
      const spawner = createPiSpawner({
        workspaceRoot: w.root,
        piBinary: realPi!,
        sessionsRoot: w.sessionsRoot,
        readinessTimeoutMs: 30_000,
        logger,
      });
      const report = {
        output: () => undefined,
        session: () => undefined,
        exited: () => undefined,
      };
      const catalogSkills = createSkillRegistry({ piBinary: realPi! });
      const catalog = (await catalogSkills.invoke("session.models", {})) as {
        models: Array<{ id: string; provider: string }>;
      };
      await catalogSkills.close();
      expect(
        catalog.models.length,
        "real Pi reported at least one model",
      ).toBeGreaterThan(0);

      const defaultHandle = spawner(
        { peerId: "peer", project: "project", cwd: w.cwd, name: "default" },
        report,
      );
      await defaultHandle.ready;
      const defaultState = (await defaultHandle.command({
        type: "get_state",
      })) as { data?: { model?: { id?: string } } };
      await defaultHandle.close();

      // A model other than the machine's own choice, so the assertion cannot
      // pass by inheritance: without the flag the default would be reported.
      const chosen = catalog.models.find(
        (model) => model.id !== defaultState.data?.model?.id,
      );
      expect(
        chosen,
        "the machine offers a model other than its default, so the override is observable",
      ).toBeDefined();
      const handle = spawner(
        {
          peerId: "peer",
          project: "project",
          cwd: w.cwd,
          name: "chosen",
          model: { provider: chosen!.provider, modelId: chosen!.id },
        },
        report,
      );
      await handle.ready;
      const state = (await handle.command({ type: "get_state" })) as {
        data?: { model?: { id?: string; provider?: string } };
      };
      expect(state.data?.model).toMatchObject({
        id: chosen!.id,
        provider: chosen!.provider,
      });
      await handle.close();
    },
  );
});
