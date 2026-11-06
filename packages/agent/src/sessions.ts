// SPDX-License-Identifier: GPL-3.0-or-later

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
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

/**
 * Mirrors Pi's own session-directory encoding exactly. A leading separator is
 * stripped and `/`, `\` and `:` are encoded, which is why
 * /Users/me/repo becomes --Users-me-repo-- and not ---Users-me-repo--.
 * docs/PROTOCOL.md's paraphrase ("`/` replaced by `-`") is what produced the
 * extra dash; Pi's source is authoritative.
 */
export function defaultSessionsRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

export function sessionDirectory(
  cwd: string,
  sessionsRoot = defaultSessionsRoot(),
): string {
  const encoded = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return join(sessionsRoot, `--${encoded}--`);
}

/** Backwards-compatible name for the Pi storage-directory encoding. */
export const getSessionStorageDir = sessionDirectory;

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
      if (id === undefined || timestamp === undefined) {
        report(lineNumber, "session header requires string id and timestamp");
        return;
      }
      // Pi documents cwd as an empty string for old sessions and tolerates a
      // non-string value. Requiring it here would make such sessions both
      // invisible to list() and unaddressable by read().
      const cwd = stringField(value, "cwd") ?? "";
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

/**
 * Whether this machine shows a recognised session layout: the configured
 * sessions root exists and is a directory. Never throws: a missing or
 * unreadable root is "no layout", not a crash. Evaluated once at agent
 * startup (like the runs layout): a machine that gains its sessions
 * directory later needs a restart before `mesh.watch` is advertised.
 */
export function hasRecognisedSessionLayout(
  sessionsRoot = defaultSessionsRoot(),
): boolean {
  try {
    return statSync(sessionsRoot).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A single session file reduced to its advertised summary, or the reason it
 * must be skipped. The rules are the listing's rules, not a second set:
 * no complete header is not a session, and a header id that is not a UUID
 * cannot be addressed. Callers report the reason (the listing through
 * `SessionStore.errors`, the watch through its `onError`); nothing here
 * emits an empty session.
 */
export function summarizeParsed(
  parsed: SessionParseResult,
  path: string,
):
  | { summary: SessionSummary }
  | { skipped: string } {
  const header = parsed.header;
  if (header === undefined) {
    return {
      skipped: `session file has no complete header and is skipped: ${path}`,
    };
  }
  if (!isPlainUuid(header.id)) {
    return {
      skipped: `session id is not a UUID and cannot be addressed: ${header.id}`,
    };
  }
  const last = parsed.entries.at(-1);
  const named = parsed.entries.findLast(
    (entry) => entry.type === "session_info",
  );
  const trimmed = typeof named?.name === "string" ? named.name.trim() : "";
  const sessionName = trimmed === "" ? undefined : trimmed;
  return {
    summary: {
      id: header.id,
      project: header.cwd,
      ...(sessionName === undefined ? {} : { name: sessionName }),
      started_at: header.timestamp,
      updated_at: last?.timestamp ?? header.timestamp,
    },
  };
}

/**
 * Every `*.jsonl` under the enumerated session directories
 * (`<root>/--<munged-cwd>--/`), across all projects. Exported for the
 * inventory watch, which must stat the same enumerated set the listing
 * reads - not just the root, where an append inside an existing file
 * would never register.
 */
export async function sessionFiles(sessionsRoot: string): Promise<string[]> {
  let directories;
  try {
    directories = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const files: string[] = [];
  for (const directory of directories) {
    // Pi accepts symlinked session directories, and a Dirent for a symlink is
    // not a directory, so checking isDirectory() alone silently skips them.
    if (!directory.isDirectory() && !directory.isSymbolicLink()) continue;
    const directoryPath = join(sessionsRoot, directory.name);
    // Pi guards this read: one unreadable directory must not cost the whole
    // listing.
    let children;
    try {
      children = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }
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
    this.sessionsRoot = options.sessionsRoot ?? defaultSessionsRoot();
    this.onError = options.onError;
  }

  get errors(): SessionParseError[] {
    return [...this.parseErrors];
  }

  async list(): Promise<SessionSummary[]> {
    this.parseErrors = [];
    const summaries: SessionSummary[] = [];
    for (const path of await sessionFiles(this.sessionsRoot)) {
      let parsed: SessionParseResult;
      try {
        parsed = await this.parseFile(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
        const warning: SessionParseError = {
          line: 0,
          message: `session file disappeared before it could be read: ${path} (ENOENT)`,
          path,
        };
        this.parseErrors.push(warning);
        this.onError?.(warning);
        continue;
      }
      const reduced = summarizeParsed(parsed, path);
      if ("skipped" in reduced) {
        // A file with no complete header is not a session and was always
        // skipped silently here; only an unaddressable id is reported,
        // because Pi permits a caller-supplied id and silence would hide a
        // real session with no trace of why.
        if (reduced.skipped.includes("not a UUID")) {
          const error: SessionParseError = {
            line: 1,
            message: reduced.skipped,
            path,
          };
          this.parseErrors.push(error);
          this.onError?.(error);
        }
        continue;
      }
      summaries.push(reduced.summary);
    }
    return summaries;
  }

  /**
   * Locate the file for a session id, returning the parse it already did.
   * Sharing the walk and the parse matters: callers that re-read the file
   * after this return can see a different session (a replace between the two
   * reads), and re-parsing also double-reports every parse error.
   */
  async findSessionPaths(
    sessionId: string,
  ): Promise<{ path: string; parsed: SessionParseResult }[]> {
    const matches: { path: string; parsed: SessionParseResult }[] = [];
    for (const path of await sessionFiles(this.sessionsRoot)) {
      let parsed: SessionParseResult;
      try {
        parsed = await this.parseFile(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
        const warning: SessionParseError = {
          line: 0,
          message: `session file disappeared before it could be read: ${path} (ENOENT)`,
          path,
        };
        this.parseErrors.push(warning);
        this.onError?.(warning);
        continue;
      }
      if (parsed.header?.id === sessionId) matches.push({ path, parsed });
    }
    return matches;
  }

  async findSessionPath(
    sessionId: string,
  ): Promise<{ path: string; parsed: SessionParseResult } | undefined> {
    return (await this.findSessionPaths(sessionId))[0];
  }

  async read(request: SessionReadRequest): Promise<Event[]> {
    assertPlainUuid(request.id);
    this.parseErrors = [];

    const found = await this.findSessionPath(request.id);
    if (found === undefined) {
      throw new Error(`Unknown session id: ${request.id}`);
    }
    const start =
      request.since === undefined
        ? -1
        : found.parsed.entries.findIndex((entry) => entry.id === request.since);
    if (request.since !== undefined && start === -1) {
      throw new Error(`Unknown session entry id: ${request.since}`);
    }
    return found.parsed.entries.slice(start + 1).map((entry) => ({
      entryId: entry.id,
      type: entry.type,
      timestamp: entry.timestamp,
      data: entry,
    }));
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
