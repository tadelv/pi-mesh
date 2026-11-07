// SPDX-License-Identifier: GPL-3.0-or-later

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
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
): { summary: SessionSummary } | { skipped: string } {
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

/**
 * M8-6: a run's child transcript is a real Pi session file nested under the
 * sessions root at
 * `<root>/--<munged-cwd>--/<parent-session-stem>/<uuid>/run-0/session.jsonl`.
 * Verified against retained runs under `~/.pi/agent/sessions` before coding:
 * the `<parent-session-stem>` directory shares its stem with the parent's
 * `<stem>.jsonl` file, and the child's header id is its own UUID - not the
 * `<uuid>` directory name above it. Do not guess the depth from the issue
 * text alone; this is the layout pi-subagents writes.
 *
 * The child is addressable over the existing session wire by that header id,
 * resolved through the same code path as an ordinary session (see
 * `SessionStore.findSessionPaths`). It is deliberately NOT listed: a listed
 * id names a root transcript a job can own (ADR 0016), and promoting run
 * detail into the listing would change discovery order and the addressability
 * rules for ordinary sessions. Children are readable by id; never listed.
 */
const CHILD_TRANSCRIPT_FILENAME = "session.jsonl";

/** Hard bound on the nested walk, so a symlink cycle cannot spin it. */
const MAX_CHILD_SCAN_DEPTH = 8;

export interface RefusedChildTranscript {
  path: string;
  reason: string;
  /** The header id the file claimed, when it had a parsable one. */
  claimedId?: string;
}

export interface ChildTranscriptScan {
  files: string[];
  refused: RefusedChildTranscript[];
}

/**
 * Whether a discovered candidate resolves inside the sessions root. Both
 * sides are realpathed, so a symlink - or a symlinked ancestor - pointing
 * outside the root is refused, not clamped: a failed realpath fails closed
 * and anything outside is skipped as if it did not exist. Deleting this
 * check (or its call in the scan below) must fail the containment test by
 * name (M8-6).
 */
export async function isWithinSessionsRoot(
  sessionsRoot: string,
  candidate: string,
): Promise<boolean> {
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = await realpath(sessionsRoot);
    realCandidate = await realpath(candidate);
  } catch {
    return false;
  }
  const fileRelative = relative(realRoot, realCandidate);
  return (
    fileRelative !== "" &&
    fileRelative !== ".." &&
    !fileRelative.startsWith(`..${sep}`) &&
    !isAbsolute(fileRelative)
  );
}

/**
 * Every validated-candidate child transcript under the sessions root: files
 * named exactly `session.jsonl` nested at least two levels below a project
 * directory (the real shape is
 * `<project>/<parent-stem>/<uuid>/run-N/session.jsonl`). Files directly in
 * a project directory are ordinary sessions and stay with `sessionFiles`;
 * a flat `<root>/session.jsonl` (the `--session-dir` layout Pi writes past
 * the reader, per docs/GOTCHAS.md) is not a nested child either.
 *
 * Candidates that resolve outside the root are reported in `refused`, never
 * clamped into it. Content validation happens in the store, which owns the
 * error reporting; this scan reports placement only.
 */
export async function childTranscriptFiles(
  sessionsRoot: string,
): Promise<ChildTranscriptScan> {
  const files: string[] = [];
  const refused: RefusedChildTranscript[] = [];
  const seenDirs = new Set<string>();
  let projectDirs;
  try {
    projectDirs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { files, refused };
    throw error;
  }
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory() && !projectDir.isSymbolicLink()) continue;
    await collectChildTranscripts(
      join(sessionsRoot, projectDir.name),
      1,
      sessionsRoot,
      files,
      refused,
      seenDirs,
    );
  }
  return { files: files.sort(), refused };
}

async function collectChildTranscripts(
  directory: string,
  depth: number,
  sessionsRoot: string,
  files: string[],
  refused: RefusedChildTranscript[],
  seenDirs: Set<string>,
): Promise<void> {
  if (depth > MAX_CHILD_SCAN_DEPTH) return;
  let realDirectory: string;
  try {
    realDirectory = await realpath(directory);
  } catch {
    return;
  }
  if (seenDirs.has(realDirectory)) return;
  seenDirs.add(realDirectory);
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch {
    // Pi's guard, mirrored one level down: one unreadable directory must
    // not cost the whole discovery.
    return;
  }
  for (const child of children) {
    const fullPath = join(directory, child.name);
    if (!child.isDirectory() && !child.isSymbolicLink()) {
      if (child.isFile() && child.name === CHILD_TRANSCRIPT_FILENAME) {
        await includeChildCandidate(
          fullPath,
          depth,
          sessionsRoot,
          files,
          refused,
        );
      }
      continue;
    }
    // A symlink is descended through with its unresolved path so the
    // containment check below - not silent skipping - is what refuses an
    // escape: never discovering the file would pass the escape test with
    // the check deleted. A symlink that resolves to a file is fail-closed:
    // it is never followed, so it can never become addressable.
    let candidateStat;
    try {
      candidateStat = await stat(fullPath);
    } catch {
      continue;
    }
    if (candidateStat.isFile()) continue;
    if (!candidateStat.isDirectory()) continue;
    if (depth < MAX_CHILD_SCAN_DEPTH) {
      await collectChildTranscripts(
        fullPath,
        depth + 1,
        sessionsRoot,
        files,
        refused,
        seenDirs,
      );
    }
  }
}

