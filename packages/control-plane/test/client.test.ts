// SPDX-License-Identifier: GPL-3.0-or-later

import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { PI_MESH_HEADERS, verifyRequestSignature } from "@pi-mesh/protocol";
import {
  AgentSkillError,
  AgentUnreachableError,
  fetchAgentCard,
  fetchSessionList,
  type AgentTarget,
} from "../src/client.js";

const controlId = "control-id";
const agentId = "agent-id";
const credential = Buffer.alloc(32, 7).toString("base64");
const sessions = [
  {
    id: "session-1",
    project: "/work",
    started_at: "start",
    updated_at: "update",
  },
];

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
    server.close();
    await once(server, "close");
  }
}

describe("control-plane A2A client", () => {
  it("fetches skill ids from the public agent card", async () => {
    await withServer(
      (_request, _body, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            name: "test agent",
            skills: [{ id: "session.list" }, { id: "process.spawn" }],
          }),
        );
      },
      async (target) => {
        await expect(fetchAgentCard(target, { controlId })).resolves.toEqual({
          name: "test agent",
          skills: ["session.list", "process.spawn"],
        });
      },
    );
  });

  it("returns undefined for non-200 and malformed agent cards", async () => {
    await withServer(
      (_request, _body, response) => {
        response.statusCode = 503;
        response.end("offline");
      },
      async (target) =>
        await expect(
          fetchAgentCard(target, { controlId }),
        ).resolves.toBeUndefined(),
    );
    await withServer(
      (_request, _body, response) => response.end('{"skills":[{}]}'),
      async (target) =>
        await expect(
          fetchAgentCard(target, { controlId }),
        ).resolves.toBeUndefined(),
    );
  });
  it("signs the A2A request and returns the session list", async () => {
    await withServer(
      (request, body, response) => {
        const fields = {
          method: "POST",
          path: "/",
          body,
          peerId: request.headers[PI_MESH_HEADERS.peer.toLowerCase()] as string,
          recipientPeerId: agentId,
          nonce: request.headers[PI_MESH_HEADERS.nonce.toLowerCase()] as string,
          timestamp: request.headers[
            PI_MESH_HEADERS.timestamp.toLowerCase()
          ] as string,
        };
        expect(request.headers["a2a-version"]).toBe("1.0");
        const nonce = request.headers[
          PI_MESH_HEADERS.nonce.toLowerCase()
        ] as string;
        expect(Buffer.from(nonce, "base64").toString("base64")).toBe(nonce);
        expect(Buffer.from(nonce, "base64")).toHaveLength(32);
        expect(
          verifyRequestSignature(
            Buffer.from(credential, "base64"),
            fields,
            request.headers[PI_MESH_HEADERS.signature.toLowerCase()],
          ),
        ).toBe(true);
        expect(JSON.parse(body)).toMatchObject({
          method: "message/send",
          params: {
            message: {
              role: "ROLE_USER",
              parts: [{ data: { skill: "session.list", input: {} } }],
            },
          },
        });
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: JSON.parse(body).id,
            result: {
              message: { parts: [{ data: { result: { sessions } } }] },
            },
          }),
        );
      },
      async (target) =>
        expect(await fetchSessionList(target, { controlId })).toEqual(sessions),
    );
  });

  it("rejects a wrong credential when the request verifier answers -32100", async () => {
    await withServer(
      (request, body, response) => {
        const fields = {
          method: "POST",
          path: "/",
          body,
          peerId: request.headers[PI_MESH_HEADERS.peer.toLowerCase()] as string,
          recipientPeerId: agentId,
          nonce: request.headers[PI_MESH_HEADERS.nonce.toLowerCase()] as string,
          timestamp: request.headers[
            PI_MESH_HEADERS.timestamp.toLowerCase()
          ] as string,
        };
        const valid = verifyRequestSignature(
          // The real key, so this verifier ACCEPTS a correctly signed request.
          // Verifying against a key the client never holds would reject even an
          // unsigned request, and the test could not tell whether the client
          // signed with the credential it was given.
          Buffer.from(credential, "base64"),
          fields,
          request.headers[PI_MESH_HEADERS.signature.toLowerCase()],
        );
        response.end(
          JSON.stringify(
            valid
              ? { jsonrpc: "2.0", id: JSON.parse(body).id, result: {} }
              : {
                  jsonrpc: "2.0",
                  id: JSON.parse(body).id,
                  error: { code: -32100, message: "Unauthorized" },
                },
          ),
        );
      },
      async (target) => {
        const wrong = {
          ...target,
          credential: Buffer.alloc(32, 9).toString("base64"),
        };
        await expect(
          fetchSessionList(wrong, { controlId }),
        ).rejects.toMatchObject({
          name: "AgentSkillError",
          code: -32100,
          message: "Unauthorized",
        });
      },
    );
  });

  it("throws on non-200 HTTP responses", async () => {
    await withServer(
      (_request, _body, response) => {
        response.statusCode = 503;
        response.end("offline");
      },
      async (target) => {
        const result = fetchSessionList(target, { controlId });
        await expect(result).rejects.toBeInstanceOf(AgentUnreachableError);
        await expect(result).rejects.not.toBeInstanceOf(AgentSkillError);
      },
    );
  });

  it("classifies network failures as unreachable rather than skill refusals", async () => {
    const result = fetchSessionList(
      { peerId: agentId, host: "127.0.0.1", port: 1, credential },
      {
        controlId,
        fetch: async () => {
          throw new Error("connection refused");
        },
      },
    );
    await expect(result).rejects.toBeInstanceOf(AgentUnreachableError);
    await expect(result).rejects.not.toBeInstanceOf(AgentSkillError);
  });

  it("classifies malformed JSON-RPC envelopes as unreachable", async () => {
    await withServer(
      (_request, body, response) => {
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id }),
        );
      },
      async (target) => {
        const result = fetchSessionList(target, { controlId });
        await expect(result).rejects.toBeInstanceOf(AgentUnreachableError);
        await expect(result).rejects.not.toBeInstanceOf(AgentSkillError);
      },
    );
  });

  it("preserves an agent JSON-RPC refusal code", async () => {
    await withServer(
      (_request, body, response) => {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: JSON.parse(body).id,
            error: { code: -32102, message: "Execution disabled" },
          }),
        );
      },
      async (target) => {
        await expect(
          fetchSessionList(target, { controlId }),
        ).rejects.toMatchObject({
          name: "AgentSkillError",
          code: -32102,
          message: "Execution disabled",
        });
      },
    );
  });
});
