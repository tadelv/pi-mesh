// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type HandshakeTranscript = {
  clientPeerId: string;
  clientNonce: string;
  serverPeerId: string;
  serverNonce: string;
};

export function createNonce(): string {
  return randomBytes(32).toString("base64");
}

export function encodeTranscript(transcript: HandshakeTranscript): Uint8Array {
  const fields = [
    transcript.clientNonce,
    transcript.serverNonce,
    transcript.clientPeerId,
    transcript.serverPeerId,
  ];

  // NUL is the separator, so a value containing one would alias a different
  // transcript. docs/PROTOCOL.md forbids U+0000 in these fields.
  if (fields.some((field) => field.includes("\u0000"))) {
    throw new TypeError("Handshake fields must not contain U+0000");
  }

  return new TextEncoder().encode(fields.join("\u0000"));
}

export function computeHandshakeHmac(
  key: Uint8Array,
  transcript: Uint8Array,
): string {
  return createHmac("sha256", key).update(transcript).digest("base64");
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (value.length % 4 !== 0) {
    return undefined;
  }

  // Re-encoding is canonical, so this also rejects padding and alphabet
  // variants that Node's decoder would otherwise accept leniently.
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

export function verifyHandshake(
  localKey: Uint8Array,
  remoteHmac: unknown,
  transcript: Uint8Array,
): boolean {
  // This is the trust boundary: the response arrives as parsed JSON.
  if (typeof remoteHmac !== "string" || localKey.byteLength === 0) {
    return false;
  }

  const remoteBytes = decodeBase64(remoteHmac);
  if (remoteBytes === undefined) {
    return false;
  }

  const expectedBytes = Buffer.from(
    computeHandshakeHmac(localKey, transcript),
    "base64",
  );
  if (remoteBytes.byteLength !== expectedBytes.byteLength) {
    return false;
  }

  return timingSafeEqual(expectedBytes, remoteBytes);
}
