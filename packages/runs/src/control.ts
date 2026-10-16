// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Control writes: `stop` through pi-subagents' public export, `steer`
 * through a request file we write ourselves (upstream exports no writer).
 *
 * Both are requests, not outcomes: the response names the request path and
 * never claims the run stopped or the steer was delivered. A closed inbox
 * is a typed refusal, never an unhandled throw and never a claimed success.
 * Nothing is written into a run directory whose shape is not the tested
 * one, or when the installed version is outside the tested range.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { requestAsyncStop } from "pi-subagents/control-channel";

import {
  assertSupportedLayout,
  assertSupportedVersion,
  PINNED_PI_SUBAGENTS_VERSION,
} from "./version.js";

export const STEER_INBOX_CLOSED_FILE = "steer-inbox-closed.json";
export const STOP_INBOX_CLOSED_MESSAGE =
  "Runner stop inbox is closed. Retry stop after runner shutdown is observed.";

/** Upstream's own validation bounds, mirrored so the runner accepts us. */
export const MAX_STEER_MESSAGE_BYTES = 128 * 1024;
export const MAX_STEER_REQUEST_ID_LENGTH = 256;
const MAX_TARGET_INDEX = 1_000_000;

export interface ControlOptions {
  /**
   * Installed pi-subagents version. Defaults to the pin this package was
   * built against; inject another value to test the version gate.
   */
  installedVersion?: string;
  now?: () => number;
  randomId?: () => string;
}

export type StopRunResult =
  | { ok: true; requestPath: string }
  | { ok: false; code: string; message: string };

export interface SteerRequestInput {
  message: string;
  id?: string;
  ts?: number;
  mode?: "steer" | "follow_up" | "auto";
  targetIndex?: number;
  source?: string;
}

export type WriteSteerResult =
  { ok: true; path: string } | { ok: false; code: string; message: string };

function checkWritable(
  runDir: string,
  installedVersion: string | undefined,
): { ok: true } | { ok: false; code: string; message: string } {
  const version = assertSupportedVersion(
    installedVersion ?? PINNED_PI_SUBAGENTS_VERSION,
  );
  if (!version.ok) {
    return {
      ok: false,
      code: "unsupported-version",
      message: `Refusing control write: ${version.reason}.`,
    };
  }
  const layout = assertSupportedLayout(runDir);
  if (!layout.ok) {
    return {
      ok: false,
      code: "unrecognised-layout",
      message: `Refusing control write: ${layout.reason}.`,
    };
  }
  return { ok: true };
}

function closedMarkerPath(runDir: string): string {
  return path.join(runDir, "control", STEER_INBOX_CLOSED_FILE);
}

function closedMarkerPresent(runDir: string): boolean {
  try {
    return fs.existsSync(closedMarkerPath(runDir));
  } catch {
    // A marker we cannot stat is treated as present: fail closed.
    return true;
  }
}

function validId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id !== "" &&
    /^[^\s]+$/.test(id) &&
    id.length <= MAX_STEER_REQUEST_ID_LENGTH
  );
}

function validTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0;
}

/**
 * Write a stop request through upstream's public `requestAsyncStop`.
 * Upstream's closed-inbox throw becomes a typed refusal; no throw ever
 * escapes, and a refusal never claims success.
 */
export function stopRun(
  runDir: string,
  options: ControlOptions = {},
): StopRunResult {
  try {
    const writable = checkWritable(runDir, options.installedVersion);
    if (!writable.ok) {
      return writable;
    }
    try {
      const requestPath = requestAsyncStop(
        runDir,
        {},
        options.now !== undefined ? { now: options.now } : {},
      );
      return { ok: true, requestPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("stop inbox is closed")) {
        return { ok: false, code: "stop-inbox-closed", message };
      }
      return { ok: false, code: "stop-failed", message };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "stop-failed", message };
  }
}

