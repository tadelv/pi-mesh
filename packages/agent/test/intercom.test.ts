// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * ADR 0023: the agent is a pi-intercom broker client; the broker is never a
 * command ingress.
 *
 * Each clause below fails by name when its protection is removed: the failure
 * line names the clause, never a transport error from somewhere else. The
 * fixture broker speaks the real framing (4-byte big-endian length + JSON,
 * 1 MiB cap) and the response shapes from the study (`health_ok`,
 * `registered`, `sessions`, `delivered`, `delivery_failed`,
 * `message_receipt`), and - like the real broker - destroys a connection
 * that sends `list`/`send` before `register`, so a client that skips the
 * send-only registration fails here instead of passing against a fixture
 * that answers any shape.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAgentServer,
  createSkillRegistry,
  servedSkills,
  signedHeaders,
  JobManager,
  createIntercomFrameReader,
  encodeIntercomFrame,
  INTERCOM_MAX_FRAME_BYTES,
  probeIntercomBroker,
  resolveIntercomSocketPath,
  SKILL_CLASSIFICATION,
  type IntercomSendResult,
} from "../src/index.js";

const testIdentity = {
  peerId: "22222222-2222-4222-8222-222222222222",
  name: "intercom-test",
};
const callerIdentity = {
  peerId: "33333333-3333-4333-8333-333333333333",
  name: "caller",
};
const testKey = Buffer.from("pi-mesh-vector-key-0123456789abc");
const wrongKey = Buffer.from("pi-mesh-vector-key-9876543210abcd");

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface FixtureSession {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
}

interface SendScript {
  reply: Record<string, unknown>;
  receipts?: Record<string, unknown>[];
}

interface FixtureBehavior {
  sessions: FixtureSession[];
  healthProtocol?: string;
  healthVersion?: number;
  /** Reply per send target. Unknown targets get E_TARGET_NOT_FOUND, as the real broker does. */
  send?: (to: string, messageId: string) => SendScript;
  /** An unsolicited frame pushed right after register: must be ignored, never answered. */
  pushAfterRegister?: Record<string, unknown>;
}

