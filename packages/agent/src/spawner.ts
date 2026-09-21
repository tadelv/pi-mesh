// SPDX-License-Identifier: GPL-3.0-or-later

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { type Logger } from "@pi-mesh/shared";
import { PiRpcClient } from "./rpc.js";
import { buildSpawnEnv } from "./spawn-env.js";
import { defaultSessionsRoot, sessionDirectory } from "./sessions.js";
import type { JobSpawner } from "./jobs.js";

function realFile(path: string, label: string): string {
  try {
    const resolved = realpathSync(path);
    if (!statSync(resolved).isFile()) throw new Error("not a file");
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch (error) {
    throw new Error(`${label} is not an executable file: ${path}`, {
      cause: error,
    });
  }
}

export function resolvePiBinary(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = explicit ?? env.PI_MESH_PI_BINARY;
  if (configured !== undefined && configured.trim() !== "") {
    if (isAbsolute(configured))
      return realFile(configured, "PI_MESH_PI_BINARY");
    for (const directory of (env.PATH ?? "").split(delimiter)) {
      if (directory.length === 0) continue;
      const candidate = join(directory, configured);
      try {
        return realFile(candidate, "PI_MESH_PI_BINARY");
      } catch {
        // Continue scanning PATH.
      }
    }
    throw new Error(
      `PI_MESH_PI_BINARY does not resolve to an executable: ${configured}`,
    );
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, "pi");
    try {
      return realFile(candidate, "pi");
    } catch {
      // Continue scanning PATH.
    }
  }
  throw new Error(
    "Unable to find executable pi; set PI_MESH_PI_BINARY to its absolute path",
  );
}

export function resolveWorkspaceRoot(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = explicit ?? env.PI_MESH_WORKSPACE;
  if (configured === undefined || configured.trim() === "") {
    throw new Error("PI_MESH_WORKSPACE is required for process.spawn");
  }
  if (!isAbsolute(configured)) {
    throw new Error(
      `PI_MESH_WORKSPACE must be an absolute directory: ${configured}`,
    );
  }
  try {
    const root = realpathSync(configured);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    return root;
  } catch (error) {
    throw new Error(
      `PI_MESH_WORKSPACE is not a usable directory: ${configured}`,
      {
        cause: error,
      },
    );
  }
}

export function assertInsideWorkspace(root: string, candidate: string): string {
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  if (
    realCandidate !== realRoot &&
    !realCandidate.startsWith(`${realRoot}${sep}`)
  ) {
    throw new Error(
      `cwd is outside the configured workspace: ${candidate} (workspace ${realRoot})`,
    );
  }
  return realCandidate;
}

export interface PiSpawnerOptions {
  workspaceRoot: string;
  piBinary: string;
  sessionsRoot?: string;
  readinessTimeoutMs?: number;
  passthrough?: string;
  logger?: Logger;
}

export function createPiSpawner(options: PiSpawnerOptions): JobSpawner {
  const root = assertInsideWorkspace(
    options.workspaceRoot,
    options.workspaceRoot,
  );
  // Binary resolution is separate so a configured but missing binary fails as
  // a SpawnFailed job rather than preventing the manager from starting.
  let piBinary = options.piBinary;
  try {
    piBinary = realpathSync(piBinary);
  } catch {
    if (!isAbsolute(piBinary)) piBinary = resolve(piBinary);
  }
  const sessionsRoot = options.sessionsRoot ?? defaultSessionsRoot();
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 10_000;
  if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
    throw new RangeError("readinessTimeoutMs must be greater than zero");
  }

  return (spec, report) => {
    const cwd = assertInsideWorkspace(root, spec.cwd || root);
    const environment = buildSpawnEnv(
      process.env,
      options.passthrough ?? process.env.PI_MESH_SPAWN_ENV_PASSTHROUGH,
    );
    if (environment.refused.length > 0) {
      options.logger?.warn("Refused spawn environment names", {
        names: environment.refused,
      });
    }
    const rpc = new PiRpcClient({
      piBinary,
      sessionDir: sessionDirectory(cwd, sessionsRoot),
      name: spec.name,
      cwd,
      env: environment.env,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    rpc.on("exit", report.exited);
    rpc.on("stderr", (line: string) => report.output(line));
    const ready = (async (): Promise<void> => {
      try {
        await rpc.ready;
        // `{ type }`, not `{ command }`: Pi's RPC wire format keys the method on
        // `type` and `request()` sends the object through verbatim, so a
        // `command` field puts an unrecognised command on the wire and readiness
        // can never succeed. The fixture used to answer anyway, which is how
        // this survived a green suite.
        const response = await rpc.request(
          { type: "get_state" },
          readinessTimeoutMs,
        );
        const data = response.data;
        if (
          typeof data !== "object" ||
          data === null ||
          Array.isArray(data) ||
          typeof (data as { sessionId?: unknown }).sessionId !== "string" ||
          (data as { sessionId: string }).sessionId.length === 0
        ) {
          throw new Error(
            "Pi get_state response did not include data.sessionId",
          );
        }
        report.session((data as { sessionId: string }).sessionId);
      } catch (error) {
        await rpc.close().catch(() => undefined);
        throw error;
      }
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
  };
}
