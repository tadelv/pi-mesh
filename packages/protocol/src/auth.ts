// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const PI_MESH_HEADERS = {
  peer: "X-Pi-Mesh-Peer",
  nonce: "X-Pi-Mesh-Nonce",
  timestamp: "X-Pi-Mesh-Timestamp",
  signature: "X-Pi-Mesh-Signature",
} as const;

export const MAX_CLOCK_SKEW_MS = 60_000;
export const REPLAY_WINDOW_MS = 60_000;
export const REQUEST_NONCE_BYTES = 32;

export type RequestTranscriptFields = {
  method: string;
  path: string;
  body: Uint8Array | string;
  peerId: string;
  nonce: string;
  timestamp: string;
};

export function sha256Hex(input: Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function encodeRequestTranscript(
  fields: RequestTranscriptFields,
): Uint8Array {
  const values = [
    fields.method,
    fields.path,
    sha256Hex(fields.body),
    fields.peerId,
    fields.nonce,
    fields.timestamp,
  ];
  if (values.some((value) => value.includes("\u0000"))) {
    throw new TypeError("Request fields must not contain U+0000");
  }
  return new TextEncoder().encode(values.join("\u0000"));
}

export function signRequest(
  key: Uint8Array,
  fields: RequestTranscriptFields,
): string {
  return createHmac("sha256", key)
    .update(encodeRequestTranscript(fields))
    .digest("base64");
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (value.length % 4 !== 0) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

export function verifyRequestSignature(
  key: Uint8Array,
  fields: RequestTranscriptFields,
  signature: unknown,
): boolean {
  if (key.byteLength === 0 || typeof signature !== "string") return false;
  const remote = decodeBase64(signature);
  if (remote === undefined) return false;
  let expected: Uint8Array;
  try {
    expected = Buffer.from(signRequest(key, fields), "base64");
  } catch {
    return false;
  }
  if (remote.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(expected, remote);
}

export function isWithinClockSkew(timestamp: string, now: Date): boolean {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || !Number.isFinite(now.getTime())) return false;
  return Math.abs(now.getTime() - parsed) <= MAX_CLOCK_SKEW_MS;
}
