// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  computeHandshakeHmac,
  encodeTranscript,
  isWithinClockSkew,
  signRequest,
  verifyRequestSignature,
  type HandshakeTranscript,
  type RequestTranscriptFields,
} from "../src/index.js";

type Vectors = {
  rfc4231: Array<{ keyHex: string; dataHex: string; hmacHex: string }>;
  swarmKey: { keyBase64: string };
  handshake: Array<{
    clientNonce: string;
    serverNonce: string;
    clientPeerId: string;
    serverPeerId: string;
    hmacBase64: string;
    naiveJoinHmacBase64: string;
  }>;
  requestProof: Array<{
    method: string;
    path: string;
    body: string;
    peerId: string;
    nonce: string;
    timestamp: string;
    signatureBase64: string;
  }>;
};

const vectors = JSON.parse(
  await readFile(
    new URL("./fixtures/hmac-vectors.json", import.meta.url),
    "utf8",
  ),
) as Vectors;
const key = Buffer.from(vectors.swarmKey.keyBase64, "base64");

function requestFields(
  vector: Vectors["requestProof"][number],
): RequestTranscriptFields {
  return {
    method: vector.method,
    path: vector.path,
    body: vector.body,
    peerId: vector.peerId,
    nonce: vector.nonce,
    timestamp: vector.timestamp,
  };
}

describe("request authentication vectors", () => {
  it("matches every RFC 4231 primitive vector", () => {
    for (const vector of vectors.rfc4231) {
      expect(
        Buffer.from(
          computeHandshakeHmac(
            Buffer.from(vector.keyHex, "hex"),
            Buffer.from(vector.dataHex, "hex"),
          ),
          "base64",
        ).toString("hex"),
      ).toBe(vector.hmacHex);
    }
  });

  it("matches the NUL-separated handshake vector and rejects naive joining", () => {
    const vector = vectors.handshake[0]!;
    const transcript: HandshakeTranscript = {
      clientNonce: vector.clientNonce,
      serverNonce: vector.serverNonce,
      clientPeerId: vector.clientPeerId,
      serverPeerId: vector.serverPeerId,
    };
    expect(computeHandshakeHmac(key, encodeTranscript(transcript))).toBe(
      vector.hmacBase64,
    );
    expect(
      computeHandshakeHmac(
        key,
        new TextEncoder().encode(
          `${vector.clientNonce}${vector.serverNonce}${vector.clientPeerId}${vector.serverPeerId}`,
        ),
      ),
    ).toBe(vector.naiveJoinHmacBase64);
    expect(vector.naiveJoinHmacBase64).not.toBe(vector.hmacBase64);
  });

  it("matches every request-proof vector", () => {
    for (const vector of vectors.requestProof) {
      expect(signRequest(key, requestFields(vector))).toBe(
        vector.signatureBase64,
      );
      expect(
        verifyRequestSignature(
          key,
          requestFields(vector),
          vector.signatureBase64,
        ),
      ).toBe(true);
    }
  });

  it("covers every request transcript field", () => {
    const original = requestFields(vectors.requestProof[0]!);
    for (const field of [
      "method",
      "path",
      "body",
      "peerId",
      "nonce",
      "timestamp",
    ] as const) {
      const tampered = { ...original, [field]: `${original[field]}x` };
      expect(
        verifyRequestSignature(key, tampered, signRequest(key, original)),
      ).toBe(false);
    }
  });

  it("enforces clock skew and rejects malformed timestamps", () => {
    const now = new Date("2026-09-17T12:00:00.000Z");
    expect(isWithinClockSkew("2026-09-17T12:00:59.999Z", now)).toBe(true);
    expect(isWithinClockSkew("2026-09-17T12:01:00.001Z", now)).toBe(false);
    expect(isWithinClockSkew("not-a-timestamp", now)).toBe(false);
  });
});
