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
  return new TextEncoder().encode(
    [
      transcript.clientNonce,
      transcript.serverNonce,
      transcript.clientPeerId,
      transcript.serverPeerId,
    ].join("\u0000"),
  );
}

export function computeHandshakeHmac(
  key: Uint8Array,
  transcript: Uint8Array,
): string {
  return createHmac("sha256", key).update(transcript).digest("base64");
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return undefined;
  }

  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

export function verifyHandshake(
  localKey: Uint8Array,
  remoteHmac: string,
  transcript: Uint8Array,
): boolean {
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
