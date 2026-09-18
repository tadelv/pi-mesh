// SPDX-License-Identifier: GPL-3.0-or-later

import { request } from "node:http";
import { describe, expect, it } from "vitest";
import {
  computeHandshakeHmac,
  createNonce,
  encodeTranscript,
  verifyHandshake,
} from "@pi-mesh/protocol";
import {
  createAgentServer,
  signedHeaders,
  type PeerIdentity,
} from "../src/index.js";

const key = Buffer.from("pi-mesh-vector-key-0123456789abc");
const identity: PeerIdentity = {
  peerId: "11111111-1111-4111-8111-111111111111",
  name: "server",
};
const clientIdentity: PeerIdentity = {
  peerId: "22222222-2222-4222-8222-222222222222",
  name: "client",
};

type Result = {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
};

function call(
  port: number,
  body: string,
  headers: Record<string, string> = {},
  path = "/",
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const client = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: { ...headers, "content-type": "application/json" },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as Record<string, string | string[]>,
            body: text,
          }),
        );
      },
    );
    client.on("error", reject);
    client.end(body);
  });
}

const body = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tasks/get",
  params: { id: "missing" },
});

describe("authenticated agent requests", () => {
  it("accepts a request once and rejects its replay", async () => {
    const server = createAgentServer({ port: 0, swarmKey: key, identity });
    const address = await server.start();
    try {
      const headers = {
        ...signedHeaders(key, clientIdentity, {
          method: "POST",
          path: "/",
          body,
        }),
        "A2A-Version": "1.0",
      };
      expect((await call(address.port, body, headers)).body).toContain(
        '"code":-32001',
      );
      expect(
        JSON.parse((await call(address.port, body, headers)).body).error.code,
      ).toBe(-32100);
    } finally {
      await server.stop();
    }
  });

  it("rejects skewed and tampered requests", async () => {
    const server = createAgentServer({ port: 0, swarmKey: key, identity });
    const address = await server.start();
    try {
      const staleFields = {
        method: "POST",
        path: "/",
        body,
        peerId: clientIdentity.peerId,
        nonce: createNonce(),
        timestamp: "2000-01-01T00:00:00.000Z",
      };
      const stale = {
        "X-Pi-Mesh-Peer": staleFields.peerId,
        "X-Pi-Mesh-Nonce": staleFields.nonce,
        "X-Pi-Mesh-Timestamp": staleFields.timestamp,
        "X-Pi-Mesh-Signature": (await import("@pi-mesh/protocol")).signRequest(
          key,
          staleFields,
        ),
        "A2A-Version": "1.0",
      };
      expect(
        JSON.parse((await call(address.port, body, stale)).body).error.code,
      ).toBe(-32100);
      const valid = {
        ...signedHeaders(key, clientIdentity, {
          method: "POST",
          path: "/",
          body,
        }),
        "A2A-Version": "1.0",
      };
      expect(
        JSON.parse((await call(address.port, `${body} `, valid)).body).error
          .code,
      ).toBe(-32100);
    } finally {
      await server.stop();
    }
  });

  it("mutually verifies the handshake without putting the key on wire", async () => {
    const server = createAgentServer({ port: 0, swarmKey: key, identity });
    const address = await server.start();
    const wire: string[] = [];
    try {
      const clientNonce = createNonce();
      const helloBody = JSON.stringify({
        peer_id: clientIdentity.peerId,
        nonce: clientNonce,
      });
      const hello = await call(address.port, helloBody, {}, "/handshake");
      wire.push(helloBody, hello.body, ...Object.values(hello.headers).flat());
      const challenge = JSON.parse(hello.body) as {
        peer_id: string;
        nonce: string;
        hmac: string;
      };
      const transcript = {
        clientPeerId: clientIdentity.peerId,
        clientNonce,
        serverPeerId: challenge.peer_id,
        serverNonce: challenge.nonce,
      };
      expect(
        verifyHandshake(key, challenge.hmac, encodeTranscript(transcript)),
      ).toBe(true);
      expect(
        verifyHandshake(
          Buffer.alloc(32),
          challenge.hmac,
          encodeTranscript(transcript),
        ),
      ).toBe(false);
      const proof = computeHandshakeHmac(key, encodeTranscript(transcript));
      const proofBody = JSON.stringify({
        peer_id: clientIdentity.peerId,
        nonce: challenge.nonce,
        hmac: proof,
      });
      const verified = await call(
        address.port,
        proofBody,
        {},
        "/handshake/verify",
      );
      wire.push(
        proofBody,
        verified.body,
        ...Object.values(verified.headers).flat(),
      );
      expect(verified.status).toBe(200);
      expect(wire.join("\n")).not.toContain(key.toString("utf8"));
      expect(wire.join("\n")).not.toContain(key.toString("base64"));
    } finally {
      await server.stop();
    }
  });

  it("resolves the handshake by echoed server nonce, and refuses the ambiguous client nonce", async () => {
    // The verify POST must echo the SERVER nonce. Accepting the client nonce as
    // an alternative lookup key is what broke: a client that repeats a hello
    // (a retry after a timeout) leaves several pending entries that share one
    // client nonce, and the fallback scan resolved that ambiguity by matching
    // the OLDEST entry. Observed behaviour was backwards - a valid proof over the
    // newest server nonce was refused with 401 while a proof over the superseded
    // nonce was accepted, so the server validated a transcript the client never
    // meant to send.
    const server = createAgentServer({ port: 0, swarmKey: key, identity });
    const address = await server.start();
    try {
      const clientNonce = createNonce();
      const hello = () =>
        JSON.stringify({ peer_id: clientIdentity.peerId, nonce: clientNonce });
      const first = JSON.parse(
        (await call(address.port, hello(), {}, "/handshake")).body,
      ) as { peer_id: string; nonce: string };
      const second = JSON.parse(
        (await call(address.port, hello(), {}, "/handshake")).body,
      ) as { peer_id: string; nonce: string };
      expect(second.nonce).not.toBe(first.nonce);

      const proofFor = (serverNonce: string): string =>
        computeHandshakeHmac(
          key,
          encodeTranscript({
            clientPeerId: clientIdentity.peerId,
            clientNonce,
            serverPeerId: second.peer_id,
            serverNonce,
          }),
        );
      const verify = (nonce: string, hmac: string) =>
        call(
          address.port,
          JSON.stringify({
            peer_id: clientIdentity.peerId,
            nonce,
            hmac,
          }),
          {},
          "/handshake/verify",
        );

      // A proof is bound to one server nonce: it must not be accepted against a
      // different hello's nonce, even though the client nonce matches.
      expect((await verify(second.nonce, proofFor(first.nonce))).status).toBe(
        401,
      );

      // These two MUST run while both pending entries still exist, otherwise
      // they pass for the wrong reason. Reached through the client nonce, the
      // old fallback scan matched the OLDEST pending entry and therefore
      // ACCEPTED proofFor(first.nonce); an exact server-nonce lookup cannot,
      // because the client nonce is not a key at all.
      expect((await verify(clientNonce, proofFor(first.nonce))).status).toBe(
        401,
      );
      expect((await verify(clientNonce, proofFor(second.nonce))).status).toBe(
        401,
      );

      // Each hello's own server nonce still verifies its own proof, which also
      // consumes both entries.
      expect((await verify(first.nonce, proofFor(first.nonce))).status).toBe(
        200,
      );
      expect((await verify(second.nonce, proofFor(second.nonce))).status).toBe(
        200,
      );
    } finally {
      await server.stop();
    }
  });
});
