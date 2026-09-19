// SPDX-License-Identifier: GPL-3.0-or-later

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";
import {
  A2A_PROTOCOL_VERSION,
  computeHandshakeHmac,
  createNonce,
  encodeTranscript,
  HandshakeResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  verifyHandshake,
} from "@pi-mesh/protocol";
import { ErrorCode, PiMeshError } from "@pi-mesh/shared";
import { signedHeaders } from "./auth.js";
import type { PeerIdentity } from "./identity.js";
import type { PeerRecord } from "./registry.js";

/** The default deadline for each individual HTTP request, including handshakes. */
export const DEFAULT_CLIENT_TIMEOUT_MS = 10_000;

export interface A2AClientOptions {
  /** Raw swarm key bytes. `key` is accepted as a short alias. */
  swarmKey?: Uint8Array;
  key?: Uint8Array;
  identity: PeerIdentity;
  timeoutMs?: number;
}

export class PeerUnreachableError extends Error {
  readonly peerId: string;
  readonly url: string;

  constructor(peerId: string, url: string, cause: unknown) {
    super(`Peer ${peerId} is unreachable at ${url}`, { cause });
    this.name = "PeerUnreachableError";
    this.peerId = peerId;
    this.url = url;
  }
}

export class PeerIdentityMismatchError extends Error {
  readonly advertisedPeerId: string;
  readonly claimedPeerId: string;

  constructor(advertisedPeerId: string, claimedPeerId: string) {
    super(
      `Peer identity mismatch: advertised ${advertisedPeerId}, claimed ${claimedPeerId}`,
    );
    this.name = "PeerIdentityMismatchError";
    this.advertisedPeerId = advertisedPeerId;
    this.claimedPeerId = claimedPeerId;
  }
}

export class ClientProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClientProtocolError";
  }
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function baseUrl(peer: PeerRecord): string {
  const host =
    peer.host.includes(":") && !peer.host.startsWith("[")
      ? `[${peer.host}]`
      : peer.host;
  return `http://${host}:${peer.port}`;
}

function optionsKey(options: A2AClientOptions): Uint8Array {
  const key = options.swarmKey ?? options.key;
  if (key === undefined || key.byteLength === 0) {
    throw new TypeError("A non-empty swarmKey is required");
  }
  return key;
}

function timeoutMs(options: A2AClientOptions): number {
  const timeout = options.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError("timeoutMs must be greater than zero");
  }
  return timeout;
}

function parseJson(result: HttpResult, context: string): unknown {
  try {
    return JSON.parse(result.body.toString("utf8")) as unknown;
  } catch (error) {
    throw new ClientProtocolError(`${context} returned invalid JSON`, {
      cause: error,
    });
  }
}

function handshakeResponse(value: unknown): HandshakeResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).peer_id !== "string" ||
    typeof (value as Record<string, unknown>).nonce !== "string" ||
    typeof (value as Record<string, unknown>).hmac !== "string"
  ) {
    throw new ClientProtocolError("Handshake returned an invalid challenge");
  }
  return value as HandshakeResponse;
}

function handshakeFailure(result: HttpResult, context: string): never {
  const value = parseJson(result, context);
  const reason: string =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).error === "string"
      ? String((value as Record<string, unknown>).error)
      : `${context} failed with HTTP ${result.status}`;
  if (result.status === 401) {
    throw new PiMeshError(ErrorCode.Unauthorized, reason, { data: value });
  }
  throw new ClientProtocolError(reason);
}

/** Perform and mutually verify the two-POST handshake, returning the verified peer ID. */
export async function handshake(
  peer: PeerRecord,
  options: A2AClientOptions,
): Promise<string> {
  const key = optionsKey(options);
  const timeout = timeoutMs(options);
  const clientNonce = createNonce();
  const hello = await postJson(
    peer,
    "/handshake",
    JSON.stringify({
      peer_id: options.identity.peerId,
      nonce: clientNonce,
    }),
    {},
    timeout,
  );
  if (hello.status < 200 || hello.status >= 300) {
    handshakeFailure(hello, "Handshake hello");
  }
  const challenge = handshakeResponse(parseJson(hello, "Handshake hello"));
  let transcript;
  try {
    transcript = encodeTranscript({
      clientPeerId: options.identity.peerId,
      clientNonce,
      serverPeerId: challenge.peer_id,
      serverNonce: challenge.nonce,
    });
  } catch (error) {
    throw new ClientProtocolError("Handshake returned invalid fields", {
      cause: error,
    });
  }
  if (!verifyHandshake(key, challenge.hmac, transcript)) {
    throw new PiMeshError(
      ErrorCode.Unauthorized,
      "Handshake challenge authentication failed",
    );
  }
  if (challenge.peer_id !== peer.id) {
    throw new PeerIdentityMismatchError(peer.id, challenge.peer_id);
  }
  const proof = await postJson(
    peer,
    "/handshake/verify",
    JSON.stringify({
      peer_id: options.identity.peerId,
      // The server nonce, not the client nonce, identifies the pending hello.
      nonce: challenge.nonce,
      hmac: computeHandshakeHmac(key, transcript),
    }),
    {},
    timeout,
  );
  if (proof.status < 200 || proof.status >= 300) {
    handshakeFailure(proof, "Handshake verification");
  }
  const proofBody = parseJson(proof, "Handshake verification");
  if (
    typeof proofBody !== "object" ||
    proofBody === null ||
    Array.isArray(proofBody) ||
    (proofBody as Record<string, unknown>).ok !== true
  ) {
    throw new ClientProtocolError(
      "Handshake verification returned an invalid response",
    );
  }
  return challenge.peer_id;
}

