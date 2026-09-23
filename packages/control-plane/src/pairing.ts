// SPDX-License-Identifier: GPL-3.0-or-later

import {
  PAIR_TOKEN_TTL_MS,
  createNonce,
  createPairingToken,
  deriveControlCredential,
  pairTokenId,
  pairingProof,
  verifyPairingProof,
} from "@pi-mesh/protocol";

interface TokenRecord {
  token: Uint8Array;
  expiresAt: number;
}
interface PendingRecord {
  tokenId: string;
  agentName: string;
  agentPort: number;
  /**
   * The address the hello arrived from. Recorded at hello, not at verify: the
   * verify POST is the one an observer could forge with a captured hello proof,
   * so trusting its source address would let that observer register itself as
   * the agent.
   */
  agentHost?: string;
  transcript: {
    clientPeerId: string;
    clientNonce: string;
    serverPeerId: string;
    serverNonce: string;
  };
  expiresAt: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function validText(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && !value.includes("\u0000")
  );
}

export class PairingService {
  private readonly controlId: string;
  private readonly controlName: string;
  private readonly now: () => number;
  private readonly maxPending: number;
  private readonly ttlMs: number;
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly pending = new Map<string, PendingRecord>();

  constructor(options: {
    controlId: string;
    controlName?: string;
    now?: () => number;
    maxPending?: number;
    ttlMs?: number;
  }) {
    this.controlId = options.controlId;
    this.controlName = options.controlName ?? "";
    this.now = options.now ?? Date.now;
    this.maxPending = options.maxPending ?? 64;
    this.ttlMs = options.ttlMs ?? PAIR_TOKEN_TTL_MS;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, token] of this.tokens)
      if (token.expiresAt <= now) this.tokens.delete(id);
    for (const [key, pending] of this.pending)
      if (pending.expiresAt <= now) this.pending.delete(key);
  }

  issue(): { token: string; token_id: string; expires_at: string } {
    this.prune();
    const token = createPairingToken();
    const tokenId = pairTokenId(Buffer.from(token, "base64"));
    const expiresAt = this.now() + this.ttlMs;
    this.tokens.set(tokenId, {
      token: Buffer.from(token, "base64"),
      expiresAt,
    });
    return {
      token,
      token_id: tokenId,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  hello(body: unknown, agentHost?: string): { status: number; body: unknown } {
    this.prune();
    const input = record(body);
    const agentId = input?.agent_id;
    const agentName = input?.agent_name;
    const tokenId = input?.token_id;
    const clientNonce = input?.nonce;
    const agentPort = input?.agent_port ?? 7330;
    if (
      !validText(agentId) ||
      (agentName !== undefined && !validText(agentName)) ||
      !validText(tokenId) ||
      !validText(clientNonce) ||
      !Number.isInteger(agentPort) ||
      (agentPort as number) < 1 ||
      (agentPort as number) > 65535
    ) {
      return { status: 400, body: { error: "invalid_request" } };
    }
    const token = this.tokens.get(tokenId);
    if (token === undefined || token.expiresAt <= this.now())
      return { status: 401, body: { error: "invalid_token" } };
    if (this.pending.size >= this.maxPending)
      return { status: 503, body: { error: "too_many_pending_pairings" } };
    const serverNonce = createNonce();
    const transcript = {
      clientPeerId: agentId,
      clientNonce,
      serverPeerId: this.controlId,
      serverNonce,
    };
    const key = `${agentId}\u0000${serverNonce}`;
    this.pending.set(key, {
      tokenId,
      agentName: typeof agentName === "string" ? agentName : agentId,
      agentPort: agentPort as number,
      ...(agentHost === undefined || agentHost.length === 0
        ? {}
        : { agentHost }),
      transcript,
      expiresAt: token.expiresAt,
    });
    return {
      status: 200,
      body: {
        control_id: this.controlId,
        control_name: this.controlName,
        nonce: serverNonce,
        hmac: pairingProof(token.token, transcript, "hello"),
      },
    };
  }

  verify(body: unknown): {
    status: number;
    body: unknown;
    paired?: {
      agentId: string;
      agentName: string;
      agentPort: number;
      agentHost?: string;
      credential: string;
      pairedAt: string;
    };
  } {
    this.prune();
    const input = record(body);
    const agentId = input?.agent_id;
    const serverNonce = input?.nonce;
    const hmac = input?.hmac;
    if (
      !validText(agentId) ||
      !validText(serverNonce) ||
      typeof hmac !== "string"
    )
      return { status: 401, body: { error: "invalid_proof" } };
    const key = `${agentId}\u0000${serverNonce}`;
    const pending = this.pending.get(key);
    const token =
      pending === undefined ? undefined : this.tokens.get(pending.tokenId);
    if (
      pending === undefined ||
      token === undefined ||
      !verifyPairingProof(token.token, hmac, pending.transcript, "verify")
    ) {
      return { status: 401, body: { error: "invalid_proof" } };
    }
    this.pending.delete(key);
    this.tokens.delete(pending.tokenId);
    const pairedAt = new Date(this.now()).toISOString();
    return {
      status: 200,
      body: { ok: true, control_id: this.controlId },
      paired: {
        agentId,
        agentName: pending.agentName,
        agentPort: pending.agentPort,
        ...(pending.agentHost === undefined
          ? {}
          : { agentHost: pending.agentHost }),
        credential: deriveControlCredential(token.token, pending.transcript),
        pairedAt,
      },
    };
  }

  get pendingCount(): number {
    this.prune();
    return this.pending.size;
  }
}
