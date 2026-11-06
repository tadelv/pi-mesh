// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A pi-intercom broker client with no dependency on the pi-intercom package
 * (ADR 0023 decision 7).
 *
 * NO COMMAND INGRESS. The broker socket has no authentication - any same-UID
 * process, including any unrelated Pi session, can talk to it - so nothing
 * that arrives over this socket is ever executed, relayed to a peer, or
 * treated as authority. Broker replies and receipts are consumed as
 * untrusted data: this module only SENDS (register, list, send) and reads
 * back the replies those requests correlate. An unsolicited broker frame
 * (a `message`, `presence_update`, `session_joined`, ...) is ignored, never
 * dispatched. That is the rule that keeps the broker from becoming the
 * unauthenticated local route AGENTS.md forbids: the mesh never accepts a
 * command over this socket.
 *
 * Wire (from the pi-intercom v0.18.1 study, ADR 0023): a `node:net` socket
 * carrying 4-byte big-endian length + JSON frames with a 1 MiB cap, replies
 * correlated by `requestId` (health, list) or `message.id` (send).
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { ErrorCode, PiMeshError } from "@pi-mesh/shared";

/** The frame cap the broker enforces (broker/framing.ts). */
export const INTERCOM_MAX_FRAME_BYTES = 1024 * 1024;

/** The protocol family the health probe must answer (broker/paths.ts). */
export const INTERCOM_PROTOCOL_NAME = "pi-intercom";
export const INTERCOM_PROTOCOL_VERSION = 1;

export interface IntercomOptions {
  /**
   * Broker socket path. Defaults to
   * `$PI_CODING_AGENT_DIR/intercom/broker.sock`, or
   * `$HOME/.pi/agent/intercom/broker.sock` when unset (broker/paths.ts).
   */
  socketPath?: string;
  /** Per-operation timeout in milliseconds. Defaults to 5000. */
  timeoutMs?: number;
  /**
   * How long a send waits for an `injected` receipt after the broker's own
   * reply before reporting `injected: false`. Defaults to 2000. Bounded:
   * an unbounded wait would hang a skill call on a recipient that never
   * answers.
   */
  receiptWaitMs?: number;
  /**
   * Whether the broker was present and healthy. The CLI probes this once at
   * startup and passes the answer here; card, caps and dispatch then agree
   * by construction. Defaults to false: absent broker, absent capability.
   */
  available?: boolean;
}

export interface IntercomSession {
  id: string;
  name?: string;
  /** Display data only (types.ts): liveness, never identity. */
  cwd: string;
  model: string;
  /** Display data only: a PID, not a job id. */
  pid: number;
  startedAt: number;
  lastActivity: number;
}

export type IntercomDelivery = "delivered" | "queued" | "unknown" | "failed";

export interface IntercomSendResult {
  delivery: IntercomDelivery;
  /** The broker's own reason code, passed through unchanged (e.g. E_TARGET_NOT_FOUND). */
  code?: string;
  /** The broker's own reason, passed through unchanged. */
  reason?: string;
  /**
   * True only when a `message_receipt` with status `injected` arrived within
   * the bounded wait - the only receipt that means a turn started. Never
   * inferred from `socket_delivered` or `queued`, which are transport facts.
   */
  injected: boolean;
  /**
   * Present on `unknown` only: the message may have arrived, so the caller
   * must not retry blindly.
   */
  note?: string;
}

/**
 * Resolve the broker socket path. Windows named pipes are out of scope
 * (ADR 0023): refuse with a stated reason rather than guessing a pipe name.
 */
export function resolveIntercomSocketPath(
  options: Pick<IntercomOptions, "socketPath"> = {},
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    throw new PiMeshError(
      -32004,
      "intercom is unavailable on Windows: named-pipe transport is out of scope (ADR 0023)",
    );
  }
  if (options.socketPath !== undefined) return options.socketPath;
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir =
    configured !== undefined && configured.length > 0
      ? configured
      : join(home, ".pi", "agent");
  return join(agentDir, "intercom", "broker.sock");
}

/** Encode one length-prefixed frame. Exported so tests can assert the wire bytes. */
export function encodeIntercomFrame(message: unknown): Buffer {
  const json = JSON.stringify(message);
  const payloadLength = Buffer.byteLength(json, "utf8");
  if (payloadLength > INTERCOM_MAX_FRAME_BYTES) {
    throw new PiMeshError(
      -32602,
      `intercom frame of ${payloadLength} bytes exceeds the ${INTERCOM_MAX_FRAME_BYTES}-byte cap`,
    );
  }
  const frame = Buffer.allocUnsafe(4 + payloadLength);
  frame.writeUInt32BE(payloadLength, 0);
  frame.write(json, 4, payloadLength, "utf8");
  return frame;
}