interface FixtureBroker {
  socketPath: string;
  received: { type: string; raw: unknown }[];
  close: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function startFixtureBroker(
  dir: string,
  behavior: FixtureBehavior,
): Promise<FixtureBroker> {
  const socketPath = join(dir, `broker-${randomUUID()}.sock`);
  const received: { type: string; raw: unknown }[] = [];
  const server: Server = createServer((socket: Socket) => {
    let registered = false;
    const reader = createIntercomFrameReader(
      (message) => {
        if (!isRecord(message) || typeof message.type !== "string") {
          socket.destroy();
          return;
        }
        received.push({ type: message.type, raw: message });
        if (message.type === "health") {
          if (typeof message.requestId !== "string") {
            socket.destroy();
            return;
          }
          socket.write(
            encodeIntercomFrame({
              type: "health_ok",
              requestId: message.requestId,
              protocol: behavior.healthProtocol ?? "pi-intercom",
              version: behavior.healthVersion ?? 1,
            }),
          );
          return;
        }
        if (message.type === "register") {
          // Mirror reality (broker/protocol.ts isSessionRegistration): a
          // shape the fixture does not cover is refused, not papered over.
          const session = message.session;
          if (
            !isRecord(session) ||
            typeof session.cwd !== "string" ||
            typeof session.model !== "string" ||
            typeof session.pid !== "number" ||
            typeof session.startedAt !== "number" ||
            typeof session.lastActivity !== "number"
          ) {
            socket.write(
              encodeIntercomFrame({
                type: "error",
                error: "Invalid register message",
              }),
            );
            socket.destroy();
            return;
          }
          registered = true;
          socket.write(
            encodeIntercomFrame({
              type: "registered",
              sessionId: randomUUID(),
            }),
          );
          if (behavior.pushAfterRegister !== undefined) {
            socket.write(encodeIntercomFrame(behavior.pushAfterRegister));
          }
          return;
        }
        // The real broker throws on list/send before register; the fixture
        // must refuse what reality refuses, or a client that skips the
        // send-only registration would pass here and fail against a broker.
        if (!registered) {
          socket.write(
            encodeIntercomFrame({
              type: "error",
              error: `Received ${message.type} before register`,
            }),
          );
          socket.destroy();
          return;
        }
        if (message.type === "list") {
          if (typeof message.requestId !== "string") {
            socket.destroy();
            return;
          }
          socket.write(
            encodeIntercomFrame({
              type: "sessions",
              requestId: message.requestId,
              sessions: behavior.sessions,
            }),
          );
          return;
        }
        if (message.type === "send") {
          const clientMessage = message.message;
          const messageId =
            isRecord(clientMessage) && typeof clientMessage.id === "string"
              ? clientMessage.id
              : "unknown";
          if (typeof message.to !== "string" || !isRecord(clientMessage)) {
            socket.write(
              encodeIntercomFrame({
                type: "delivery_failed",
                messageId,
                reason: "Invalid message format",
                code: "E_INVALID_MESSAGE",
                delivery: "failed",
                retryable: false,
                outcomeKnown: true,
              }),
            );
            return;
          }
          if (!behavior.sessions.some((session) => session.id === message.to)) {
            socket.write(
              encodeIntercomFrame({
                type: "delivery_failed",
                messageId,
                reason: "Session not found",
                code: "E_TARGET_NOT_FOUND",
                delivery: "failed",
                retryable: false,
                outcomeKnown: true,
              }),
            );
            return;
          }
          const script = behavior.send?.(message.to as string, messageId) ?? {
            reply: {
              type: "delivered",
              messageId,
              delivery: "socket_delivered",
              retryable: false,
              outcomeKnown: true,
            },
          };
          socket.write(encodeIntercomFrame(script.reply));
          for (const receipt of script.receipts ?? []) {
            socket.write(encodeIntercomFrame(receipt));
          }
          return;
        }
        socket.destroy();
      },
      () => socket.destroy(),
    );
    socket.on("data", reader);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    received,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      }),
  };
}

function liveSession(id: string): FixtureSession {
  return {
    id,
    name: `session-${id.slice(0, 8)}`,
    cwd: `/tmp/work-${id.slice(0, 8)}`,
    model: "test-model",
    pid: 4242,
    startedAt: 1700000000000,
    lastActivity: 1700000001000,
  };
}

/** A JobManager that starts nothing: every send to an unknown job refuses. */
function stubJobs(): JobManager {
  return new JobManager({
    spawnJob: () => ({
      pid: 4242,
      argv: [],
      stdioClosed: true,
      ready: Promise.resolve(),
      command: async () => ({ success: true }),
      close: async () => undefined,
    }),
    logger,
    unacknowledgedTtlMs: 5_000,
  });
}

function sendMessage(skill: string, input: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        messageId: "message-1",
        role: "ROLE_USER",
        parts: [{ data: { skill, input } }],
      },
    },
  };
}

async function postRpc(
  port: number,
  body: unknown,
  key: Buffer = testKey,
): Promise<{
  status: number;
  parsed: { error?: { code?: number; message?: string }; result?: unknown };
}> {
  const text = JSON.stringify(body);
  const useHeaders = signedHeaders(key, callerIdentity, {
    method: "POST",
    path: "/",
    body: text,
    recipientPeerId: testIdentity.peerId,
  });
  const response = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const client = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(text),
            "A2A-Version": "1.0",
            ...useHeaders,
          },
        },
        (incoming) => {
          let received = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk: string) => (received += chunk));
          incoming.on("end", () =>
            resolve({ status: incoming.statusCode ?? 0, body: received }),
          );
        },
      );
      client.on("error", reject);
      client.end(text);
    },
  );
  return {
    status: response.status,
    parsed: JSON.parse(response.body) as {
      error?: { code?: number; message?: string };
      result?: unknown;
    },
  };
}

