// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { deriveControlCredential, pairingProof } from "@pi-mesh/protocol";
import { PairingService } from "../src/pairing.js";

const tokenBytes = (token: string): Uint8Array => Buffer.from(token, "base64");

describe("PairingService", () => {
  it("pairs using the handshake transcript and consumes the token once", () => {
    const service = new PairingService({
      controlId: "control",
      controlName: "Control",
    });
    const issued = service.issue();
    const hello = service.hello(
      {
        agent_id: "agent",
        agent_name: "Agent",
        token_id: issued.token_id,
        nonce: "client-nonce",
      },
      "10.0.0.7",
    );
    expect(hello.status).toBe(200);
    const challenge = hello.body as { nonce: string };
    const transcript = {
      clientPeerId: "agent",
      clientNonce: "client-nonce",
      serverPeerId: "control",
      serverNonce: challenge.nonce,
    };
    const proof = pairingProof(tokenBytes(issued.token), transcript, "verify");
    const verified = service.verify({
      agent_id: "agent",
      nonce: challenge.nonce,
      hmac: proof,
    });
    expect(verified).toMatchObject({
      status: 200,
      body: { ok: true, control_id: "control" },
      paired: {
        agentId: "agent",
        agentName: "Agent",
        agentHost: "10.0.0.7",
        credential: deriveControlCredential(
          tokenBytes(issued.token),
          transcript,
        ),
      },
    });
    expect(
      service.verify({
        agent_id: "agent",
        nonce: challenge.nonce,
        hmac: proof,
      }),
    ).toMatchObject({ status: 401, body: { error: "invalid_proof" } });
  });

  it("keeps the announced agent port on successful verify and defaults it when absent", () => {
    const service = new PairingService({ controlId: "control" });
    const issued = service.issue();
    const hello = service.hello({
      agent_id: "agent",
      token_id: issued.token_id,
      nonce: "client",
      agent_port: 7442,
    });
    const nonce = (hello.body as { nonce: string }).nonce;
    const transcript = {
      clientPeerId: "agent",
      clientNonce: "client",
      serverPeerId: "control",
      serverNonce: nonce,
    };
    const verified = service.verify({
      agent_id: "agent",
      nonce,
      hmac: pairingProof(tokenBytes(issued.token), transcript, "verify"),
    });
    expect(verified.paired?.agentPort).toBe(7442);
    const fallbackToken = service.issue();
    const fallbackHello = service.hello({
      agent_id: "agent-2",
      token_id: fallbackToken.token_id,
      nonce: "client-2",
    });
    const fallbackNonce = (fallbackHello.body as { nonce: string }).nonce;
    const fallbackTranscript = {
      clientPeerId: "agent-2",
      clientNonce: "client-2",
      serverPeerId: "control",
      serverNonce: fallbackNonce,
    };
    const fallback = service.verify({
      agent_id: "agent-2",
      nonce: fallbackNonce,
      hmac: pairingProof(
        tokenBytes(fallbackToken.token),
        fallbackTranscript,
        "verify",
      ),
    });
    expect(fallback.paired?.agentPort).toBe(7330);
  });

  it("rejects unknown and expired tokens", () => {
    let now = 1000;
    const service = new PairingService({
      controlId: "control",
      now: () => now,
      ttlMs: 10,
    });
    expect(
      service.hello({ agent_id: "agent", token_id: "unknown", nonce: "n" }),
    ).toMatchObject({ status: 401, body: { error: "invalid_token" } });
    const issued = service.issue();
    now = 1010;
    expect(
      service.hello({
        agent_id: "agent",
        token_id: issued.token_id,
        nonce: "n",
      }),
    ).toMatchObject({ status: 401, body: { error: "invalid_token" } });
  });

  it("keeps a token usable after a bad proof", () => {
    const service = new PairingService({ controlId: "control" });
    const issued = service.issue();
    const hello = service.hello({
      agent_id: "agent",
      token_id: issued.token_id,
      nonce: "client",
    });
    const nonce = (hello.body as { nonce: string }).nonce;
    expect(
      service.verify({ agent_id: "agent", nonce, hmac: "bad" }),
    ).toMatchObject({ status: 401, body: { error: "invalid_proof" } });
    const transcript = {
      clientPeerId: "agent",
      clientNonce: "client",
      serverPeerId: "control",
      serverNonce: nonce,
    };
    const proof = pairingProof(tokenBytes(issued.token), transcript, "verify");
    expect(
      service.verify({ agent_id: "agent", nonce, hmac: proof }).status,
    ).toBe(200);
  });

  it("refuses to accept the observable hello proof as a verify proof", () => {
    const service = new PairingService({ controlId: "control" });
    const issued = service.issue();
    const hello = service.hello(
      {
        agent_id: "agent",
        token_id: issued.token_id,
        nonce: "client",
      },
      "10.0.0.7",
    );
    const { nonce, hmac } = hello.body as { nonce: string; hmac: string };
    const transcript = {
      clientPeerId: "agent",
      clientNonce: "client",
      serverPeerId: "control",
      serverNonce: nonce,
    };
    // The hello response is on the wire, so it must not double as the verify
    // proof: an observer replaying it would consume the single-use token.
    expect(service.verify({ agent_id: "agent", nonce, hmac }).status).toBe(401);
    // And the real agent can still verify: the token survived the replay.
    const proof = pairingProof(tokenBytes(issued.token), transcript, "verify");
    expect(
      service.verify({ agent_id: "agent", nonce, hmac: proof }).status,
    ).toBe(200);
  });

  it("consumes one token for one pairing, not two", () => {
    const service = new PairingService({ controlId: "control" });
    const issued = service.issue();
    const first = service.hello({
      agent_id: "agent",
      token_id: issued.token_id,
      nonce: "client-1",
    });
    const second = service.hello({
      agent_id: "agent",
      token_id: issued.token_id,
      nonce: "client-2",
    });
    const transcriptFor = (body: unknown, clientNonce: string) => {
      const nonce = (body as { nonce: string }).nonce;
      return {
        clientPeerId: "agent",
        clientNonce,
        serverPeerId: "control",
        serverNonce: nonce,
      };
    };
    const firstTranscript = transcriptFor(first.body, "client-1");
    expect(
      service.verify({
        agent_id: "agent",
        nonce: firstTranscript.serverNonce,
        hmac: pairingProof(tokenBytes(issued.token), firstTranscript, "verify"),
      }).status,
    ).toBe(200);
    const secondTranscript = transcriptFor(second.body, "client-2");
    expect(
      service.verify({
        agent_id: "agent",
        nonce: secondTranscript.serverNonce,
        hmac: pairingProof(
          tokenBytes(issued.token),
          secondTranscript,
          "verify",
        ),
      }),
    ).toMatchObject({ status: 401, body: { error: "invalid_proof" } });
  });

  it("refuses a hello when the pending table is full, without evicting", () => {
    const service = new PairingService({ controlId: "control", maxPending: 1 });
    const issued = service.issue();
    expect(
      service.hello({
        agent_id: "agent",
        token_id: issued.token_id,
        nonce: "client",
      }).status,
    ).toBe(200);
    expect(
      service.hello({
        agent_id: "agent-2",
        token_id: issued.token_id,
        nonce: "client-2",
      }),
    ).toMatchObject({
      status: 503,
      body: { error: "too_many_pending_pairings" },
    });
    expect(service.pendingCount).toBe(1);
  });
});
