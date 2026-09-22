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
  servedSkills,
  signedHeaders,
  sessionStream,
  type SessionStream,
} from "../src/index.js";

const sessionId = "123e4567-e89b-42d3-a456-426614174099";
const testIdentity = {
  peerId: "22222222-2222-4222-8222-222222222222",
  name: "test",
};
const testKey = Buffer.from("pi-mesh-vector-key-0123456789abc");

type HttpResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

function httpCall(port: number, body?: unknown): Promise<HttpResult> {
  if (body !== undefined) {
    return httpCallWith(port, body, { "A2A-Version": "1.0" });
  }
  return new Promise((resolve, reject) => {
    const client = request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/.well-known/agent-card.json",
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
    client.end();
  });
}

async function httpCallWith(
  port: number,
  body: unknown,
  headers: Record<string, string>,
): Promise<HttpResult> {
  const requestHeaders = signedHeaders(testKey, testIdentity, {
    method: "POST",
    path: "/",
    recipientPeerId: testIdentity.peerId,
    body: JSON.stringify(body),
  });
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
          ...requestHeaders,
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

function streamCall(port: number, body: unknown): Promise<HttpResult> {
  const text = JSON.stringify(body);
  const headers = signedHeaders(testKey, testIdentity, {
    method: "POST",
    path: "/",
    recipientPeerId: testIdentity.peerId,
    body: text,
  });
  return new Promise((resolve, reject) => {
    const client = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/",
        headers: {
          "A2A-Version": "1.0",
          "content-type": "application/json",
          connection: "close",
          ...headers,
        },
      },
      (response) => {
        response.once("error", () => undefined);
        response.once("data", (chunk: Buffer) => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: chunk.toString("utf8"),
          });
          client.destroy();
        });
      },
    );
    client.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") {
        reject(error);
      }
    });
    client.end(text);
  });
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
    const server = createAgentServer({
      port: 0,
      sessionsRoot: root,
      swarmKey: testKey,
      identity: testIdentity,
    });
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
    const server = createAgentServer({
      port: 0,
      sessionsRoot: root,
      swarmKey: testKey,
      identity: testIdentity,
    });
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
    const server = createAgentServer({
      port: 0,
      sessionsRoot: root,
      swarmKey: testKey,
      identity: testIdentity,
    });
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
        JSON.parse(result.body).result.message.parts[0].data.result.sessions,
      ).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("advertises and serves only the read-only M1 skills", async () => {
    const root = await fixtureRoot();
    const server = createAgentServer({
      port: 0,
      sessionsRoot: root,
      swarmKey: testKey,
      identity: testIdentity,
    });
    const address = await server.start();
    try {
      const card = JSON.parse((await httpCall(address.port)).body) as {
        skills: { id: string }[];
      };
      const advertised = card.skills.map((skill) => skill.id).sort();
      expect(advertised).toEqual([...servedSkills()].sort());

      for (const skill of advertised) {
        if (skill === "session.stream") {
          const response = await streamCall(address.port, {
            ...call(skill, { id: sessionId }),
            method: "message/stream",
          });
          expect(response.status).toBe(200);
          expect(response.body).toContain('"task"');
          continue;
        }
        const input =
          skill === "session.read"
            ? { id: sessionId }
            : skill === "process.stop" || skill === "session.abort"
              ? { job_id: "missing" }
              : {};
        const response = await httpCallWith(address.port, call(skill, input), {
          "A2A-Version": "1.0",
        });
        if (skill === "process.stop" || skill === "session.abort") {
          expect(JSON.parse(response.body).error.code).toBe(-32004);
        } else {
          expect(JSON.parse(response.body).error).toBeUndefined();
        }
      }

      // Both gated skills answer -32102 on a machine that has not opted in.
      // The gate can only say "execution is disabled here" for a skill it can
      // SEE, so both must be REGISTERED for the answer to be about policy
      // rather than about implementation - and only a genuinely unimplemented
      // skill reports -32004. The two codes mean different things to a peer
      // routing on them (ADR 0008): -32102 says "this machine does it, but not
      // for you"; -32004 says "this machine does not do it at all". This test
      // previously encoded the opposite for process.spawn
      // (`skill === "session.steer" ? -32102 : -32004`), which blessed an
      // inconsistency rather than catching it: measured on real hardware,
      // process.spawn answered -32004 while session.steer answered -32102, on
      // the same machine at the same moment.
      for (const skill of ["process.spawn", "session.steer", "mesh.handoff"]) {
        const response = await httpCallWith(address.port, call(skill), {
          "A2A-Version": "1.0",
        });
        expect(JSON.parse(response.body).error.code).toBe(
          skill === "mesh.handoff" ? -32004 : -32102,
        );
      }
    } finally {
      await server.stop();
    }
  });

  it("returns standard parse, method, and A2A task errors", async () => {
    const server = createAgentServer({
      port: 0,
      swarmKey: testKey,
      identity: testIdentity,
    });
    const address = await server.start();
    try {
      const malformedHeaders = signedHeaders(testKey, testIdentity, {
        method: "POST",
        path: "/",
        recipientPeerId: testIdentity.peerId,
        body: "{",
      });
      const malformed = await new Promise<HttpResult>((resolve, reject) => {
        const client = request(
          {
            host: "127.0.0.1",
            port: address.port,
            method: "POST",
            path: "/",
            headers: {
              "A2A-Version": "1.0",
              connection: "close",
              ...malformedHeaders,
            },
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
      swarmKey: testKey,
      identity: testIdentity,
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
      const streamBody = JSON.stringify({
        ...call("session.stream", { id: sessionId }),
        method: "message/stream",
      });
      const streamHeaders = signedHeaders(testKey, testIdentity, {
        method: "POST",
        path: "/",
        recipientPeerId: testIdentity.peerId,
        body: streamBody,
      });
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
              ...streamHeaders,
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
        client.end(streamBody);
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

  it("still stops while a peer holds a stream open", async () => {
    // The sibling test above aborts the client, which is exactly what hid this:
    // server.close() only stops accepting and then WAITS for existing sockets, so
    // a peer that simply holds an SSE stream open blocked stop() forever and a
    // running agent could not be shut down at all. This stream is deliberately
    // never aborted.
    const root = await fixtureRoot();
    const server = createAgentServer({
      port: 0,
      sessionsRoot: root,
      swarmKey: testKey,
      identity: testIdentity,
    });
    const address = await server.start();
    const streamBody = JSON.stringify({
      ...call("session.stream", { id: sessionId }),
      method: "message/stream",
    });
    const client = request({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: "/",
      headers: {
        "A2A-Version": "1.0",
        "content-type": "application/json",
        connection: "close",
        ...signedHeaders(testKey, testIdentity, {
          method: "POST",
          path: "/",
          recipientPeerId: testIdentity.peerId,
          body: streamBody,
        }),
      },
    });
    await new Promise<void>((resolve, reject) => {
      client.on("response", (response) =>
        response.once("data", () => resolve()),
      );
      client.on("error", reject);
      client.end(streamBody);
    });

    // The stream is open and un-aborted, so this is the shutdown that used to hang.
    const outcome = await Promise.race([
      server.stop().then(() => "stopped"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("hung"), 3_000).unref(),
      ),
    ]);
    client.destroy();
    expect(outcome).toBe("stopped");
  });
});