/**
 * Write a steer request into `<runDir>/control/steer-requests/`, mirroring
 * upstream's validation bounds and file shape (`<ts>-<base64url(id)>.json`,
 * `{type:"steer", id, ts, message, ...}`).
 *
 * Refuses when `control/steer-inbox-closed.json` exists - before and after
 * the write, removing the file if the marker appeared in between - leaves
 * no partial file (temp file in the same directory + rename), and returns
 * the written path.
 */
export function writeSteerRequest(
  runDir: string,
  request: SteerRequestInput,
  options: ControlOptions = {},
): WriteSteerResult {
  try {
    const writable = checkWritable(runDir, options.installedVersion);
    if (!writable.ok) {
      return writable;
    }
    const message =
      typeof request.message === "string" ? request.message.trim() : "";
    if (message === "") {
      return {
        ok: false,
        code: "malformed-steer-request",
        message: "Steer message must not be empty.",
      };
    }
    if (Buffer.byteLength(message, "utf8") > MAX_STEER_MESSAGE_BYTES) {
      return {
        ok: false,
        code: "malformed-steer-request",
        message: `Steer message exceeds ${MAX_STEER_MESSAGE_BYTES} UTF-8 bytes.`,
      };
    }
    const id = request.id ?? options.randomId?.() ?? randomUUID();
    if (!validId(id)) {
      return {
        ok: false,
        code: "malformed-steer-request",
        message: "Steer id must be a non-empty string without whitespace.",
      };
    }
    const ts = request.ts ?? options.now?.() ?? Date.now();
    if (!validTs(ts)) {
      return {
        ok: false,
        code: "malformed-steer-request",
        message: "Steer ts must be a positive finite number.",
      };
    }
    if (
      request.mode !== undefined &&
      request.mode !== "steer" &&
      request.mode !== "follow_up" &&
      request.mode !== "auto"
    ) {
      return {
        ok: false,
        code: "malformed-steer-request",
        message: "Steer mode must be steer, follow_up or auto.",
      };
    }
    if (
      request.targetIndex !== undefined &&
      (!Number.isInteger(request.targetIndex) ||
        request.targetIndex < 0 ||
        request.targetIndex > MAX_TARGET_INDEX)
    ) {
      return {
        ok: false,
        code: "malformed-steer-request",
        message: "Steer targetIndex must be an integer between 0 and 1000000.",
      };
    }
    if (
      request.source !== undefined &&
      (typeof request.source !== "string" ||
        request.source.trim() === "" ||
        request.source.length > 256)
    ) {
      return {
        ok: false,
        code: "malformed-steer-request",
        message:
          "Steer source must be a non-empty string of at most 256 chars.",
      };
    }
    if (closedMarkerPresent(runDir)) {
      return {
        ok: false,
        code: "steer-inbox-closed",
        message: "Async run no longer accepts steering requests.",
      };
    }
    const payload: Record<string, unknown> = {
      type: "steer",
      id,
      ts,
      message,
    };
    if (request.mode !== undefined && request.mode !== "steer") {
      payload["mode"] = request.mode;
    }
    if (request.targetIndex !== undefined) {
      payload["targetIndex"] = request.targetIndex;
    }
    if (request.source !== undefined) {
      payload["source"] = request.source;
    }
    const dir = path.join(runDir, "control", "steer-requests");
    const fileName = `${String(ts).padStart(13, "0")}-${Buffer.from(id).toString("base64url")}.json`;
    const filePath = path.join(dir, fileName);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(
      dir,
      `.${fileName}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), {
        encoding: "utf-8",
        flag: "wx",
      });
      fs.renameSync(tempPath, filePath);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
    if (closedMarkerPresent(runDir)) {
      fs.rmSync(filePath, { force: true });
      return {
        ok: false,
        code: "steer-inbox-closed",
        message:
          "Async run stopped accepting steering before the request was committed.",
      };
    }
    return { ok: true, path: filePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "steer-failed", message };
  }
}
