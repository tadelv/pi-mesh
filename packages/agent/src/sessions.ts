// SPDX-License-Identifier: GPL-3.0-or-later

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Event, SessionSummary } from "@pi-mesh/protocol";
import { decodeJsonl } from "./jsonl.js";

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionFileEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface SessionParseError {
  line: number;
  message: string;
  path?: string;
}

export interface SessionParseResult {
  header?: SessionHeader;
  entries: SessionFileEntry[];
  errors: SessionParseError[];
}

export interface SessionStoreOptions {
  /** Override the normal ~/.pi/agent/sessions directory, principally for tests. */
  sessionsRoot?: string;
  onError?: (error: SessionParseError) => void;
}

export interface SessionReadRequest {
  id: string;
  since?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPlainUuid(id: string): boolean {
  return UUID.test(id);
}

export function assertPlainUuid(id: string): void {
  if (!isPlainUuid(id)) {
    throw new Error("Session id must be a plain UUID");
  }
}

export function getSessionStorageDir(
  cwd: string,
  sessionsRoot = join(homedir(), ".pi", "agent", "sessions"),
): string {
  return join(sessionsRoot, `--${cwd.replaceAll("/", "-")}--`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function parseError(
  line: number,
  message: string,
  sourcePath: string | undefined,
): SessionParseError {
  return sourcePath === undefined
    ? { line, message }
    : { line, message, path: sourcePath };
}

/** Parse a session document without mutating it or requiring a known version. */
export function parseSession(
  content: string | Uint8Array,
  sourcePath?: string,
): SessionParseResult {
  const errors: SessionParseError[] = [];
  const entries: SessionFileEntry[] = [];
  let header: SessionHeader | undefined;
  const lines = decodeJsonl(content);

  const report = (line: number, message: string): void => {
    errors.push(parseError(line, message, sourcePath));
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === "") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      report(
        lineNumber,
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const value = record(parsed);
    if (value === undefined) {
      report(lineNumber, "session line must be a JSON object");
      return;
    }

    if (lineNumber === 1) {
      if (value.type !== "session") {
        report(lineNumber, "first session line must have type session");
        return;
      }
      const id = stringField(value, "id");
      const timestamp = stringField(value, "timestamp");
      const cwd = stringField(value, "cwd");
      if (id === undefined || timestamp === undefined || cwd === undefined) {
        report(
          lineNumber,
          "session header requires string id, timestamp, and cwd",
        );
        return;
      }
      const version = value.version;
      if (version !== undefined && typeof version !== "number") {
        report(lineNumber, "session header version must be a number");
        return;
      }
      header = {
        type: "session",
        ...(version === undefined ? {} : { version }),
        id,
        timestamp,
        cwd,
        ...(typeof value.parentSession === "string"
          ? { parentSession: value.parentSession }
          : {}),
      };
      return;
    }

    const type = stringField(value, "type");
    const timestamp = stringField(value, "timestamp");
    if (type === undefined || timestamp === undefined) {
      report(lineNumber, "session entry requires string type and timestamp");
      return;
    }

    let id = stringField(value, "id");
    let parentId = value.parentId;
    // Pi v1 has no tree IDs and generates them while loading. Deterministic
    // IDs keep this read-only parser's cursors stable without writing back.
    if (header?.version === undefined || header.version < 2) {
      id ??= `v1-${lineNumber}`;
      parentId =
        parentId === undefined ? (entries.at(-1)?.id ?? null) : parentId;
    }
    if (
      id === undefined ||
      (parentId !== null && typeof parentId !== "string")
    ) {
      report(lineNumber, "session entry requires string id and parentId");
      return;
    }

    entries.push({ ...value, type, id, parentId, timestamp });
  });

  return { ...(header === undefined ? {} : { header }), entries, errors };
}

async function sessionFiles(sessionsRoot: string): Promise<string[]> {
  let directories;
  try {
    directories = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const files: string[] = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const directoryPath = join(sessionsRoot, directory.name);
    const children = await readdir(directoryPath, { withFileTypes: true });
    for (const child of children) {
      if (child.isFile() && child.name.endsWith(".jsonl")) {
        files.push(join(directoryPath, child.name));
      }
    }
  }
  return files.sort();
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export class SessionStore {
  private readonly sessionsRoot: string;
  private readonly onError: ((error: SessionParseError) => void) | undefined;
  private parseErrors: SessionParseError[] = [];

  constructor(options: SessionStoreOptions = {}) {
    this.sessionsRoot =
      options.sessionsRoot ?? join(homedir(), ".pi", "agent", "sessions");
    this.onError = options.onError;
  }

  get errors(): SessionParseError[] {
    return [...this.parseErrors];
  }

  async list(): Promise<SessionSummary[]> {
    this.parseErrors = [];
    const summaries: SessionSummary[] = [];
    for (const path of await sessionFiles(this.sessionsRoot)) {
      const parsed = await this.parseFile(path);
      const header = parsed.header;
      if (header === undefined || !isPlainUuid(header.id)) continue;

      // No `status` or `ended_at`: Pi's session format records no lifecycle
      // state, so neither is derivable. Emitting "unknown" for every session
      // would look like data while carrying none, which is the same defect as
      // the removed `fp` TXT key (ADR 0006). `updated_at` is last activity,
      // and is named accordingly rather than pretending to be an end time.
      const last = parsed.entries.at(-1);
      const named = parsed.entries.find(
        (entry) => entry.type === "session_info",
      );
      const sessionName =
        typeof named?.name === "string" ? named.name : undefined;
      summaries.push({
        id: header.id,
        project: header.cwd,
        ...(sessionName === undefined ? {} : { name: sessionName }),
        started_at: header.timestamp,
        updated_at: last?.timestamp ?? header.timestamp,
      });
    }
    return summaries;
  }

  async read(request: SessionReadRequest): Promise<Event[]> {
    assertPlainUuid(request.id);
    this.parseErrors = [];

    for (const path of await sessionFiles(this.sessionsRoot)) {
      const parsed = await this.parseFile(path);
      if (parsed.header?.id !== request.id) continue;
      const start =
        request.since === undefined
          ? -1
          : parsed.entries.findIndex((entry) => entry.id === request.since);
      if (request.since !== undefined && start === -1) {
        throw new Error(`Unknown session entry id: ${request.since}`);
      }
      return parsed.entries.slice(start + 1).map((entry) => ({
        entryId: entry.id,
        type: entry.type,
        timestamp: entry.timestamp,
        data: entry,
      }));
    }

    throw new Error(`Unknown session id: ${request.id}`);
  }

  private async parseFile(path: string): Promise<SessionParseResult> {
    const parsed = parseSession(await readFile(path), path);
    this.parseErrors.push(...parsed.errors);
    for (const error of parsed.errors) this.onError?.(error);
    return parsed;
  }
}

export async function sessionList(
  options?: SessionStoreOptions,
): Promise<SessionSummary[]> {
  return new SessionStore(options).list();
}

export async function sessionRead(
  request: SessionReadRequest,
  options?: SessionStoreOptions,
): Promise<Event[]> {
  return new SessionStore(options).read(request);
}
