// SPDX-License-Identifier: GPL-3.0-or-later

import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { ErrorCode, PiMeshError } from "@pi-mesh/shared";
import {
  createAgentServer,
  handshake,
  call,
  sendSkill,
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

  it("handshakes with a live peer and returns a real skill result", async () => {
    const server = createAgentServer({
      port: 0,
      swarmKey: key,
      identity: serverIdentity,
      sessionsRoot: "/path-that-does-not-exist",
    });
    const address = await server.start();
    try {
      const remote = peer(address.port);
      await expect(handshake(remote, options())).resolves.toBe(remote.id);
      await expect(
        sendSkill(remote, "session.list", {}, options()),
      ).resolves.toEqual({
        sessions: [],
      });
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
        expect(error).not.toEqual(undefined);
        expect(error).not.toEqual({});
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
