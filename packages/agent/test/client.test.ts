// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeHandshakeHmac, encodeTranscript } from "@pi-mesh/protocol";
import { describe, expect, it } from "vitest";
import { ErrorCode, PiMeshError } from "@pi-mesh/shared";
import {
  createAgentServer,
  getSessionStorageDir,
  handshake,
  call,
  sendSkill,
  streamSkill,
  PeerRegistry,
  ClientProtocolError,
  PeerIdentityMismatchError,
  PeerUnreachableError,
  type PeerRecord,
} from "../src/index.js";

const key = Buffer.from("pi-mesh-vector-key-0123456789abc");
const wrongKey = Buffer.from("wrong-pi-mesh-key-0123456789");
const serverIdentity = {
  peerId: "11111111-1111-4111-8111-111111111111",
  name: "server",
};
const clientIdentity = {
  peerId: "22222222-2222-4222-8222-222222222222",
  name: "client",
};

function peer(port: number, id = serverIdentity.peerId): PeerRecord {
  return {
    id,
    name: "server",
    serviceType: "mesh",
    host: "127.0.0.1",
    port,
    txt: {},
    lastSeen: Date.now(),
  };
}

function options(swarmKey = key) {
  return { swarmKey, identity: clientIdentity, timeoutMs: 100 };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not expose a port"));
      } else {
        resolve(address.port);
      }
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

