// SPDX-License-Identifier: GPL-3.0-or-later

import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { createLogger, type Logger } from "@pi-mesh/shared";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 500;
/**
 * The largest single JSONL record accepted from Pi.
 *
 * Exceeding it stops the session rather than dropping the record: a dropped
 * dialog would hang forever, which is the failure this module exists to
 * prevent. That makes the ceiling a real operational bound rather than a
 * formality - `agent_end` carries every message of a run, so a long run can
 * legitimately approach it. M2-4 owns the resource policy and should revisit
 * this with measurements instead of inheriting the number.
 */
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_UI_TIMEOUT_MS = 1_000;

export interface PiRpcClientOptions {
  /** The resolved pi executable. Defaults to `pi` for the real agent. */
  piBinary?: string;
  /** Aliases kept useful for callers that call the executable a binary. */
  binary?: string;
  executable?: string;
  sessionDir?: string;
  sessionFile?: string;
  name?: string;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxRecordBytes?: number;
  maxStderrBytes?: number;
  uiTimeoutMs?: number;
  logger?: Logger;
  /**
   * Arguments placed before Pi's own flags. Used by tests and wrapper
   * executables, and by the real spawner for the validated model selection
   * (`--provider`/`--model`) from ADR 0017.
   */
  binaryArgs?: readonly string[];
  /** Optional environment override, primarily for deterministic fixture tests. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the child process. */
  cwd?: string;
}

export type PiRpcCommand = Record<string, unknown>;

/**
 * The environment a spawned Pi receives when the caller does not supply one.
 *
 * ADR 0008 decision 9 says the parent environment is "never passed wholesale"
 * and that the swarm key and mesh credentials are not inherited. This is the
 * minimal version of that: everything else is passed through, because Pi needs
 * its provider credentials and a usable PATH, but every PI_MESH_* variable is
 * removed. It is a filter rather than an allowlist because milestone 5 owns the
 * real policy; the point here is that forgetting to pass `env` must not leak
 * mesh secrets.
 */
function childEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (key.startsWith("PI_MESH_")) continue;
    environment[key] = value;
  }
  return environment;
}
export type PiRpcResponse = Record<string, unknown>;
export type PiRpcEvent = Record<string, unknown>;

export class PiRpcError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PiRpcError";
  }
}

export class PiRpcTimeoutError extends PiRpcError {
  constructor(
    readonly id: string,
    timeoutMs: number,
  ) {
    super(`Pi RPC request ${id} timed out after ${timeoutMs}ms`);
    this.name = "PiRpcTimeoutError";
  }
}

export class PiRpcEofError extends PiRpcError {
  constructor() {
    super("Pi RPC stdout reached EOF before the response arrived");
    this.name = "PiRpcEofError";
  }
}

export class PiRpcChildExitError extends PiRpcError {
  constructor(
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(
      `Pi RPC child exited before the response arrived${
        signal === null ? ` with code ${String(code)}` : ` from ${signal}`
      }`,
    );
    this.name = "PiRpcChildExitError";
  }
}

export class PiRpcMalformedRecordError extends PiRpcError {
  constructor(
    readonly record: string,
    cause: unknown,
  ) {
    super("Pi RPC emitted a malformed JSONL record", { cause });
    this.name = "PiRpcMalformedRecordError";
  }
}

export class PiRpcRecordTooLargeError extends PiRpcError {
  constructor(readonly maxBytes: number) {
    super(`Pi RPC JSONL record exceeds the ${maxBytes}-byte limit`);
    this.name = "PiRpcRecordTooLargeError";
  }
}