async function includeChildCandidate(
  fullPath: string,
  depth: number,
  sessionsRoot: string,
  files: string[],
  refused: RefusedChildTranscript[],
): Promise<void> {
  // Depth 1 is the project directory itself: a session.jsonl there is not a
  // nested child.
  if (depth < 2) return;
  if (await isWithinSessionsRoot(sessionsRoot, fullPath)) {
    files.push(fullPath);
    return;
  }
  refused.push({
    path: fullPath,
    reason: `nested session file resolves outside the sessions root and is refused: ${fullPath}`,
  });
}

/**
 * Whether a nested candidate is a session the wire may serve. Ordinary
 * sessions keep their historical tolerance (a malformed line is reported and
 * the surviving entries are served); a nested file does not: it is refused
 * rather than half-parsed, and it must never materialise as an empty
 * session - a header-only file is mid-write or truncated, because Pi only
 * writes the file once a turn persists something.
 */
function validateChildTranscript(
  parsed: SessionParseResult,
  path: string,
): { valid: true } | { valid: false; reason: string; claimedId?: string } {
  const header = parsed.header;
  if (header === undefined) {
    return {
      valid: false,
      reason: `nested session file has no complete header and is refused rather than half-parsed: ${path}`,
    };
  }
  if (!isPlainUuid(header.id)) {
    return {
      valid: false,
      reason: `nested session id is not a UUID and cannot be addressed: ${header.id} (${path})`,
      claimedId: header.id,
    };
  }
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0]!;
    return {
      valid: false,
      reason: `nested session file is truncated or malformed and is refused rather than half-parsed: ${path} (line ${first.line}: ${first.message})`,
      claimedId: header.id,
    };
  }
  if (parsed.entries.length === 0) {
    return {
      valid: false,
      reason: `nested session file has no entries and is refused rather than materialising as an empty session: ${path}`,
      claimedId: header.id,
    };
  }
  return { valid: true };
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

  /**
   * M8-6 decision: the listing enumerates ONLY ordinary top-level session
   * files via `sessionFiles()`. A nested child transcript is detail of a
   * run, not a top-level session: listing it would change discovery order
   * and break the ADR 0016 rule that a listed id names a root transcript a
   * job can own. Children are addressable by id through `read()` (and the
   * shared `findSessionPaths` resolution below); listing one is wrong, so
   * this method refuses to, by construction.
   */
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
    return (await this.resolveSessionPaths(sessionId)).matches;
  }

  async findSessionPath(
    sessionId: string,
  ): Promise<{ path: string; parsed: SessionParseResult } | undefined> {
    return (await this.findSessionPaths(sessionId))[0];
  }

  /**
   * Ordinary sessions first (their order and precedence are unchanged),
   * then validated nested child transcripts. A nested file that fails
   * validation is recorded in `refusedNested` with its reason - never
   * served, never listed, never an empty session.
   */
  private async resolveSessionPaths(sessionId: string): Promise<{
    matches: { path: string; parsed: SessionParseResult }[];
    refusedNested: RefusedChildTranscript[];
  }> {
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
    const scan = await childTranscriptFiles(this.sessionsRoot);
    const refusedNested: RefusedChildTranscript[] = [...scan.refused];
    for (const refusal of scan.refused) {
      const error: SessionParseError = {
        line: 0,
        message: refusal.reason,
        path: refusal.path,
      };
      this.parseErrors.push(error);
      this.onError?.(error);
    }
    for (const path of scan.files) {
      let parsed: SessionParseResult;
      try {
        // Parsed directly, not via parseFile: a nested file with line
        // errors is refused as a whole (see validateChildTranscript), so
        // its raw line errors are not reported as ordinary parse errors.
        parsed = parseSession(await readFile(path), path);
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
      const checked = validateChildTranscript(parsed, path);
      if (!checked.valid) {
        refusedNested.push({
          path,
          reason: checked.reason,
          ...(checked.claimedId === undefined
            ? {}
            : { claimedId: checked.claimedId }),
        });
        const error: SessionParseError = {
          line: 1,
          message: checked.reason,
          path,
        };
        this.parseErrors.push(error);
        this.onError?.(error);
        continue;
      }
      if (parsed.header?.id === sessionId) matches.push({ path, parsed });
    }
    return { matches, refusedNested };
  }

  async read(request: SessionReadRequest): Promise<Event[]> {
    assertPlainUuid(request.id);
    this.parseErrors = [];

    const { matches, refusedNested } = await this.resolveSessionPaths(
      request.id,
    );
    const found = matches[0];
    if (found === undefined) {
      // A nested file that claimed this id but failed validation is a
      // refusal with its stated reason, not an unknown id and never a
      // half-parsed or empty session.
      const claimed = refusedNested.find(
        (refused) => refused.claimedId === request.id,
      );
      if (claimed !== undefined) {
        throw new Error(
          `Refusing to read session ${request.id}: ${claimed.reason}`,
        );
      }
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