describe("ADR 0023 intercom as a local channel", () => {
  it("framing: 4-byte big-endian length + JSON, 1 MiB cap", () => {
    const frame = encodeIntercomFrame({ type: "health", requestId: "r1" });
    const payload = Buffer.from(
      JSON.stringify({ type: "health", requestId: "r1" }),
      "utf8",
    );
    expect(frame.subarray(0, 4).readUInt32BE(0)).toBe(payload.length);
    expect(frame.subarray(4).equals(payload)).toBe(true);
    expect(() =>
      encodeIntercomFrame({
        type: "send",
        blob: "x".repeat(INTERCOM_MAX_FRAME_BYTES),
      }),
    ).toThrow(/exceeds the \d+-byte cap/);
    // Partial reads reassemble: fed one byte at a time, the reader still
    // delivers exactly one message.
    const delivered: unknown[] = [];
    const reader = createIntercomFrameReader(
      (message) => {
        delivered.push(message);
      },
      (error) => {
        throw error;
      },
    );
    for (let offset = 0; offset < frame.length; offset += 1) {
      reader(frame.subarray(offset, offset + 1));
    }
    expect(delivered).toEqual([{ type: "health", requestId: "r1" }]);
    // An over-cap length destroys the frame instead of allocating it.
    const evil = Buffer.alloc(4);
    evil.writeUInt32BE(INTERCOM_MAX_FRAME_BYTES + 1, 0);
    let failed: Error | undefined;
    const guard = createIntercomFrameReader(
      () => {
        throw new Error("over-cap frame must not be delivered");
      },
      (error) => {
        failed = error;
      },
    );
    guard(evil);
    expect(failed?.message).toMatch(/exceeds maximum/);
  });

  it("health probe answers true on a live broker of the pi-intercom v1 family", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-intercom-"));
    const broker = await startFixtureBroker(dir, { sessions: [] });
    try {
      await expect(probeIntercomBroker(broker.socketPath)).resolves.toBe(true);
    } finally {
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("health probe is false for another protocol family, a wrong version, and no socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-intercom-"));
    const renamed = await startFixtureBroker(dir, {
      sessions: [],
      healthProtocol: "pi-intercom-next",
    });
    const downgraded = await startFixtureBroker(dir, {
      sessions: [],
      healthVersion: 2,
    });
    try {
      // Compatibility is not called "v1 safe": a health answer from another
      // family proves nothing and must read as absence, never as support.
      await expect(probeIntercomBroker(renamed.socketPath)).resolves.toBe(
        false,
      );
      await expect(probeIntercomBroker(downgraded.socketPath)).resolves.toBe(
        false,
      );
      await expect(
        probeIntercomBroker(join(dir, "no-such-broker.sock")),
      ).resolves.toBe(false);
    } finally {
      await renamed.close();
      await downgraded.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("win32 named pipes are out of scope and refused with a stated reason", async () => {
    expect(() => resolveIntercomSocketPath({}, {}, "/home/u", "win32")).toThrow(
      /Windows.*named-pipe.*out of scope/,
    );
    await expect(
      probeIntercomBroker("/whatever.sock", 50, "win32"),
    ).resolves.toBe(false);
  });

  it("socket path defaults to the agent dir's intercom socket", () => {
    expect(
      resolveIntercomSocketPath(
        {},
        { PI_CODING_AGENT_DIR: "/agent/dir" },
        "/home/u",
        "linux",
      ),
    ).toBe(join("/agent/dir", "intercom", "broker.sock"));
    expect(resolveIntercomSocketPath({}, {}, "/home/u", "linux")).toBe(
      join("/home/u", ".pi", "agent", "intercom", "broker.sock"),
    );
  });

  it("list returns the sessions the broker reports; cwd/name/pid are display data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-intercom-"));
    const sessions = [
      liveSession("aaaaaaaa-0000-4000-8000-000000000001"),
      liveSession("bbbbbbbb-0000-4000-8000-000000000002"),
    ];
    const broker = await startFixtureBroker(dir, { sessions });
    try {
      const registry = createSkillRegistry({
        intercom: { available: true, socketPath: broker.socketPath },
      });
      const result = (await registry.invoke("intercom.list", {})) as {
        sessions: Record<string, unknown>[];
      };
      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0]).toMatchObject({
        id: sessions[0]!.id,
        name: sessions[0]!.name,
        cwd: sessions[0]!.cwd,
        model: sessions[0]!.model,
        pid: sessions[0]!.pid,
        started_at: new Date(sessions[0]!.startedAt).toISOString(),
        last_activity: new Date(sessions[0]!.lastActivity).toISOString(),
      });
      // The send-only registration goes first: the fixture destroys a
      // connection that lists before registering, so this passing proves
      // the client registered before it listed.
      expect(broker.received.map((entry) => entry.type)).toEqual([
        "register",
        "list",
      ]);
    } finally {
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("send to an unknown target surfaces E_TARGET_NOT_FOUND, not a generic failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-intercom-"));
    const broker = await startFixtureBroker(dir, { sessions: [] });
    try {
      const registry = createSkillRegistry({
        intercom: {
          available: true,
          socketPath: broker.socketPath,
          receiptWaitMs: 50,
        },
      });
      const result = (await registry.invoke("intercom.send", {
        to: "no-such-session",
        message: "hello",
      })) as IntercomSendResult;
      expect(result.delivery).toBe("failed");
      expect(result.code).toBe("E_TARGET_NOT_FOUND");
      expect(result.reason).toBe("Session not found");
      expect(result.injected).toBe(false);
    } finally {
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("delivery reports delivered vs queued in the broker's own words", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-intercom-"));
    const direct = liveSession("aaaaaaaa-0000-4000-8000-000000000001");
    const queued = liveSession("bbbbbbbb-0000-4000-8000-000000000002");
    const broker = await startFixtureBroker(dir, {
      sessions: [direct, queued],
      send: (to, messageId) => ({
        reply:
          to === queued.id
            ? {
                type: "delivered",
                messageId,
                delivery: "queued",
                retryable: false,
                outcomeKnown: true,
              }
            : {
                type: "delivered",
                messageId,
                delivery: "socket_delivered",
                retryable: false,
                outcomeKnown: true,
              },
      }),
    });
    try {
      const registry = createSkillRegistry({
        intercom: {
          available: true,
          socketPath: broker.socketPath,
          receiptWaitMs: 50,
        },
      });
      const socketDelivered = (await registry.invoke("intercom.send", {
        to: direct.id,
        message: "hello",
      })) as IntercomSendResult;
      expect(socketDelivered).toMatchObject({
        delivery: "delivered",
        injected: false,
      });
      expect(socketDelivered).not.toHaveProperty("code");
      const queuedResult = (await registry.invoke("intercom.send", {
        to: queued.id,
        message: "hello",
      })) as IntercomSendResult;
      expect(queuedResult).toMatchObject({
        delivery: "queued",
        injected: false,
      });
    } finally {
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("unknown reads as may-have-arrived, never as failure and never retried blindly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-intercom-"));
    const target = liveSession("aaaaaaaa-0000-4000-8000-000000000001");
    const broker = await startFixtureBroker(dir, {
      sessions: [target],
      send: (_to, messageId) => ({
        reply: {
          type: "delivery_failed",
          messageId,
          reason: "Receiver did not confirm receipt",
          code: "E_RECEIPT_TIMEOUT",
          delivery: "unknown",
          retryable: true,
          outcomeKnown: false,
        },
      }),
    });
    try {
      const registry = createSkillRegistry({
        intercom: {
          available: true,
          socketPath: broker.socketPath,
          receiptWaitMs: 50,
        },
      });
      const result = (await registry.invoke("intercom.send", {
        to: target.id,
        message: "hello",
      })) as IntercomSendResult;
      expect(result.delivery).toBe("unknown");
      expect(result.code).toBe("E_RECEIPT_TIMEOUT");
      expect(result.injected).toBe(false);
      expect(result.note).toMatch(/may have arrived; do not retry blindly/);
    } finally {
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("injected is set only when a message_receipt with status injected arrives in time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-intercom-"));
    const target = liveSession("aaaaaaaa-0000-4000-8000-000000000001");
    const broker = await startFixtureBroker(dir, {
      sessions: [target],
      send: (_to, messageId) => ({
        reply: {
          type: "delivered",
          messageId,
          delivery: "socket_delivered",
          retryable: false,
          outcomeKnown: true,
        },
        receipts: [
          {
            type: "message_receipt",
            from: target,
            receipt: {
              messageId,
              status: "injected",
              timestamp: Date.now(),
            },
          },
        ],
      }),
    });
    try {
      const registry = createSkillRegistry({
        intercom: {
          available: true,
          socketPath: broker.socketPath,
          receiptWaitMs: 2000,
        },
      });
      const result = (await registry.invoke("intercom.send", {
        to: target.id,
        message: "hello",
      })) as IntercomSendResult;
      expect(result).toMatchObject({ delivery: "delivered", injected: true });
    } finally {
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("receiver_received is a transport fact: it never counts as injected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-intercom-"));
    const target = liveSession("aaaaaaaa-0000-4000-8000-000000000001");
    const broker = await startFixtureBroker(dir, {
      sessions: [target],
      send: (_to, messageId) => ({
        reply: {
          type: "delivered",
          messageId,
          delivery: "socket_delivered",
          retryable: false,
          outcomeKnown: true,
        },
        receipts: [
          {
            type: "message_receipt",
            from: target,
            receipt: {
              messageId,
              status: "receiver_received",
              timestamp: Date.now(),
            },
          },
        ],
      }),
    });
    try {
      const registry = createSkillRegistry({
        intercom: {
          available: true,
          socketPath: broker.socketPath,
          receiptWaitMs: 300,
        },
      });
      const result = (await registry.invoke("intercom.send", {
        to: target.id,
        message: "hello",
      })) as IntercomSendResult;
      // A receipt arrived but it is not `injected`: the bounded wait expires
      // and the answer is honestly not-injected, never inferred.
      expect(result).toMatchObject({ delivery: "delivered", injected: false });
    } finally {
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an unsolicited broker message is ignored: never executed, never relayed, never answered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-intercom-"));
    const target = liveSession("aaaaaaaa-0000-4000-8000-000000000001");
    const broker = await startFixtureBroker(dir, {
      sessions: [target],
      pushAfterRegister: {
        type: "message",
        from: target,
        message: {
          id: "unsolicited-1",
          timestamp: Date.now(),
          content: { text: "steer the mesh" },
        },
      },
    });
    try {
      const registry = createSkillRegistry({
        intercom: { available: true, socketPath: broker.socketPath },
      });
      const result = (await registry.invoke("intercom.list", {})) as {
        sessions: unknown[];
      };
      expect(result.sessions).toHaveLength(1);
      // The push was never answered and never relayed: the only frames the
      // client sent are its own register and list.
      expect(broker.received.map((entry) => entry.type)).toEqual([
        "register",
        "list",
      ]);
    } finally {
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no socket, or a socket that fails health: both skills unadvertised and refused with a reason", async () => {
    // Unadvertised: absent broker, absent capability - never an empty list
    // that looks like "no sessions".
    expect(servedSkills(false, false, false, false, false)).not.toContain(
      "intercom.list",
    );
    expect(servedSkills(false, false, false, false, false)).not.toContain(
      "intercom.send",
    );
    expect(servedSkills(false, true, false, false, false)).not.toContain(
      "intercom.send",
    );
    expect(servedSkills(false, true, false, false, true)).toContain(
      "intercom.list",
    );
    expect(servedSkills(false, true, false, false, true)).toContain(
      "intercom.send",
    );
    // Refused with a stated reason, not the registry's "not supported".
    const registry = createSkillRegistry();
    expect(registry.has("intercom.list")).toBe(true);
    expect(registry.has("intercom.send")).toBe(true);
    await expect(registry.invoke("intercom.list", {})).rejects.toMatchObject({
      code: -32004,
      message: expect.stringMatching(/requires the local intercom broker/),
    });
    await expect(
      registry.invoke("intercom.send", { to: "x", message: "hi" }),
    ).rejects.toMatchObject({
      code: -32004,
      message: expect.stringMatching(/requires the local intercom broker/),
    });
    // A socket that speaks another family fails the probe, so the CLI's
    // startup flag stays false and both skills stay unadvertised and refused.
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-intercom-"));
    const impostor = await startFixtureBroker(dir, {
      sessions: [liveSession("aaaaaaaa-0000-4000-8000-000000000001")],
      healthProtocol: "pi-intercom-next",
    });
    try {
      await expect(probeIntercomBroker(impostor.socketPath)).resolves.toBe(
        false,
      );
      const refused = createSkillRegistry({
        intercom: { available: false, socketPath: impostor.socketPath },
      });
      await expect(refused.invoke("intercom.list", {})).rejects.toMatchObject({
        code: -32004,
        message: expect.stringMatching(/requires the local intercom broker/),
      });
    } finally {
      await impostor.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the classification table owns both skills: exposure and requirement", () => {
    expect(SKILL_CLASSIFICATION["intercom.list"]).toEqual({
      exposure: "peer",
      requires: "intercom",
    });
    expect(SKILL_CLASSIFICATION["intercom.send"]).toEqual({
      exposure: "gated",
      requires: "intercom",
    });
  });

  it("an unpaired caller is refused both skills", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-intercom-"));
    const broker = await startFixtureBroker(dir, { sessions: [] });
    const server = createAgentServer({
      host: "127.0.0.1",
      port: 0,
      swarmKey: testKey,
      identity: testIdentity,
      sessionsRoot: await mkdtemp(join(tmpdir(), "pi-mesh-intercom-sess-")),
      skillRegistry: createSkillRegistry({
        intercom: { available: true, socketPath: broker.socketPath },
      }),
    });
    try {
      const { port } = await server.start();
      for (const skill of ["intercom.list", "intercom.send"] as const) {
        const input =
          skill === "intercom.list" ? {} : { to: "x", message: "hi" };
        const { parsed } = await postRpc(
          port,
          sendMessage(skill, input),
          wrongKey,
        );
        expect(parsed.error?.code).toBe(-32100);
      }
    } finally {
      await server.stop();
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("intercom.send is refused without the execution grant and accepted with it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-intercom-"));
    const target = liveSession("aaaaaaaa-0000-4000-8000-000000000001");
    const broker = await startFixtureBroker(dir, { sessions: [target] });
    const sessionsRoot = await mkdtemp(
      join(tmpdir(), "pi-mesh-intercom-sess-"),
    );
    const intercom = {
      available: true,
      socketPath: broker.socketPath,
      receiptWaitMs: 50,
    };
    const openRegistry = (): ReturnType<typeof createSkillRegistry> =>
      createSkillRegistry({ intercom });
    try {
      // Gate closed: the same -32102 as steer, from the one shared gate -
      // and no call reaches the handler.
      const denied = createAgentServer({
        host: "127.0.0.1",
        port: 0,
        swarmKey: testKey,
        identity: testIdentity,
        sessionsRoot,
        skillRegistry: openRegistry(),
        intercom,
      });
      const deniedAddress = await denied.start();
      try {
        const send = await postRpc(
          deniedAddress.port,
          sendMessage("intercom.send", { to: target.id, message: "hi" }),
        );
        expect(send.parsed.error?.code).toBe(-32102);
        const steer = await postRpc(
          deniedAddress.port,
          sendMessage("session.steer", { job_id: "j", message: "hi" }),
        );
        expect(steer.parsed.error?.code).toBe(-32102);
        // advertised nowhere while the gate is closed
        const card = (await (
          await fetch(
            `http://127.0.0.1:${deniedAddress.port}/.well-known/agent-card.json`,
          )
        ).json()) as { skills: Array<{ id: string }> };
        expect(card.skills.map((skill) => skill.id)).not.toContain(
          "intercom.send",
        );
      } finally {
        await denied.stop();
      }
      // Gate open: accepted, and the result is the broker's own vocabulary.
      const allowed = createAgentServer({
        host: "127.0.0.1",
        port: 0,
        swarmKey: testKey,
        identity: testIdentity,
        sessionsRoot,
        skillRegistry: openRegistry(),
        intercom,
        spawnPolicy: {
          allows: () => true,
          enabled: true,
          source: "cli" as const,
        },
      });
      const allowedAddress = await allowed.start();
      try {
        const { parsed } = await postRpc(
          allowedAddress.port,
          sendMessage("intercom.send", { to: target.id, message: "hi" }),
        );
        expect(parsed.error).toBeUndefined();
        const result = (
          parsed.result as {
            message: { parts: Array<{ data: { result: IntercomSendResult } }> };
          }
        ).message.parts[0]!.data.result;
        expect(result).toMatchObject({
          delivery: "delivered",
          injected: false,
        });
        const card = (await (
          await fetch(
            `http://127.0.0.1:${allowedAddress.port}/.well-known/agent-card.json`,
          )
        ).json()) as { skills: Array<{ id: string }> };
        expect(card.skills.map((skill) => skill.id)).toContain("intercom.send");
        expect(card.skills.map((skill) => skill.id)).toContain("intercom.list");
      } finally {
        await allowed.stop();
      }
    } finally {
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("negative control: a session the mesh did not spawn refuses steer but accepts intercom.send", async () => {
    // The mesh never started this session - it is live only on the broker,
    // like a Pi TUI the operator opened by hand. session.steer must refuse
    // (it steers only mesh jobs); intercom.send reaches it (it messages a
    // live session). That asymmetry is the ADR's negative control.
    const dir = await mkdtemp(join(tmpdir(), "pi-mesh-intercom-"));
    const foreign = liveSession("ffffffff-0000-4000-8000-000000000003");
    const broker = await startFixtureBroker(dir, { sessions: [foreign] });
    try {
      const registry = createSkillRegistry({
        jobs: stubJobs(),
        intercom: {
          available: true,
          socketPath: broker.socketPath,
          receiptWaitMs: 50,
        },
      });
      await expect(
        registry.invoke("session.steer", {
          job_id: "mesh-never-started-this",
          message: "hi",
        }),
      ).rejects.toMatchObject({ code: -32103 });
      const result = (await registry.invoke("intercom.send", {
        to: foreign.id,
        message: "hello from the mesh",
      })) as IntercomSendResult;
      expect(result).toMatchObject({ delivery: "delivered", injected: false });
    } finally {
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skill input is validated before any broker contact", async () => {
    const registry = createSkillRegistry({
      intercom: {
        available: true,
        socketPath: join(tmpdir(), "no-broker.sock"),
      },
    });
    await expect(
      registry.invoke("intercom.send", { to: "", message: "hi" }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      registry.invoke("intercom.send", { to: "x", message: "  " }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      registry.invoke("intercom.send", { to: "x" }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
