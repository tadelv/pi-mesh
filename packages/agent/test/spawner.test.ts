// SPDX-License-Identifier: GPL-3.0-or-later

import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
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
  sessionDirectory,
} from "../src/index.js";

const fixture = fileURLToPath(
  new URL("./fixtures/rpc-stub.mjs", import.meta.url),
);

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

/** The registry the server would build, without an HTTP layer in the way. */
function registryFor(options: {
  root: string;
  binary: string;
  sessionsRoot: string;
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

  it("keeps required basics while refusing mesh variables", () => {
    const result = buildSpawnEnv(
      {
        PATH: "/bin",
        HOME: "/home/test",
        PI_MESH_SWARM_KEY: "secret",
        CUSTOM_VALUE: "kept",
      },
      "CUSTOM_VALUE,PI_MESH_SWARM_KEY",
    );
    expect(result.env).toMatchObject({ PATH: "/bin", HOME: "/home/test" });
    expect(result.env.PI_MESH_SWARM_KEY).toBeUndefined();
    expect(result.refused).toEqual(["PI_MESH_SWARM_KEY"]);
  });

  it("refuses a cwd that escapes the workspace, and one that escapes by symlink", async () => {
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
          _peerId: "peer",
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SpawnDenied });
      await expect(
        skills.invoke("process.spawn", {
          project: "p",
          cwd: join(w.root, "escape"),
          _peerId: "peer",
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SpawnDenied });
      expect(jobs.list()).toEqual([]);
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
        _peerId: "peer",
      })) as { job_id?: string; session_id?: string };
      expect(result.job_id).toBeTypeOf("string");
      expect(result.session_id).toBe("123e4567-e89b-42d3-a456-426614174099");
      await expect(
        skills.invoke("process.spawn", {
          project: "p",
          cwd: "../outside",
          _peerId: "peer",
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SpawnDenied });
    } finally {
      await jobs.shutdown();
    }
  });

  it("gives the child an environment with no PI_MESH_ variable in it", async () => {
    // Asserted POSITIVELY. Checking only that the swarm key is absent passes
    // when the child's environment is empty, which is a different bug entirely.
    const w = await workspace();
    const binary = await wrapperFor(w.parent, "env");
    const previous = process.env.PI_MESH_SWARM_KEY;
    const previousKey = process.env.ANTHROPIC_API_KEY;
    process.env.PI_MESH_SWARM_KEY = "must-not-be-inherited";
    process.env.ANTHROPIC_API_KEY = "sk-test-credential";
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
      await handle.close();
    } finally {
      if (previous === undefined) delete process.env.PI_MESH_SWARM_KEY;
      else process.env.PI_MESH_SWARM_KEY = previous;
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
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
});