export class PiRpcResponseError extends PiRpcError {
  constructor(readonly response: PiRpcResponse) {
    const error = response.error;
    const message =
      // Pi's failure envelope carries `error` as a STRING, not an object:
      // {"type":"response","command":"…","success":false,"error":"Unknown
      // command: shutdown"} - verified against the real binary. Checking only
      // for an object discarded every real diagnostic and reported the generic
      // fallback, which is exactly the text M2-5 needs to say why a spawn
      // failed.
      typeof error === "string" && error.length > 0
        ? error
        : typeof error === "object" &&
            error !== null &&
            !Array.isArray(error) &&
            typeof (error as Record<string, unknown>).message === "string"
          ? String((error as Record<string, unknown>).message)
          : "Pi RPC returned an error response";
    super(message);
    this.name = "PiRpcResponseError";
  }
}

class LineDecoder {
  private pending = Buffer.alloc(0);

  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): string[] {
    if (chunk.byteLength === 0) return [];
    this.pending = Buffer.concat([this.pending, chunk]);
    const records: string[] = [];
    let newline = this.pending.indexOf(0x0a);
    while (newline !== -1) {
      const raw = this.pending.subarray(0, newline);
      if (raw.byteLength > this.maxBytes) {
        throw new PiRpcRecordTooLargeError(this.maxBytes);
      }
      let record = raw;
      if (record.byteLength > 0 && record[record.byteLength - 1] === 0x0d) {
        record = record.subarray(0, record.byteLength - 1);
      }
      // A zero-length record is ignored rather than fatal. Pi's own client
      // ignores non-JSON lines, and a bare newline can arrive from a descendant
      // that inherited fd 1: Pi's output guard redirects a stray
      // process.stdout.write to stderr, but an fs.writeSync(1, …) or a child
      // sharing the fd bypasses it. Tearing down the session and failing every
      // pending request because something printed a blank line would be a
      // disproportionate failure. Non-empty malformed records stay fatal -
      // those are the ones a client can actually be broken by.
      if (record.byteLength === 0) {
        this.pending = this.pending.subarray(newline + 1);
        newline = this.pending.indexOf(0x0a);
        continue;
      }
      records.push(record.toString("utf8"));
      this.pending = this.pending.subarray(newline + 1);
      newline = this.pending.indexOf(0x0a);
    }
    if (this.pending.byteLength > this.maxBytes) {
      throw new PiRpcRecordTooLargeError(this.maxBytes);
    }
    return records;
  }
}

type RequestId = string | number;
type PendingRequest = {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
};

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const FIRE_AND_FORGET_METHODS = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);

function positiveOption(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      "RPC timeout and size options must be greater than zero",
    );
  }
  return Math.floor(value);
}

function requestId(command: PiRpcCommand, next: number): RequestId {
  const id = command.id;
  if (typeof id === "string" || typeof id === "number") return id;
  return `pi-mesh-${next}`;
}

function idKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

/** A supervised long-lived `pi --mode rpc` process. */
export class PiRpcClient extends EventEmitter {
  readonly child: ChildProcess;
  readonly argv: readonly string[];
  readonly ready: Promise<void>;

  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly maxRecordBytes: number;
  private readonly maxStderrBytes: number;
  private readonly uiTimeoutMs: number;
  private readonly logger: Logger;
  private readonly decoder: LineDecoder;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closePromise: Promise<void>;
  private stderrText = "";
  private nextId = 1;
  private spawned = false;
  private signalled = false;
  private closed = false;
  private closeCode: number | null = null;
  private closeSignal: NodeJS.Signals | null = null;
  private exited = false;
  private failure: Error | undefined;
  private closing = false;

