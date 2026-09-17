// SPDX-License-Identifier: GPL-3.0-or-later

import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { A2A_FIELDS } from "@pi-mesh/protocol";
import {
  createAgentServer,
  getSessionStorageDir,
  sessionStream,
  type SessionStream,
} from "../src/index.js";

const sessionId = "123e4567-e89b-42d3-a456-426614174099";

type HttpResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

function httpCall(port: number, body?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const client = request(
      {
        host: "127.0.0.1",
        port,
        method: body === undefined ? "GET" : "POST",
        path: body === undefined ? "/.well-known/agent-card.json" : "/",
        headers:
          body === undefined
            ? {}
            : {
                "A2A-Version": "1.0",
                "content-type": "application/json",
                connection: "close",
              },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: text,
          }),
        );
      },
    );
    client.on("error", reject);
    if (body === undefined) client.end();
    else client.end(JSON.stringify(body));
  });
}

async function httpCallWith(
  port: number,
  body: unknown,
  headers: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const client = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/",
        headers: {
          "content-type": "application/json",
          connection: "close",
          ...headers,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: text,
          }),
        );
      },
    );
    client.on("error", reject);
    client.end(JSON.stringify(body));
  });
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-mesh-server-"));
  const directory = getSessionStorageDir("/fixture/project", root);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "session.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2024-01-01T00:00:00Z", cwd: "/fixture/project" })}\n${JSON.stringify({ type: "message", id: "entry-1", parentId: null, timestamp: "2024-01-01T00:00:01Z", message: { role: "user", content: "hello" } })}\n`,
  );
  return root;
}

function call(
  skill: string,
  input: Record<string, unknown> = {},
): Record<string, unknown> {
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

describe("A2A HTTP server", () => {
  it("rejects a missing or unsupported A2A-Version with VersionNotSupportedError", async () => {
    // The spec is explicit: "If the version is not supported by the interface,
    // agents MUST return a VersionNotSupportedError", which is -32009. This
    // previously returned the generic -32600, telling a peer its request was
    // malformed when the request was fine and only the version was not. A peer
    // routes on the code, so that is not a cosmetic difference.
    const root = await fixtureRoot();
    const server = createAgentServer({ port: 0, sessionsRoot: root });
    const address = await server.start();
    try {
      for (const version of [undefined, "0.3", "2.0"]) {
        const response = await httpCallWith(
          address.port,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tasks/get",
            params: { id: "x" },
          },
          version === undefined ? {} : { "A2A-Version": version },
        );
        const error = JSON.parse(response.body).error;
        expect(error.code, `A2A-Version: ${version}`).toBe(-32009);
        expect(error.data.details[0].reason).toBe("VERSION_NOT_SUPPORTED");
      }
    } finally {
      await server.stop();
    }
  });

  it("reports an unknown task as A2A's own error, not a pi-mesh code", async () => {
    // ADR 0005's separation, asserted on the wire: -32001 is A2A's
    // TaskNotFoundError, and pi-mesh's codes start at -32100. If the two ranges
    // ever overlapped again, a peer would read a missing task as an
    // authentication failure - silently, since both sides trust the number.
    const root = await fixtureRoot();
    const server = createAgentServer({ port: 0, sessionsRoot: root });
    const address = await server.start();
    try {
      const response = await httpCall(address.port, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/get",
        params: { id: "00000000-0000-4000-8000-000000000000" },
      });
      const error = JSON.parse(response.body).error;
      expect(error.code).toBe(-32001);
      expect(error.code).toBeGreaterThan(-32100);
      expect(error.data.details[0].reason).toBe("TASK_NOT_FOUND");
      expect(error.data.details[0].domain).toBe("a2a-protocol.org");
    } finally {
      await server.stop();
    }
  });

  it("serves the card and a real session.list result", async () => {
    const root = await fixtureRoot();
    const server = createAgentServer({ port: 0, sessionsRoot: root });
    const address = await server.start();
    try {
      const card = await httpCall(address.port);
      expect(card.status).toBe(200);
      const cardValue = JSON.parse(card.body);
      expect(Object.keys(cardValue).sort()).toEqual(
        [...A2A_FIELDS.AgentCard].sort(),
      );
      expect(cardValue.capabilities.streaming).toBe(true);
      expect(card.headers["a2a-version"]).toBe("1.0");

      const result = await httpCall(address.port, call("session.list"));
      expect(
        JSON.parse(result.body).result.parts[0].data.result.sessions,
      ).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("returns standard parse, method, and A2A task errors", async () => {
    const server = createAgentServer({ port: 0 });
    const address = await server.start();
    try {
      const malformed = await new Promise<HttpResult>((resolve, reject) => {
        const client = request(
          {
            host: "127.0.0.1",
            port: address.port,
            method: "POST",
            path: "/",
            headers: { "A2A-Version": "1.0", connection: "close" },
          },
          (response) => {
            let body = "";
            response.on("data", (chunk: Buffer) => (body += chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body,
              }),
            );
          },
        );
        client.on("error", reject);
        client.end("{");
      });
      expect(JSON.parse(malformed.body).error.code).toBe(-32700);
      expect(
        JSON.parse(
          (
            await httpCall(address.port, {
              jsonrpc: "2.0",
              id: 1,
              method: "unknown",
              params: {},
            })
          ).body,
        ).error.code,
      ).toBe(-32601);
      const missingTask = JSON.parse(
        (
          await httpCall(address.port, {
            jsonrpc: "2.0",
            id: 1,
            method: "tasks/get",
            params: { id: "missing" },
          })
        ).body,
      );
      expect(missingTask.error.code).toBe(-32001);

      const piError = JSON.parse(
        (await httpCall(address.port, call("session.read", { id: sessionId })))
          .body,
      );
      expect(piError.error.code).toBe(-32101);
      expect(piError.error.data.details[0].reason).toBe(
        "PI_MESH_UNKNOWN_SESSION",
      );
    } finally {
      await server.stop();
    }
  });

  it("stops the real session stream when the HTTP client aborts", async () => {
    const root = await fixtureRoot();
    let stoppedResolve: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => (stoppedResolve = resolve));
    const server = createAgentServer({
      port: 0,
      sessionsRoot: root,
      stream: (request, options): SessionStream => {
        const stream = sessionStream(request, options);
        const stop = stream.stop.bind(stream);
        stream.stop = async (): Promise<void> => {
          await stop();
          stoppedResolve?.();
        };
        return stream;
      },
    });
    const address = await server.start();
    try {
      await new Promise<void>((resolve, reject) => {
        const client = request(
          {
            host: "127.0.0.1",
            port: address.port,
            method: "POST",
            path: "/",
            headers: {
              "A2A-Version": "1.0",
              "content-type": "application/json",
              connection: "close",
            },
          },
          (response) => {
            response.once("data", () => {
              client.destroy();
              resolve();
            });
          },
        );
        client.on("error", (error) =>
          error.message === "socket hang up" ? resolve() : reject(error),
        );
        client.end(
          JSON.stringify({
            ...call("session.stream", { id: sessionId }),
            method: "message/stream",
          }),
        );
      });
      await stopped;
    } finally {
      await server.stop();
      // Keep appendFile in this real-file test: it verifies the fixture is a
      // normal writable session file, not an in-memory stream substitute.
      await appendFile(
        join(getSessionStorageDir("/fixture/project", root), "session.jsonl"),
        "",
      );
    }
  });
});