describe("A2A client", () => {
  it("reports an unreachable peer as transport failure, not an RPC error", async () => {
    const closed = createServer();
    const port = await listen(closed);
    await close(closed);
    const request = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tasks/get",
      params: { id: "missing" },
    };
    await expect(call(peer(port), request, options())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(PeerUnreachableError);
        expect(error).not.toBeInstanceOf(PiMeshError);
        expect(error).not.toHaveProperty("code");
        return true;
      },
    );
  });

  it("reports a peer that never responds as a transport timeout", async () => {
    const server = createServer();
    const port = await listen(server);
    try {
      await expect(
        call(
          peer(port),
          { jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x" } },
          options(),
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(PeerUnreachableError);
        expect(error).not.toBeInstanceOf(PiMeshError);
        expect(error).not.toHaveProperty("code");
        return true;
      });
    } finally {
      await close(server);
    }
  });

  it("handshakes with a live peer and returns its real mesh and session data", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mesh-client-"));
    const directory = getSessionStorageDir("/agent-b/project", root);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "session.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "123e4567-e89b-42d3-a456-426614174099", timestamp: "2024-01-01T00:00:00Z", cwd: "/agent-b/project" })}\n`,
    );
    const registry = new PeerRegistry();
    registry.add({
      id: clientIdentity.peerId,
      name: clientIdentity.name,
      serviceType: "mesh",
      host: "agent-a.local",
      port: 7330,
      txt: { id: clientIdentity.peerId },
    });
    const server = createAgentServer({
      port: 0,
      swarmKey: key,
      identity: serverIdentity,
      sessionsRoot: root,
      registry,
    });
    const address = await server.start();
    try {
      const remote = peer(address.port);
      await expect(handshake(remote, options())).resolves.toBe(remote.id);
      await expect(
        sendSkill(remote, "mesh.peers", {}, options()),
      ).resolves.toEqual({
        peers: [
          expect.objectContaining({
            id: clientIdentity.peerId,
            host: "agent-a.local",
          }),
        ],
      });
      await expect(
        sendSkill(remote, "session.list", {}, options()),
      ).resolves.toEqual({
        sessions: [
          expect.objectContaining({
            id: "123e4567-e89b-42d3-a456-426614174099",
            project: "/agent-b/project",
          }),
        ],
      });
    } finally {
      await server.stop();
    }
  });

  it("separates an unimplemented skill from a skill this machine will not run", async () => {
    const server = createAgentServer({
      port: 0,
      swarmKey: key,
      identity: serverIdentity,
      sessionsRoot: "/path-that-does-not-exist",
    });
    const address = await server.start();
    try {
      // A denied spawn and an unimplemented skill are different answers, and a
      // peer routes on the code. Asserting one code for both would pass even if
      // the gate never fired.
      for (const [skill, code] of [
        ["not.implemented", -32004],
        ["process.spawn", -32102],
        ["session.steer", -32102],
        ["mesh.handoff", -32102],
      ] as const) {
        await expect(
          sendSkill(peer(address.port), skill, {}, options()),
        ).rejects.toSatisfy((error: unknown) => {
          expect(error).toBeInstanceOf(PiMeshError);
          expect(error).toHaveProperty("code", code);
          return true;
        });
      }
    } finally {
      await server.stop();
    }
  });

  it("surfaces rejected authentication as Unauthorized, not an empty result", async () => {
    const server = createAgentServer({
      port: 0,
      swarmKey: key,
      identity: serverIdentity,
    });
    const address = await server.start();
    try {
      const request = {
        jsonrpc: "2.0" as const,
        id: 1,
        method: "tasks/get",
        params: { id: "missing" },
      };
      await expect(
        call(peer(address.port), request, options(wrongKey)),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(PiMeshError);
        expect(error).not.toBeInstanceOf(PeerUnreachableError);
        expect(error).toHaveProperty("code", ErrorCode.Unauthorized);
        return true;
      });
    } finally {
      await server.stop();
    }
  });

  it("refuses a live server whose identity differs from discovery", async () => {
    const server = createAgentServer({
      port: 0,
      swarmKey: key,
      identity: serverIdentity,
    });
    const address = await server.start();
    try {
      await expect(
        handshake(
          peer(address.port, "33333333-3333-4333-8333-333333333333"),
          options(),
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(PeerIdentityMismatchError);
        expect(error).toHaveProperty(
          "advertisedPeerId",
          "33333333-3333-4333-8333-333333333333",
        );
        expect(error).toHaveProperty("claimedPeerId", serverIdentity.peerId);
        return true;
      });
    } finally {
      await server.stop();
    }
  });

  it("rejects a server whose challenge HMAC does not verify", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/handshake") {
        response.end(
          JSON.stringify({
            peer_id: serverIdentity.peerId,
            nonce: "server-nonce",
            hmac: Buffer.alloc(32).toString("base64"),
          }),
        );
      } else {
        response.end(JSON.stringify({ ok: true }));
      }
    });
    const port = await listen(server);
    try {
      await expect(handshake(peer(port), options())).rejects.toMatchObject({
        code: ErrorCode.Unauthorized,
      });
    } finally {
      await close(server);
    }
  });

  it("parses chunk-split SSE streamSkill responses", async () => {
    const server = createServer(async (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) body += chunk;
      if (request.url === "/handshake") {
        const hello = JSON.parse(body) as { peer_id: string; nonce: string };
        const nonce = "server-nonce";
        const transcript = encodeTranscript({
          clientPeerId: hello.peer_id,
          clientNonce: hello.nonce,
          serverPeerId: serverIdentity.peerId,
          serverNonce: nonce,
        });
        response.end(
          JSON.stringify({
            peer_id: serverIdentity.peerId,
            nonce,
            hmac: computeHandshakeHmac(key, transcript),
          }),
        );
        return;
      }
      if (request.url === "/handshake/verify") {
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"value":');
      response.write('"split"}\n');
      response.end("\n");
    });
    const port = await listen(server);
    try {
      await expect(
        (async () => {
          const values: unknown[] = [];
          for await (const value of streamSkill(
            peer(port),
            "session.stream",
            {},
            options(),
          )) {
            values.push(value);
          }
          return values;
        })(),
      ).resolves.toEqual([{ value: "split" }]);
    } finally {
      await close(server);
    }
  });

  it("caps a non-SSE stream fallback body", async () => {
    const server = createServer(async (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) body += chunk;
      if (request.url === "/handshake") {
        const hello = JSON.parse(body) as { peer_id: string; nonce: string };
        const nonce = "server-nonce";
        const transcript = encodeTranscript({
          clientPeerId: hello.peer_id,
          clientNonce: hello.nonce,
          serverPeerId: serverIdentity.peerId,
          serverNonce: nonce,
        });
        response.end(
          JSON.stringify({
            peer_id: serverIdentity.peerId,
            nonce,
            hmac: computeHandshakeHmac(key, transcript),
          }),
        );
        return;
      }
      if (request.url === "/handshake/verify") {
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(1024 * 1024, 65);
      for (let count = 0; count < 11; count += 1) response.write(chunk);
      response.end();
    });
    const port = await listen(server);
    try {
      await expect(
        (async () => {
          for await (const value of streamSkill(
            peer(port),
            "session.stream",
            {},
            options(),
          )) {
            // The body is deliberately not SSE.
            void value;
          }
        })(),
      ).rejects.toMatchObject({
        name: "ClientProtocolError",
        message: "Peer response body is too large",
      });
    } finally {
      await close(server);
    }
  });

  it("rejects message/stream because the client cannot read SSE", async () => {
    await expect(
      call(
        peer(1),
        { jsonrpc: "2.0", id: 1, method: "message/stream", params: {} },
        options(),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ClientProtocolError);
      expect(error).toHaveProperty("message", expect.stringContaining("SSE"));
      expect(error).not.toBeInstanceOf(PeerUnreachableError);
      return true;
    });
  });

  it("maps an HTTP 401 before parsing an invalid response body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("not json");
    });
    const port = await listen(server);
    try {
      await expect(
        call(
          peer(port),
          { jsonrpc: "2.0", id: 1, method: "tasks/get", params: {} },
          options(),
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(PiMeshError);
        expect(error).toHaveProperty("code", ErrorCode.Unauthorized);
        expect(error).not.toBeInstanceOf(ClientProtocolError);
        return true;
      });
    } finally {
      await close(server);
    }
  });

  it("classifies malformed JSON-RPC responses and accepts a null result", async () => {
    const responses = [
      "not json",
      "{}",
      JSON.stringify({ jsonrpc: "2.0", id: 999, result: true }),
      JSON.stringify({ jsonrpc: "2.0", id: 1 }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }),
    ];
    let index = 0;
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(responses[index++] ?? "");
    });
    const port = await listen(server);
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await expect(
          call(
            peer(port),
            { jsonrpc: "2.0", id: 1, method: "tasks/get", params: {} },
            options(),
          ),
        ).rejects.toSatisfy((error: unknown) => {
          expect(error).toBeInstanceOf(ClientProtocolError);
          expect(error).toHaveProperty("status", 200);
          return true;
        });
      }
      await expect(
        call(
          peer(port),
          { jsonrpc: "2.0", id: 1, method: "tasks/get", params: {} },
          options(),
        ),
      ).resolves.toBeNull();
    } finally {
      await close(server);
    }
  });

  it("unwraps SendMessageResponse and rejects a bare message", async () => {
    let responseNumber = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        const message = {
          messageId: "message-1",
          role: "ROLE_AGENT",
          parts: [{ data: { result: { ok: true } } }],
        };
        const result =
          responseNumber++ === 0
            ? message
            : responseNumber === 2
              ? { message }
              : {
                  task: {
                    id: "task-1",
                    status: { state: "TASK_STATE_WORKING" },
                  },
                };
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: (JSON.parse(body) as { id: string }).id,
            result,
          }),
        );
      });
    });
    const port = await listen(server);
    try {
      await expect(
        sendSkill(peer(port), "session.list", {}, options()),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(ClientProtocolError);
        expect(error).toHaveProperty(
          "message",
          expect.stringContaining("bare"),
        );
        return true;
      });
      await expect(
        sendSkill(peer(port), "session.list", {}, options()),
      ).resolves.toEqual({ ok: true });
      await expect(
        sendSkill(peer(port), "session.list", {}, options()),
      ).resolves.toEqual({
        id: "task-1",
        status: { state: "TASK_STATE_WORKING" },
      });
    } finally {
      await close(server);
    }
  });

  it("reports a retryable handshake overload as a protocol error with status", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "too_many_pending_handshakes" }));
    });
    const port = await listen(server);
    try {
      await expect(handshake(peer(port), options())).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(ClientProtocolError);
          expect(error).toHaveProperty("status", 503);
          expect(error).toHaveProperty(
            "message",
            "too_many_pending_handshakes",
          );
          expect(error).not.toBeInstanceOf(PiMeshError);
          return true;
        },
      );
    } finally {
      await close(server);
    }
  });

  it("maps an invalid-body 401 from both handshake routes to Unauthorized", async () => {
    const helloServer = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("not json");
    });
    const helloPort = await listen(helloServer);
    try {
      await expect(handshake(peer(helloPort), options())).rejects.toMatchObject(
        {
          code: ErrorCode.Unauthorized,
        },
      );
    } finally {
      await close(helloServer);
    }

    const verifyServer = createServer((request, response) => {
      if (request.url === "/handshake") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const hello = JSON.parse(body) as { peer_id: string; nonce: string };
          const serverNonce = "server-nonce";
          const transcript = encodeTranscript({
            clientPeerId: hello.peer_id,
            clientNonce: hello.nonce,
            serverPeerId: serverIdentity.peerId,
            serverNonce,
          });
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              peer_id: serverIdentity.peerId,
              nonce: serverNonce,
              hmac: computeHandshakeHmac(key, transcript),
            }),
          );
        });
        return;
      }
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("not json");
    });
    const verifyPort = await listen(verifyServer);
    try {
      await expect(
        handshake(peer(verifyPort), options()),
      ).rejects.toMatchObject({
        code: ErrorCode.Unauthorized,
      });
    } finally {
      await close(verifyServer);
    }
  });

  it("rejects a response body larger than the client cap", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(1024 * 1024, 65);
      for (let count = 0; count < 11; count += 1) response.write(chunk);
      response.end();
    });
    const port = await listen(server);
    try {
      await expect(
        call(
          peer(port),
          { jsonrpc: "2.0", id: 1, method: "tasks/get", params: {} },
          options(),
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(ClientProtocolError);
        expect(error).toHaveProperty("status", 200);
        expect(error).toHaveProperty(
          "message",
          "Peer response body is too large",
        );
        return true;
      });
    } finally {
      await close(server);
    }
  });

  it("classifies malformed peer records as unreachable", async () => {
    const malformed = peer(7330);
    (malformed as unknown as { host: unknown }).host = 123;
    await expect(
      call(
        malformed as PeerRecord,
        { jsonrpc: "2.0", id: 1, method: "tasks/get", params: {} },
        options(),
      ),
    ).rejects.toBeInstanceOf(PeerUnreachableError);
  });

  it("rejects an empty peer id in a handshake challenge", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          peer_id: "",
          nonce: "server-nonce",
          hmac: Buffer.alloc(32).toString("base64"),
        }),
      );
    });
    const port = await listen(server);
    try {
      await expect(handshake(peer(port), options())).rejects.toMatchObject({
        name: "ClientProtocolError",
      });
    } finally {
      await close(server);
    }
  });

  it("surfaces a live peer's JSON-RPC application error", async () => {
    const server = createAgentServer({
      port: 0,
      swarmKey: key,
      identity: serverIdentity,
    });
    const address = await server.start();
    try {
      await expect(
        call(
          peer(address.port),
          { jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x" } },
          options(),
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(PiMeshError);
        expect(error).toHaveProperty("code", -32001);
        expect(error).not.toBeInstanceOf(PeerUnreachableError);
        return true;
      });
    } finally {
      await server.stop();
    }
  });
});
