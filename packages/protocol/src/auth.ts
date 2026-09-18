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

/**
 * The timestamp shape this protocol accepts: an ISO 8601 instant carrying an
 * explicit UTC designator. `Date.parse` alone also accepts a bare date
 * ("2026-09-17") and a local-time string ("2026-09-17T12:00:00", read in the
 * SERVER's zone). Those are not what the document specifies and would be
 * interpreted differently by signer and verifier, so they are rejected here
 * rather than silently admitted and then failing the skew check.
 */
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export type RequestTranscriptFields = {
  method: string;
  path: string;
  body: Uint8Array | string;
  peerId: string;
  /**
   * The peer this request is addressed to. Binding the recipient is what stops
   * one request captured on the wire from being replayed against a different
   * mesh member: the replay cache is per process, so without this a verbatim
   * copy is fresh at every other agent. A key holder observing the LAN could
   * otherwise execute one observed request once per member.
   */
  recipientPeerId: string;
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
    fields.recipientPeerId,
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

export function parseTimestamp(timestamp: string): number | undefined {
  if (!TIMESTAMP_PATTERN.test(timestamp)) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The acceptance rule for a request timestamp: the parsed instant when the
 * timestamp is inside the window, otherwise undefined. Returning the parsed
 * value rather than a bare boolean lets the caller size its replay cache from
 * the same number it just admitted, so the acceptance window and the cache
 * lifetime cannot drift apart.
 */
export function acceptTimestamp(
  timestamp: string,
  now: Date,
): number | undefined {
  const parsed = parseTimestamp(timestamp);
  if (parsed === undefined || !Number.isFinite(now.getTime())) return undefined;
  return Math.abs(now.getTime() - parsed) <= MAX_CLOCK_SKEW_MS
    ? parsed
    : undefined;
}

export function isWithinClockSkew(timestamp: string, now: Date): boolean {
  return acceptTimestamp(timestamp, now) !== undefined;
}
