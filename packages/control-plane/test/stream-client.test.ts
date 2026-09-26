// SPDX-License-Identifier: GPL-3.0-or-later

import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { PI_MESH_HEADERS, verifyRequestSignature } from "@pi-mesh/protocol";
import {
  AgentSkillError,
  AgentUnreachableError,
  streamAgent,
  type AgentStreamFrame,
  type AgentTarget,
} from "../src/client.js";

const controlId = "control-id";
const agentId = "agent-id";
const credential = Buffer.alloc(32, 7).toString("base64");

function taskFrame(): string {
  return `data: ${JSON.stringify({ task: { id: "task-1" } })}\n\n`;
}

function messageFrame(result: unknown): string {
  return `data: ${JSON.stringify({
    message: {
      messageId: "agent-message",
      role: "ROLE_AGENT",
      parts: [{ data: { result } }],
    },
  })}\n\n`;
}

function liveDelta(delta: string): string {
  return messageFrame({
    type: "message_update",
    source: "live",
    assistantMessageEvent: { type: "text_delta", delta },
  });
}

async function withServer(
  handler: (
    request: import("node:http").IncomingMessage,
    body: string,
    response: import("node:http").ServerResponse,
  ) => void,
  run: (target: AgentTarget) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => handler(request, body, response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run({
      peerId: agentId,
      host: "127.0.0.1",
      port: (server.address() as import("node:net").AddressInfo).port,
      credential,
    });
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

function signedRequest(
  request: import("node:http").IncomingMessage,
  body: string,
): boolean {
  return verifyRequestSignature(
    Buffer.from(credential, "base64"),
    {
      method: "POST",
      path: "/",
      body,
      peerId: request.headers[PI_MESH_HEADERS.peer.toLowerCase()] as string,
      recipientPeerId: agentId,
      nonce: request.headers[PI_MESH_HEADERS.nonce.toLowerCase()] as string,
      timestamp: request.headers[
        PI_MESH_HEADERS.timestamp.toLowerCase()
      ] as string,
    },
    request.headers[PI_MESH_HEADERS.signature.toLowerCase()],
  );
}

function frameValue(
  frame: AgentStreamFrame | undefined,
): Record<string, unknown> {
  if (frame === undefined || frame.kind !== "message")
    throw new Error(`Expected a message frame, got ${JSON.stringify(frame)}`);
  return frame.value as Record<string, unknown>;
}

describe("control-plane streaming client", () => {
  it("yields live frames incrementally, signed, keeping the source discriminator", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signatureValid = false;
    let method: unknown;
    await withServer(
      (request, body, response) => {
        signatureValid = signedRequest(request, body);
        method = (JSON.parse(body) as { method?: unknown }).method;
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
        });
        response.write(taskFrame());
        response.write(liveDelta("first"));
        void gate.then(() => {
          response.write(liveDelta("second"));
          response.end();
        });
      },
      async (target) => {
        const iterator = streamAgent(
          target,
          "session.stream",
          { id: "session-1" },
          { controlId },
        );
        try {
          const task = await iterator.next();
          expect(
            task.value,
            "the leading task frame is yielded too",
          ).toMatchObject({ kind: "task" });
          // The first live frame must arrive BEFORE the server is released to
          // write the second: a client that buffered the whole response would
          // never resolve this, which is the incremental-delivery clause.
          const first = await iterator.next();
          expect(
            frameValue(first.value)["assistantMessageEvent"],
            "missing observation: a live delta before the upstream closed",
          ).toMatchObject({ delta: "first" });
          expect(frameValue(first.value)["source"]).toBe("live");
          release();
          const second = await iterator.next();
          expect(
            frameValue(second.value)["assistantMessageEvent"],
            "missing observation: a second live delta",
          ).toMatchObject({ delta: "second" });
          const done = await iterator.next();
          expect(done.done, "a clean response.end() ends the generator").toBe(
            true,
          );
        } finally {
          release();
          await iterator.return?.(undefined);
        }
      },
    );
    expect(
      signatureValid,
      "missing observation: the paired credential signed the stream request",
    ).toBe(true);
    expect(method).toBe("message/stream");
  });

  it("reports a pre-stream skill refusal as AgentSkillError, not an empty stream", async () => {
    await withServer(
      (_request, body, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: (JSON.parse(body) as { id: string }).id,
            error: {
              code: -32004,
              message: "Streaming is only supported by session.stream",
            },
          }),
        );
      },
      async (target) => {
        const iterator = streamAgent(
          target,
          "session.steer",
          {},
          { controlId },
        );
        await expect(iterator.next()).rejects.toMatchObject({
          name: "AgentSkillError",
          code: -32004,
        });
      },
    );
  });

  it("reports the execution-gate refusal code unchanged", async () => {
    await withServer(
      (_request, body, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: (JSON.parse(body) as { id: string }).id,
            error: { code: -32102, message: "Execution is not enabled" },
          }),
        );
      },
      async (target) => {
        const iterator = streamAgent(
          target,
          "session.stream",
          { id: "s" },
          { controlId },
        );
        await expect(iterator.next()).rejects.toBeInstanceOf(AgentSkillError);
        await expect(
          streamAgent(
            target,
            "session.stream",
            { id: "s" },
            { controlId },
          ).next(),
        ).rejects.toMatchObject({ code: -32102 });
      },
    );
  });

  it("throws AgentUnreachableError for a non-200 response", async () => {
    await withServer(
      (_request, _body, response) => {
        response.statusCode = 503;
        response.end("offline");
      },
      async (target) => {
        await expect(
          streamAgent(
            target,
            "session.stream",
            { id: "s" },
            { controlId },
          ).next(),
        ).rejects.toBeInstanceOf(AgentUnreachableError);
      },
    );
  });

  it("treats a clean stream with no frames as an error, not a finished turn", async () => {
    await withServer(
      (_request, _body, response) => {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
        });
        response.end();
      },
      async (target) => {
        await expect(
          streamAgent(
            target,
            "session.stream",
            { id: "s" },
            { controlId },
          ).next(),
        ).rejects.toBeInstanceOf(AgentUnreachableError);
      },
    );
  });

  it("surfaces a transport drop mid-stream instead of a clean end", async () => {
    await withServer(
      (_request, _body, response) => {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
        });
        response.write(taskFrame());
        response.write(liveDelta("before-drop"));
        // Destroy without the terminating chunk: a client that treated the
        // close as a finished turn would silently lose the rest of the turn.
        setTimeout(() => response.socket?.destroy(), 20);
      },
      async (target) => {
        const iterator = streamAgent(
          target,
          "session.stream",
          { id: "s" },
          { controlId },
        );
        const seen: AgentStreamFrame[] = [];
        let failure: unknown;
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            seen.push(next.value);
          }
        } catch (error) {
          failure = error;
        }
        expect(
          seen.some((frame) => frame.kind === "message"),
          "the pre-drop frame must still be delivered",
        ).toBe(true);
        expect(
          failure,
          "missing observation: a dropped connection is not a finished turn",
        ).toBeInstanceOf(AgentUnreachableError);
      },
    );
  });

  it("ends quietly when the caller aborts, not as an error", async () => {
    await withServer(
      (_request, _body, response) => {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
        });
        response.write(taskFrame());
        // Never ends on its own; the abort is what closes it.
      },
      async (target) => {
        const controller = new AbortController();
        const iterator = streamAgent(
          target,
          "session.stream",
          { id: "s" },
          { controlId },
          controller.signal,
        );
        await iterator.next();
        controller.abort();
        const done = await iterator.next();
        expect(done.done).toBe(true);
      },
    );
  });
});
