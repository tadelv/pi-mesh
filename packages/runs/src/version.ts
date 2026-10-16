// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Pinned upstream version and layout guard.
 *
 * pi-subagents is a pinned registry dependency (exact version, not a range).
 * The read path (`status.json`) and the steer writer depend on an upstream
 * layout that is not a documented contract (ADR 0021 decision 3), so both
 * the version and the directory shape are checked before anything is
 * written. The shape check - not the version - decides whether an existing
 * run is readable or controllable, because the installed version cannot
 * establish which version produced an existing run's artifacts.
 */

export const PINNED_PI_SUBAGENTS_VERSION = "0.78.0";

/** The upstream releases this package was tested against. */
export const TESTED_PI_SUBAGENTS_RANGE = ">=0.78.0 <0.79.0";

export type SupportCheck = { ok: true } | { ok: false; reason: string };

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Refuses (typed, never throws) versions outside the tested range. */
export function assertSupportedVersion(installed: unknown): SupportCheck {
  if (typeof installed !== "string" || installed.trim() === "") {
    return { ok: false, reason: "missing-version" };
  }
  const parsed = parseVersion(installed);
  if (
    !parsed ||
    parsed[0] !== 0 ||
    parsed[1] !== 78 ||
    parsed[2] < 0 ||
    !Number.isSafeInteger(parsed[2])
  ) {
    return {
      ok: false,
      reason: `unsupported-version:${installed}`,
    };
  }
  return { ok: true };
}

import * as fs from "node:fs";
import * as path from "node:path";

export const EXPECTED_STATUS_FILE = "status.json";

/**
 * Recognise the expected run-directory shape: a directory holding a
 * `status.json` that parses to an object with a string `runId`.
 * Refuses (typed, never throws) anything else - a refusal, never a
 * fabricated run and never a write.
 */
export function assertSupportedLayout(runDir: unknown): SupportCheck {
  try {
    if (typeof runDir !== "string" || runDir === "") {
      return { ok: false, reason: "not-a-directory" };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(runDir);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return { ok: false, reason: "missing-run-dir" };
      }
      return { ok: false, reason: "unreadable-run-dir" };
    }
    if (!stat.isDirectory()) {
      return { ok: false, reason: "not-a-directory" };
    }
    const statusPath = path.join(runDir, EXPECTED_STATUS_FILE);
    let raw: string;
    try {
      const statusStat = fs.statSync(statusPath);
      if (!statusStat.isFile()) {
        return { ok: false, reason: "missing-status.json" };
      }
      raw = fs.readFileSync(statusPath, "utf8");
    } catch {
      return { ok: false, reason: "missing-status.json" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "malformed-status.json" };
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { runId?: unknown }).runId !== "string" ||
      (parsed as { runId: string }).runId === ""
    ) {
      return { ok: false, reason: "unrecognised-layout" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "unreadable-run-dir" };
  }
}