  constructor(options: PiRpcClientOptions = {}) {
    super();
    const binary =
      options.piBinary ?? options.binary ?? options.executable ?? "pi";
    const sessionDir = options.sessionDir ?? process.cwd();
    const name = options.name ?? "pi-mesh";
    this.requestTimeoutMs = positiveOption(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.shutdownTimeoutMs = positiveOption(
      options.shutdownTimeoutMs,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
    this.maxRecordBytes = positiveOption(
      options.maxRecordBytes,
      DEFAULT_MAX_RECORD_BYTES,
    );
    this.maxStderrBytes = positiveOption(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
    );
    this.uiTimeoutMs = positiveOption(
      options.uiTimeoutMs,
      DEFAULT_UI_TIMEOUT_MS,
    );
    this.logger = options.logger ?? createLogger({ name: "pi-rpc" });
    this.decoder = new LineDecoder(this.maxRecordBytes);

    const args = [
      ...(options.binaryArgs ?? []),
      "--mode",
      "rpc",
      ...(options.sessionFile === undefined
        ? ["--session-dir", sessionDir]
        : ["--session", options.sessionFile]),
      "--no-approve",
      "--name",
      name,
    ];
    this.argv = [binary, ...args];
    const spawnOptions: SpawnOptions = {
      shell: false,
      // Its OWN process group (`setsid()` on POSIX), always. That is what makes
      // the session's descendants reachable: the kernel reparents orphans to
      // init the moment the child dies, so afterwards there is no way to find
      // them (docs/GOTCHAS.md). Labelling the tree at spawn time is exact and
      // free; reconstructing it later is neither. See ADR 0008 decision 11.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? childEnvironment(process.env),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    };
    this.child = spawn(binary, args, spawnOptions);
    // A write to a destroyed stdin emits an asynchronous stream error. Without
    // a listener that is an uncaught exception and the whole agent dies, which
    // is a large failure for a child that has simply gone away.
    this.child.stdin?.on("error", (error: Error) => {
      this.fail(new PiRpcError("Pi RPC stdin error", { cause: error }));
    });
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      this.closeCode = code;
      this.closeSignal = signal;
      this.emit("exit", { code, signal });
      // Reject pending requests on EXIT, not only on close. If a descendant
      // inherited fd 1/2 the stdio never closes, so waiting for `close` would
      // leave every pending request to expire on its own timer and be reported
      // as a TIMEOUT - mislabelling a dead child as a slow one, which is the
      // distinction M2-2 exists to make. Idempotent on an empty map.
      if (!this.closing) {
        this.failPending(new PiRpcChildExitError(code, signal));
      }
    });
    this.closePromise = new Promise<void>((resolve) => {
      this.child.once("close", (code, signal) => {
        this.closed = true;
        this.closeCode = code;
        this.closeSignal = signal;
        if (
          !this.closing &&
          this.failure === undefined &&
          this.pending.size > 0
        ) {
          this.failPending(new PiRpcChildExitError(code, signal));
        }
        resolve();
      });
    });

    this.ready = new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        this.spawned = true;
        resolve();
      };
      const onError = (error: Error): void => {
        if (this.spawned) {
          this.fail(
            new PiRpcError("Pi RPC child process error", { cause: error }),
          );
          return;
        }
        this.failure = new PiRpcError("Unable to start Pi RPC child", {
          cause: error,
        });
        reject(this.failure);
      };
      this.child.once("spawn", onSpawn);
      this.child.once("error", onError);
    });

    this.child.stdout?.on("data", (chunk: Buffer | string) => {
      try {
        const records = this.decoder.push(
          typeof chunk === "string" ? Buffer.from(chunk) : chunk,
        );
        for (const record of records) this.handleRecord(record);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.stdout?.once("end", () => {
      // `close` follows stdio closure. Let it win the classification when the
      // process is exiting; a live child whose protocol stream ended is EOF.
      setTimeout(() => {
        if (this.closed || this.closing) return;
        this.fail(
          this.exited
            ? new PiRpcChildExitError(this.closeCode, this.closeSignal)
            : new PiRpcEofError(),
        );
      }, 0);
    });
    this.child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.stderrText = `${this.stderrText}${text}`;
      if (Buffer.byteLength(this.stderrText) > this.maxStderrBytes) {
        const bytes = Buffer.from(this.stderrText);
        this.stderrText = bytes
          .subarray(bytes.byteLength - this.maxStderrBytes)
          .toString("utf8");
      }
      this.emit("stderr", text);
    });
  }

  get stderr(): string {
    return this.stderrText;
  }

  get stdioClosed(): boolean {
    return this.closed;
  }

  /** Send a Pi RPC command and await only its matching response. */
  async request(
    command: PiRpcCommand,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<PiRpcResponse> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be greater than zero");
    }
    await this.ready;
    if (this.failure !== undefined) throw this.failure;
    if (
      this.closed ||
      this.child.stdin === null ||
      this.child.stdin.destroyed
    ) {
      throw new PiRpcChildExitError(this.closeCode, this.closeSignal);
    }
    const id = requestId(command, this.nextId++);
    const key = idKey(id);
    if (this.pending.has(key))
      throw new Error(`Duplicate Pi RPC request id ${String(id)}`);
    const message = { ...command, id };
    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new PiRpcTimeoutError(String(id), timeoutMs));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      try {
        this.child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(error);
      }
    });
  }

  /**
   * Stop the child: stdin EOF, then SIGTERM, then SIGKILL.
   *
   * There is no protocol shutdown command. `{type:"shutdown"}` is answered
   * `Unknown command: shutdown` by Pi 0.85.1 (verified against the real
   * binary), so this used to spend a round trip asking for something that does
   * not exist before falling through to signals. Closing stdin is the graceful
   * path: Pi treats stdin end as input end and exits cleanly (measured: exit
   * code 0 in about 100ms).
   *
   * Every wait is bounded, including the last one. Node fires `close` only when
   * the child has exited AND its stdio streams are closed, so a descendant that
   * inherited fd 1 or 2 keeps `close` from ever firing - and killing a child
   * does not kill its descendants. Awaiting the close promise without a bound
   * therefore hangs shutdown, which is the failure M1 already hit with
   * `server.stop()`.
   */
  async close(): Promise<void> {
    if (this.closed) {
      await this.waitForClose(this.shutdownTimeoutMs);
      return;
    }
    this.closing = true;
    if (this.spawned && !this.signalled) {
      try {
        // Graceful: ask Pi to finish by ending its input.
        this.child.stdin?.end();
      } catch {
        // A dead pipe falls through to signals.
      }
      await this.waitForClose(this.shutdownTimeoutMs);
    }
    if (!this.closed) {
      this.signalChild("SIGTERM");
      await this.waitForClose(this.shutdownTimeoutMs);
    }
    if (!this.closed) {
      this.signalChild("SIGKILL");
      await this.waitForClose(this.shutdownTimeoutMs);
    }
    // Final sweep, unconditionally - including when the graceful stage above
    // already closed the session. Nonsense? No: stdin EOF ends the SESSION, not
    // its descendants. They keep running, and once the session is gone they are
    // unfindable (the kernel reparents them to init; docs/GOTCHAS.md), so the
    // group is the last handle on them. ESRCH means the tree was already gone,
    // which is the common case and costs nothing.
    this.signalChild("SIGKILL");
    if (!this.closed) {
      // Deliberately not awaited further. The process is gone (or killed); what
      // is unobservable is the stdio closure, and hanging shutdown to observe
      // it is worse than reporting it. M2-4 needs to know this happened.
      this.logger.warn("Pi RPC child did not close its stdio; not waiting", {
        pid: this.child.pid,
      });
    }
    this.failPending(new PiRpcChildExitError(this.closeCode, this.closeSignal));
  }

  private async waitForClose(timeoutMs: number): Promise<void> {
    if (this.closed) return;
    await Promise.race([
      this.closePromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private handleRecord(record: string): void {
    let value: unknown;
    try {
      value = JSON.parse(record) as unknown;
    } catch (error) {
      throw new PiRpcMalformedRecordError(record, error);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new PiRpcMalformedRecordError(
        record,
        new TypeError("record is not an object"),
      );
    }
    const message = value as Record<string, unknown>;
    if (message.type === "response") {
      const id = message.id;
      if (typeof id !== "string" && typeof id !== "number") return;
      const key = idKey(id);
      const request = this.pending.get(key);
      if (request === undefined) return;
      this.pending.delete(key);
      clearTimeout(request.timer);
      if ("error" in message && message.error !== undefined) {
        request.reject(new PiRpcResponseError(message));
      } else {
        request.resolve(message);
      }
      return;
    }
    if (message.type === "extension_ui_request") {
      this.handleUiRequest(message);
      return;
    }
    this.emit("event", message as PiRpcEvent);
  }

  private handleUiRequest(message: Record<string, unknown>): void {
    const method = message.method;
    if (typeof method !== "string") {
      this.logger.warn("Dropped extension UI request without a method");
      return;
    }
    if (FIRE_AND_FORGET_METHODS.has(method)) {
      this.logger.info("Dropped fire-and-forget extension UI request", {
        method,
      });
      return;
    }
    if (!DIALOG_METHODS.has(method)) {
      this.logger.warn("Dropped unknown extension UI request", { method });
      return;
    }
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") {
      this.logger.warn("Dropped extension dialog without an id", { method });
      return;
    }
    let sent = false;
    const sendCancelled = (): void => {
      // `writable` as well as `closed`: the window between the child's stdin
      // being destroyed and the close event is exactly when this runs.
      if (sent || this.closed || this.child.stdin?.writable !== true) return;
      sent = true;
      try {
        this.child.stdin?.write(
          `${JSON.stringify({
            type: "extension_ui_response",
            id,
            cancelled: true,
          })}\n`,
        );
      } catch (error) {
        this.logger.warn("Unable to answer extension UI request", {
          method,
          error: String(error),
        });
      }
    };
    // Answer now: with no human present, "no" is the safe answer, and waiting
    // is the hang this exists to prevent. There is deliberately no timer here.
    // One was created and cleared on the next line, which is not a deadline,
    // and the comment claiming it was "our policy deadline if the stream is
    // backpressured" was simply false. A write that fails is logged in
    // sendCancelled; if backpressure ever needs a retry, it needs a real one.
    sendCancelled();
  }

  /**
   * Signal the child AND everything it spawned, by signalling its process group.
   *
   * Never falls back to signalling the pid alone while the group exists:
   * signalling the child by itself is precisely the leak this prevents, because
   * its descendants outlive it and are then unfindable. The fallback covers only
   * ESRCH - the group is already gone - so a child that is merely settling still
   * gets asked to stop.
   *
   * Known ceiling: a descendant that calls `setsid()` itself (a tool that
   * daemonizes) leaves the group and escapes this. Only a cgroup or a systemd
   * scope contains that, which is a deployment concern (docs/DEPLOYMENT.md).
   * PID reuse is the other edge: the kernel may recycle the id once the leader
   * is reaped, so a group signal after the child's exit is best-effort.
   */
  private signalChild(signal: NodeJS.Signals): void {
    this.signalled = true;
    const pid = this.child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          this.logger.warn("Unable to signal the child's process group", {
            pid,
            signal,
            error: String(error),
          });
        }
      }
    }
    try {
      this.child.kill(signal);
    } catch {
      // Already gone.
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined || this.closed) return;
    this.failure = error;
    this.failPending(error);
    this.emit("protocolError", error);
    this.signalChild("SIGTERM");
    setTimeout(() => {
      if (!this.closed) this.signalChild("SIGKILL");
    }, this.shutdownTimeoutMs);
  }

  private failPending(error: Error): void {
    for (const [key, request] of this.pending) {
      clearTimeout(request.timer);
      this.pending.delete(key);
      request.reject(error);
    }
  }
}

export function createPiRpcClient(
  options: PiRpcClientOptions = {},
): PiRpcClient {
  return new PiRpcClient(options);
}

export async function launchPiRpc(
  options: PiRpcClientOptions = {},
): Promise<PiRpcClient> {
  const client = new PiRpcClient(options);
  try {
    await client.ready;
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
