// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tri-state pid liveness, mirroring upstream's `checkPidLiveness`
 * (`pi-subagents/src/runs/background/stale-run-reconciler.js`):
 *
 * - `kill(pid, 0)` success means a process exists, reported as `alive` with
 *   reason `pid-alive` - never as proof it is this run's runner.
 * - `ESRCH` means no such process: `dead`.
 * - `EPERM` means a process exists but cannot be signalled: `unknown` with
 *   reason `permission-denied` - not alive.
 * - On Linux, a zombie (`/proc/<pid>/stat` state `Z`) is `dead`: GOTCHAS
 *   measured `kill(pid, 0)` succeeding for a zombie, so the signal alone
 *   cannot prove aliveness.
 * - On Linux, a pid in a different pid namespace than ours
 *   (`/proc/<pid>/ns/pid` vs `/proc/self/ns/pid`) is `unknown` with reason
 *   `namespace-unmatched`: the process exists but is not provably this
 *   run's runner. An unreadable namespace falls back to the kill(0) result.
 *
 * Only signal 0 is ever sent. There is no boolean `live` (ADR 0021).
 */

import * as fs from "node:fs";

import type { Liveness } from "./types.js";

export type KillFn = (pid: number, signal: 0) => void;

export interface ProbeLivenessDeps {
  kill?: KillFn;
  readFile?: (path: string, encoding: "utf8") => string;
  readlink?: (path: string) => string;
  platform?: NodeJS.Platform;
  now?: () => number;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Parse the state field out of `/proc/<pid>/stat`. The second field is the
 * comm in parentheses (which may itself contain parens), so the state is the
 * first character after the LAST `") "`.
 */
export function parseProcStatState(stat: string): string | undefined {
  const closeParen = stat.lastIndexOf(") ");
  if (closeParen < 0 || closeParen + 2 >= stat.length) {
    return undefined;
  }
  return stat[closeParen + 2];
}

export function probeLiveness(
  pid: unknown,
  deps: ProbeLivenessDeps = {},
): Liveness {
  const probedAt = deps.now?.() ?? Date.now();
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { state: "unknown", reason: "no-pid", probedAt };
  }
  const kill: KillFn =
    deps.kill ??
    ((target: number, signal: 0): void => {
      process.kill(target, signal);
    });
  try {
    kill(pid, 0);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") {
      return { state: "dead", reason: "pid-dead", probedAt };
    }
    if (code === "EPERM") {
      return { state: "unknown", reason: "permission-denied", probedAt };
    }
    return { state: "unknown", reason: "probe-failed", probedAt };
  }
  const platform = deps.platform ?? process.platform;
  if (platform === "linux") {
    const readlink =
      deps.readlink ??
      ((target: string): string => fs.readlinkSync(target, "utf8"));
    let selfScope: string | undefined;
    let targetScope: string | undefined;
    try {
      selfScope = readlink("/proc/self/ns/pid");
      targetScope = readlink(`/proc/${pid}/ns/pid`);
    } catch {
      selfScope = undefined;
      targetScope = undefined;
    }
    if (
      selfScope !== undefined &&
      targetScope !== undefined &&
      selfScope !== targetScope
    ) {
      return { state: "unknown", reason: "namespace-unmatched", probedAt };
    }
    const readFile =
      deps.readFile ??
      ((path: string, encoding: "utf8"): string =>
        fs.readFileSync(path, encoding));
    try {
      const stat = readFile(`/proc/${pid}/stat`, "utf8");
      if (parseProcStatState(stat) === "Z") {
        return { state: "dead", reason: "zombie", probedAt };
      }
    } catch {
      // procfs unavailable or unreadable: fall back to the kill(0) result.
    }
  }
  return { state: "alive", reason: "pid-alive", probedAt };
}