type FrameHandler = (message: unknown) => void;

/**
 * Incremental frame reader for one socket: reassembles partial reads into
 * 4-byte big-endian length + JSON frames, enforcing the 1 MiB cap.
 */
export function createIntercomFrameReader(
  onMessage: FrameHandler,
  onError: (error: Error) => void,
  maxFrameBytes = INTERCOM_MAX_FRAME_BYTES,
): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const payloadLength = buffer.readUInt32BE(0);
      if (payloadLength > maxFrameBytes) {
        onError(
          new Error(
            `Intercom frame length ${payloadLength} exceeds maximum ${maxFrameBytes} bytes`,
          ),
        );
        return;
      }
      if (buffer.length < 4 + payloadLength) return;
      const payload = buffer.subarray(4, 4 + payloadLength);
      buffer = buffer.subarray(4 + payloadLength);
      let message: unknown;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch (error) {
        onError(
          new Error(
            `Failed to parse intercom message: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      try {
        onMessage(message);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict shape check: a fixture must refuse what reality refuses. */
function isIntercomSessionInfo(value: unknown): value is IntercomSession {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.cwd !== "string") return false;
  if (typeof value.model !== "string") return false;
  if (typeof value.pid !== "number") return false;
  if (typeof value.startedAt !== "number") return false;
  if (typeof value.lastActivity !== "number") return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One broker connection: connect, register the send-only identity, run one
 * operation, close. A fresh connection per skill call keeps no registration
 * alive between calls and never listens for commands.
 */
class BrokerConnection {
  /**
   * The one reader for this connection, attached for its whole life. A
   * frame that arrives in the same chunk as the reply it follows (e.g. a
   * receipt sent right after `delivered`) is parsed and offered to the
   * current waiter immediately; detaching the listener between phases
   * instead would silently drop exactly those frames and make `injected`
   * flaky. Unsolicited frames match nothing and are ignored - never
   * relayed, never executed (see the module comment).
   */
  private waiter:
    | {
        match: (message: unknown) => unknown;
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;

  private constructor(private readonly socket: Socket) {
    const reader = createIntercomFrameReader(
      (message) => this.deliver(message),
      (error) => this.fail(error),
    );
    socket.on("data", reader);
    socket.once("error", (error: Error) => {
      this.fail(new Error(`intercom socket error: ${errorMessage(error)}`));
    });
    socket.once("close", () => {
      this.fail(
        new Error("intercom connection closed before a matching reply arrived"),
      );
    });
  }

  /**
   * Frames the current waiter does not match are stashed (bounded), not
   * dropped: a receipt written in the same tick as its `delivered` reply
   * is parsed while the send is still the current waiter, and the
   * `injected` wait that starts afterwards must still see it. Stashing is
   * what makes wait-for-receipt-after-reply non-flaky.
   */
  private readonly stashed: unknown[] = [];

  private deliver(message: unknown): void {
    if (
      isRecord(message) &&
      message.type === "error" &&
      typeof message.error === "string"
    ) {
      this.fail(
        new PiMeshError(
          ErrorCode.SpawnFailed,
          `intercom broker refused: ${message.error}`,
        ),
      );
      return;
    }
    const waiter = this.waiter;
    if (waiter !== undefined) {
      const matched = waiter.match(message);
      if (matched !== undefined) {
        this.waiter = undefined;
        clearTimeout(waiter.timer);
        waiter.resolve(matched);
        return;
      }
    }
    if (this.stashed.length < 32) this.stashed.push(message);
  }

  /** A stashed frame matching a later waiter: consume it without waiting. */
  private takeStashed<T>(
    match: (message: unknown) => T | undefined,
  ): T | undefined {
    const index = this.stashed.findIndex(
      (message) => match(message) !== undefined,
    );
    if (index === -1) return undefined;
    const [message] = this.stashed.splice(index, 1);
    return match(message);
  }

  private fail(error: Error): void {
    const waiter = this.waiter;
    if (waiter === undefined) return;
    this.waiter = undefined;
    clearTimeout(waiter.timer);
    this.socket.destroy();
    waiter.reject(error);
  }

  private arm<T>(
    match: (message: unknown) => T | undefined,
    timeoutMs: number,
    send: (() => void) | undefined,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.waiter !== undefined) {
        reject(
          new Error("intercom connection already has a request in flight"),
        );
        return;
      }
      const stashed = this.takeStashed(match);
      if (stashed !== undefined) {
        resolve(stashed);
        return;
      }
      const timer = setTimeout(() => {
        this.fail(new Error(`intercom request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.waiter = {
        match: match as (message: unknown) => unknown,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      };
      try {
        send?.();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  static async open(
    socketPath: string,
    timeoutMs: number,
  ): Promise<BrokerConnection> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const pending = connect(socketPath);
      const timer = setTimeout(() => {
        pending.destroy();
        reject(
          new Error(
            `intercom connect timed out after ${timeoutMs}ms: ${socketPath}`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      pending.once("connect", () => {
        clearTimeout(timer);
        resolve(pending);
      });
      pending.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new BrokerConnection(socket);
  }

  /**
   * Send one frame and resolve with the first reply matching `match`.
   * Every other frame - including unsolicited broker pushes - is ignored:
   * nothing inbound is ever dispatched (see the module comment).
   */
  request<T>(
    payload: unknown,
    match: (message: unknown) => T | undefined,
    timeoutMs: number,
  ): Promise<T> {
    return this.arm(match, timeoutMs, () => {
      this.socket.write(encodeIntercomFrame(payload));
    });
  }

  /**
   * Resolve with the first inbound frame matching `match`, without sending
   * anything. Used for the bounded `injected` receipt wait: the only frame
   * that may still arrive on this connection is the recipient's receipt.
   */
  waitFor<T>(
    match: (message: unknown) => T | undefined,
    timeoutMs: number,
  ): Promise<T> {
    return this.arm(match, timeoutMs, undefined);
  }

  close(): void {
    this.socket.destroy();
  }
}

/**
 * Register the send-only identity. The registration carries only what the
 * broker requires (broker/protocol.ts `isSessionRegistration`) and the
 * connection is closed after the operation, so nothing can steer this
 * registration - it exists to send.
 */
async function registerSender(
  connection: BrokerConnection,
  timeoutMs: number,
): Promise<string> {
  const now = Date.now();
  const sessionId = await connection.request(
    {
      type: "register",
      session: {
        name: "pi-mesh-agent",
        cwd: process.cwd(),
        model: "pi-mesh",
        pid: process.pid,
        startedAt: now,
        lastActivity: now,
        status: "mesh-relay",
      },
    },
    (message) => {
      if (
        isRecord(message) &&
        message.type === "registered" &&
        typeof message.sessionId === "string"
      ) {
        return message.sessionId;
      }
      return undefined;
    },
    timeoutMs,
  );
  return sessionId;
}

export class IntercomClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly receiptWaitMs: number;

  constructor(options: IntercomOptions = {}) {
    // Resolved eagerly so a refused platform fails here with its stated
    // reason, before any availability check can mask it.
    this.socketPath = resolveIntercomSocketPath(options);
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.receiptWaitMs = options.receiptWaitMs ?? 2000;
  }

  /** Live sessions on this machine, as the broker reports them. */
  async listSessions(): Promise<IntercomSession[]> {
    let connection: BrokerConnection;
    try {
      connection = await BrokerConnection.open(this.socketPath, this.timeoutMs);
    } catch (error) {
      throw new PiMeshError(
        -32004,
        `intercom.list refused: no live broker at ${this.socketPath} (${errorMessage(error)})`,
      );
    }
    try {
      await registerSender(connection, this.timeoutMs);
      const requestId = randomUUID();
      const sessions = await connection.request(
        { type: "list", requestId },
        (message) => {
          if (
            isRecord(message) &&
            message.type === "sessions" &&
            message.requestId === requestId &&
            Array.isArray(message.sessions) &&
            message.sessions.every(isIntercomSessionInfo)
          ) {
            return message.sessions as IntercomSession[];
          }
          if (
            isRecord(message) &&
            message.type === "sessions" &&
            message.requestId === requestId
          ) {
            throw new PiMeshError(
              ErrorCode.SpawnFailed,
              "intercom broker replied with an unsupported sessions shape",
            );
          }
          return undefined;
        },
        this.timeoutMs,
      );
      // cwd, name and pid pass through as display data only (types.ts): the
      // broker's trust model is a same-UID file permission, not an identity,
      // so none of these fields identifies anything.
      return sessions.map((session) => ({
        id: session.id,
        ...(session.name === undefined ? {} : { name: session.name }),
        cwd: session.cwd,
        model: session.model,
        pid: session.pid,
        startedAt: session.startedAt,
        lastActivity: session.lastActivity,
      }));
    } catch (error) {
      if (error instanceof PiMeshError) throw error;
      throw new PiMeshError(
        -32004,
        `intercom.list refused: ${errorMessage(error)}`,
      );
    } finally {
      connection.close();
    }
  }

  /**
   * Send a message to one live session. The result speaks the protocol's
   * own delivery vocabulary (ADR 0023 decision 4): delivered / queued /
   * unknown, the broker's reason code passed through, and injected only
   * when a `message_receipt` with status `injected` actually arrives within
   * the bounded wait. Never reported as steered for anything weaker.
   */
  async sendMessage(to: string, text: string): Promise<IntercomSendResult> {
    let connection: BrokerConnection;
    try {
      connection = await BrokerConnection.open(this.socketPath, this.timeoutMs);
    } catch (error) {
      throw new PiMeshError(
        -32004,
        `intercom.send refused: no live broker at ${this.socketPath} (${errorMessage(error)})`,
      );
    }
    try {
      await registerSender(connection, this.timeoutMs);
      type SendOutcome =
        | { delivery: "delivered" | "queued" }
        | {
            failed: true;
            delivery: "failed" | "unknown";
            code?: string;
            reason: string;
          };
      const messageId = randomUUID();
      const outcome = await connection.request<SendOutcome>(
        {
          type: "send",
          to,
          message: {
            id: messageId,
            timestamp: Date.now(),
            content: { text },
          },
        },
        (message): SendOutcome | undefined => {
          if (!isRecord(message) || message.messageId !== messageId)
            return undefined;
          if (
            message.type === "delivered" &&
            (message.delivery === "socket_delivered" ||
              message.delivery === "queued")
          ) {
            return {
              delivery: message.delivery === "queued" ? "queued" : "delivered",
            };
          }
          const reason: unknown = message.reason;
          const code: unknown = message.code;
          if (
            message.type === "delivery_failed" &&
            typeof reason === "string" &&
            (message.delivery === "failed" || message.delivery === "unknown")
          ) {
            const failed: SendOutcome = {
              failed: true,
              delivery: message.delivery,
              reason,
            };
            if (typeof code === "string") failed.code = code;
            return failed;
          }
          if (
            message.type === "delivered" ||
            message.type === "delivery_failed"
          ) {
            throw new PiMeshError(
              ErrorCode.SpawnFailed,
              "intercom broker replied with an unsupported delivery shape",
            );
          }
          return undefined;
        },
        this.timeoutMs,
      );
      if ("failed" in outcome) {
        if (outcome.delivery === "unknown") {
          const result: IntercomSendResult = {
            delivery: "unknown",
            reason: outcome.reason,
            injected: false,
            note: "delivery unknown: the message may have arrived; do not retry blindly",
          };
          if (outcome.code !== undefined) result.code = outcome.code;
          return result;
        }
        const result: IntercomSendResult = {
          delivery: "failed",
          reason: outcome.reason,
          injected: false,
        };
        if (outcome.code !== undefined) result.code = outcome.code;
        return result;
      }
      const injected = await this.waitForInjected(connection, messageId);
      return { delivery: outcome.delivery, injected };
    } catch (error) {
      if (error instanceof PiMeshError) throw error;
      throw new PiMeshError(
        -32004,
        `intercom.send refused: ${errorMessage(error)}`,
      );
    } finally {
      connection.close();
    }
  }

  /**
   * Bounded wait for the recipient's own `injected` receipt on the same
   * connection. Only status `injected` counts - `receiver_received` and
   * `queued` are transport facts, and the absence of any receipt reports
   * `injected: false`, never an inference.
   */
  private waitForInjected(
    connection: BrokerConnection,
    messageId: string,
  ): Promise<boolean> {
    return connection
      .waitFor((message) => {
        if (
          isRecord(message) &&
          message.type === "message_receipt" &&
          isRecord(message.receipt) &&
          message.receipt.messageId === messageId &&
          message.receipt.status === "injected"
        ) {
          return true;
        }
        return undefined;
      }, this.receiptWaitMs)
      .catch(() => false);
  }
}

/**
 * Health probe: does a broker answer at this socket, speaking protocol
 * family `pi-intercom` v1? Never throws: any failure - no socket, a close,
 * a wrong family, a timeout - is absence, reported as false. A `health_ok`
 * for another protocol family is NOT compatibility (ADR 0023 decision 6):
 * only an exact `pi-intercom`/1 match passes.
 */
export async function probeIntercomBroker(
  socketPath?: string,
  timeoutMs = 1000,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  let resolved: string;
  try {
    resolved = resolveIntercomSocketPath(
      socketPath === undefined ? {} : { socketPath },
      process.env,
      homedir(),
      platform,
    );
  } catch {
    return false;
  }
  let connection: BrokerConnection;
  try {
    connection = await BrokerConnection.open(resolved, timeoutMs);
  } catch {
    return false;
  }
  try {
    const requestId = randomUUID();
    const ok = await connection.request(
      { type: "health", requestId },
      (message) =>
        isRecord(message) &&
        message.type === "health_ok" &&
        message.requestId === requestId &&
        message.protocol === INTERCOM_PROTOCOL_NAME &&
        message.version === INTERCOM_PROTOCOL_VERSION,
      timeoutMs,
    );
    return ok === true;
  } catch {
    return false;
  } finally {
    connection.close();
  }
}
