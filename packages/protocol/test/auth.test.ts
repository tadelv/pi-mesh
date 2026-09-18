// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  acceptTimestamp,
  computeHandshakeHmac,
  encodeTranscript,
  isWithinClockSkew,
  parseTimestamp,
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
    recipientPeerId: string;
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
    recipientPeerId: vector.recipientPeerId,
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
    // Exactly at the limit is inside it: the document says "more than 60
    // seconds", so the boundary itself is accepted. Without this the pair above
    // would still pass if the comparison flipped from <= to <.
    expect(isWithinClockSkew("2026-09-17T12:01:00.000Z", now)).toBe(true);
    expect(isWithinClockSkew("2026-09-17T11:59:00.000Z", now)).toBe(true);
    expect(isWithinClockSkew("2026-09-17T11:58:59.999Z", now)).toBe(false);
  });

  it("accepts only the documented timestamp shape", () => {
    // Date.parse on its own also swallows a bare date and a local-time string,
    // reading the latter in the SERVER's zone. Signer and verifier would then
    // disagree about the instant, and the failure would surface as a confusing
    // auth rejection rather than an obviously malformed timestamp.
    const now = new Date("2026-09-17T12:00:00.000Z");
    expect(parseTimestamp("2026-09-17T12:00:00.000Z")).toBe(
      Date.UTC(2026, 8, 17, 12),
    );
    expect(parseTimestamp("2026-09-17T12:00:00Z")).toBe(
      Date.UTC(2026, 8, 17, 12),
    );
    expect(parseTimestamp("2026-09-17T14:00:00+02:00")).toBe(
      Date.UTC(2026, 8, 17, 12),
    );
    for (const bad of [
      "2026-09-17",
      "09/17/2026",
      "2026-09-17T12:00:00",
      "2026-09-17 12:00:00Z",
      "not-a-timestamp",
    ]) {
      expect(parseTimestamp(bad), bad).toBeUndefined();
      expect(isWithinClockSkew(bad, now), bad).toBe(false);
    }
  });

  it("returns the instant it admitted, so a cache lifetime can be derived from it", () => {
    // The replay cache must stay populated for a future-dated request's whole
    // acceptance window. Expiring at receipt-plus-window instead left a request
    // dated 30s ahead replayable for ~30s after it stopped being acceptable, so
    // the caller needs the accepted instant rather than a bare boolean.
    const now = new Date("2026-09-17T12:00:00.000Z");
    expect(acceptTimestamp("2026-09-17T12:00:30.000Z", now)).toBe(
      Date.UTC(2026, 8, 17, 12, 0, 30),
    );
    // Later than now: the cache must outlive now + window.
    const future = acceptTimestamp("2026-09-17T12:00:30.000Z", now) as number;
    expect(future > now.getTime()).toBe(true);
    expect(acceptTimestamp("2026-09-17T12:01:00.001Z", now)).toBeUndefined();
    expect(acceptTimestamp("nonsense", now)).toBeUndefined();
  });
});
