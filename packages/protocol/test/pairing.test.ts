// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  createPairingToken,
  decodePairingToken,
  deriveControlCredential,
  pairTokenId,
  pairingProof,
  verifyPairingProof,
} from "../src/index.js";

const transcript = {
  clientPeerId: "agent",
  clientNonce: "client",
  serverPeerId: "control",
  serverNonce: "server",
};

describe("pairing primitives", () => {
  it("creates canonical 32-byte tokens and rejects invalid encodings", () => {
    const token = createPairingToken();
    expect(decodePairingToken(token)?.byteLength).toBe(32);
    expect(
      decodePairingToken(Buffer.alloc(31).toString("base64")),
    ).toBeUndefined();
    expect(
      decodePairingToken(
        `${Buffer.alloc(32).toString("base64").slice(0, -1)}A`,
      ),
    ).toBeUndefined();
  });
  it("names a token with a stable, non-secret handle", () => {
    const token = decodePairingToken(createPairingToken())!;
    const other = decodePairingToken(createPairingToken())!;
    expect(pairTokenId(token)).toMatch(/^[0-9a-f]{16}$/);
    expect(pairTokenId(token)).toBe(pairTokenId(token));
    expect(pairTokenId(token)).not.toBe(pairTokenId(other));
  });

  it("domain-separates credentials from pairing proofs", () => {
    const key = new Uint8Array(32).fill(7);
    expect(deriveControlCredential(key, transcript)).not.toBe(
      pairingProof(key, transcript, "hello"),
    );
  });

  it("makes a hello proof useless as a verify proof", () => {
    const key = new Uint8Array(32).fill(9);
    const hello = pairingProof(key, transcript, "hello");
    const verify = pairingProof(key, transcript, "verify");
    // The two directions must not collide; a hello response is observable on
    // the wire, and reusing it as the verify proof would consume the token.
    expect(hello).not.toBe(verify);
    expect(verifyPairingProof(key, hello, transcript, "verify")).toBe(false);
    expect(verifyPairingProof(key, verify, transcript, "verify")).toBe(true);
    expect(verifyPairingProof(key, verify, transcript, "hello")).toBe(false);
    expect(verifyPairingProof(key, "not base64", transcript, "verify")).toBe(
      false,
    );
  });
});