function rpcResponse(value: unknown, request: JsonRpcRequest): JsonRpcResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).jsonrpc !== "2.0"
  ) {
    throw new ClientProtocolError("Peer returned an invalid JSON-RPC response");
  }
  const response = value as Record<string, unknown>;
  const hasResult = "result" in response;
  const error = response.error;
  const hasError =
    typeof error === "object" &&
    error !== null &&
    !Array.isArray(error) &&
    typeof (error as Record<string, unknown>).code === "number" &&
    typeof (error as Record<string, unknown>).message === "string";
  if (hasResult === hasError) {
    throw new ClientProtocolError(
      "Peer returned neither a result nor an error",
    );
  }
  if (response.id !== request.id && !(hasError && response.id === null)) {
    throw new ClientProtocolError(
      "Peer returned a response for another request",
    );
  }
  if (hasError) {
    const rpcError = error as { code: number; message: string; data?: unknown };
    throw new PiMeshError(rpcError.code, rpcError.message, {
      data: rpcError.data,
    });
  }
  return response as unknown as JsonRpcResponse;
}

/** Send one signed JSON-RPC request and resolve its result. */
export async function call(
  peer: PeerRecord,
  request: JsonRpcRequest,
  options: A2AClientOptions,
): Promise<unknown> {
  const key = optionsKey(options);
  const timeout = timeoutMs(options);
  const body = JSON.stringify(request);
  const headers = signedHeaders(key, options.identity, {
    method: "POST",
    path: "/",
    body,
    recipientPeerId: peer.id,
  });
  const response = await postJson(peer, "/", body, headers, timeout);
  const value = parseJson(response, "JSON-RPC request");
  return (rpcResponse(value, request) as { result: unknown }).result;
}

/**
 * The single transport path for every request this client makes, handshakes
 * included. There used to be two near-identical copies, which is how one of
 * them ends up missing a later fix to timeouts or abort handling.
 */
function postJson(
  peer: PeerRecord,
  path: string,
  bodyText: string,
  headers: Record<string, string>,
  timeout: number,
): Promise<HttpResult> {
  const body = Buffer.from(bodyText, "utf8");
  const url = `${baseUrl(peer)}${path}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let client: ReturnType<typeof httpRequest>;
    const timer = setTimeout(() => {
      client.destroy(new Error(`Request timed out after ${timeout}ms`));
    }, timeout);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    try {
      client = httpRequest(
        {
          hostname: peer.host,
          port: peer.port,
          method: "POST",
          path,
          headers: {
            ...headers,
            "content-type": "application/json",
            "content-length": body.byteLength,
            "A2A-Version": A2A_PROTOCOL_VERSION,
            connection: "close",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer | string) =>
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
          );
          response.on("error", (error) =>
            finish(() => reject(new PeerUnreachableError(peer.id, url, error))),
          );
          response.on("aborted", () =>
            finish(() =>
              reject(
                new PeerUnreachableError(
                  peer.id,
                  url,
                  new Error("HTTP response aborted"),
                ),
              ),
            ),
          );
          response.on("end", () =>
            finish(() =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks),
              }),
            ),
          );
        },
      );
    } catch (error) {
      finish(() => reject(new PeerUnreachableError(peer.id, url, error)));
      return;
    }
    client.on("error", (error) =>
      finish(() => reject(new PeerUnreachableError(peer.id, url, error))),
    );
    client.end(body);
  });
}

/** Invoke the documented A2A message/send skill convention. */
export async function sendSkill(
  peer: PeerRecord,
  skill: string,
  input: unknown,
  options: A2AClientOptions,
): Promise<unknown> {
  const response = await call(
    peer,
    {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message/send",
      params: {
        message: {
          messageId: randomUUID(),
          role: "ROLE_USER",
          parts: [{ data: { skill, input } }],
        },
      },
    },
    options,
  );
  if (
    typeof response !== "object" ||
    response === null ||
    Array.isArray(response) ||
    !Array.isArray((response as { parts?: unknown }).parts)
  ) {
    throw new ClientProtocolError("Skill response was not an A2A message");
  }
  const part = (response as { parts: unknown[] }).parts.find(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "data" in value &&
      typeof (value as { data?: unknown }).data === "object" &&
      (value as { data?: unknown }).data !== null &&
      !Array.isArray((value as { data?: unknown }).data) &&
      "result" in (value as { data: Record<string, unknown> }).data,
  );
  if (part === undefined) {
    throw new ClientProtocolError("Skill response did not contain a result");
  }
  return (part as { data: { result: unknown } }).data.result;
}
