// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { encodeTranscript, type HandshakeTranscript } from "./handshake.js";

export const PAIR_TOKEN_BYTES = 32;
export const PAIR_TOKEN_TTL_MS = 10 * 60_000;

export function createPairingToken(): string {
  return randomBytes(PAIR_TOKEN_BYTES).toString("base64");
}

export function decodePairingToken(token: string): Uint8Array | undefined {
  if (token.length % 4 !== 0) return undefined;
  const decoded = Buffer.from(token, "base64");
  return decoded.byteLength === PAIR_TOKEN_BYTES &&
    decoded.toString("base64") === token
    ? decoded
    : undefined;
}

/**
 * A stable, non-secret handle for a token, so a control plane holding several
 * outstanding tokens can find the one a hello used without the token itself
 * crossing the wire. It is a SHA-256 of a domain prefix and the token, truncated
 * to 16 hex characters; it reveals nothing invertible and is single-use with the
 * token it names.
 */
export function pairTokenId(token: Uint8Array): string {
  return createHash("sha256")
    .update("pi-mesh-pair-token-id\0")
    .update(token)
    .digest("hex")
    .slice(0, 16);
}

/**
 * The two directions of the pairing handshake. They are domain-separated, and
 * that is load-bearing rather than tidy: the control plane's hello proof and
 * the agent's verify proof would otherwise be the same bytes, and the hello
 * response is observable on the wire. An observer could submit it to
 * `/pair/verify` first, consuming the single-use token and registering its own
 * address as the agent. Prefixing the direction makes each proof useless in the
 * other slot.
 */
export type PairingDirection = "hello" | "verify";

export function pairingProof(
  token: Uint8Array,
  transcript: HandshakeTranscript,
  direction: PairingDirection,
): string {
  return createHmac("sha256", token)
    .update(`pi-mesh-pair-${direction}\0`, "utf8")
    .update(encodeTranscript(transcript))
    .digest("base64");
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (value.length % 4 !== 0) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

export function verifyPairingProof(
  token: Uint8Array,
  remoteHmac: unknown,
  transcript: HandshakeTranscript,
  direction: PairingDirection,
): boolean {
  if (typeof remoteHmac !== "string" || token.byteLength === 0) return false;
  const remote = decodeBase64(remoteHmac);
  if (remote === undefined) return false;
  const expected = Buffer.from(
    pairingProof(token, transcript, direction),
    "base64",
  );
  if (remote.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(expected, remote);
}

export function deriveControlCredential(
  token: Uint8Array,
  transcript: HandshakeTranscript,
): string {
  return createHmac("sha256", token)
    .update(
      Buffer.concat([
        Buffer.from("pi-mesh-control-credential\0", "utf8"),
        encodeTranscript(transcript),
      ]),
    )
    .digest("base64");
}
