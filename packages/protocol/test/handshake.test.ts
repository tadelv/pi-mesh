// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  computeHandshakeHmac,
  createNonce,
  encodeTranscript,
  verifyHandshake,
  type HandshakeTranscript,
} from "../src/index.js";

const key = new Uint8Array([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
  0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
]);

const transcript: HandshakeTranscript = {
  clientPeerId: "client-peer-123",
  clientNonce: "client-fixed-nonce",
  serverPeerId: "server-peer-456",
  serverNonce: "server-fixed-nonce",
};
const expectedHmac = "Hvwa/Io/9uO3n1KcHviLxm1bCzmIJJweGmG1QKjshBk=";

describe("swarm key handshake", () => {
  it("creates a 32-byte base64 nonce", () => {
    expect(Buffer.from(createNonce(), "base64")).toHaveLength(32);
  });

  it("matches the fixed transcript test vector", () => {
    const encoded = encodeTranscript(transcript);
    expect(computeHandshakeHmac(key, encoded)).toBe(expectedHmac);
  });

  it("verifies valid, invalid, malformed, and differently keyed HMACs", () => {
    const encoded = encodeTranscript(transcript);
    const wrongHmac = `${expectedHmac[0] === "A" ? "B" : "A"}${expectedHmac.slice(1)}`;

    expect(verifyHandshake(key, expectedHmac, encoded)).toBe(true);
    expect(verifyHandshake(key, wrongHmac, encoded)).toBe(false);
    expect(verifyHandshake(key, expectedHmac.slice(0, -1), encoded)).toBe(false);
    expect(verifyHandshake(key, `${expectedHmac}AAAA`, encoded)).toBe(false);
    expect(verifyHandshake(key, "not-base64", encoded)).toBe(false);
    expect(verifyHandshake(new Uint8Array(32).fill(0), expectedHmac, encoded)).toBe(
      false,
    );
  });

  it("keeps adjacent field boundaries unambiguous", () => {
    const first: HandshakeTranscript = {
      ...transcript,
      clientNonce: "ab",
      serverNonce: "c",
    };
    const second: HandshakeTranscript = {
      ...transcript,
      clientNonce: "a",
      serverNonce: "bc",
    };

    expect(Array.from(encodeTranscript(first))).not.toEqual(
      Array.from(encodeTranscript(second)),
    );
  });

  it("derives the same HMAC for both parties", () => {
    const encoded = encodeTranscript(transcript);
    expect(computeHandshakeHmac(key, encoded)).toBe(
      computeHandshakeHmac(new Uint8Array(key), encoded),
    );
  });
});
