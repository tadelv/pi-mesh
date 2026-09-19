// SPDX-License-Identifier: GPL-3.0-or-later

import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { randomUUID } from "node:crypto";
import {
  A2A_PROTOCOL_VERSION,
  computeHandshakeHmac,
  createNonce,
  encodeTranscript,
  verifyHandshake,
} from "@pi-mesh/protocol";
import type {
  HandshakeResponse,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@pi-mesh/protocol";
import { ErrorCode, PiMeshError } from "@pi-mesh/shared";
import { signedHeaders } from "./auth.js";
import type { PeerIdentity } from "./identity.js";
import type { PeerRecord } from "./registry.js";

/** The default deadline for each individual HTTP request, including handshakes. */
export const DEFAULT_CLIENT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface A2AClientOptions {
  /** Raw swarm key bytes. */
  swarmKey?: Uint8Array;
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
  readonly status: number | undefined;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "ClientProtocolError";
    this.status = options?.status;
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
  const key = options.swarmKey;
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
      status: result.status,
    });
  }
}

function handshakeResponse(value: unknown, status: number): HandshakeResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).peer_id !== "string" ||
    ((value as Record<string, unknown>).peer_id as string).length === 0 ||
    typeof (value as Record<string, unknown>).nonce !== "string" ||
    typeof (value as Record<string, unknown>).hmac !== "string"
  ) {
    throw new ClientProtocolError("Handshake returned an invalid challenge", {
      status,
    });
  }
  return value as HandshakeResponse;
}

function handshakeFailure(result: HttpResult, context: string): never {
  if (result.status === 401 || result.status === 403) {
    throw new PiMeshError(
      ErrorCode.Unauthorized,
      `${context} failed with HTTP ${result.status}`,
    );
  }
  const value = parseJson(result, context);
  const reason: string =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).error === "string"
      ? String((value as Record<string, unknown>).error)
      : `${context} failed with HTTP ${result.status}`;
  throw new ClientProtocolError(reason, { status: result.status });
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
  const challenge = handshakeResponse(
    parseJson(hello, "Handshake hello"),
    hello.status,
  );
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
      status: hello.status,
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
      { status: proof.status },
    );
  }
  return challenge.peer_id;
}

function rpcResponse(
  value: unknown,
  request: JsonRpcRequest,
  status: number,
): JsonRpcResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).jsonrpc !== "2.0"
  ) {
    throw new ClientProtocolError(
      "Peer returned an invalid JSON-RPC response",
      {
        status,
      },
    );
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
      { status },
    );
  }
  if (response.id !== request.id && !(hasError && response.id === null)) {
    throw new ClientProtocolError(
      "Peer returned a response for another request",
      { status },
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
  if (request.method === "message/stream") {
    throw new ClientProtocolError(
      "message/stream is unsupported by this client because it cannot read SSE responses",
    );
  }
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
  if (response.status === 401 || response.status === 403) {
    throw new PiMeshError(
      ErrorCode.Unauthorized,
      `JSON-RPC request failed with HTTP ${response.status}`,
    );
  }
  const value = parseJson(response, "JSON-RPC request");
  return (rpcResponse(value, request, response.status) as { result: unknown })
    .result;
}

/**
 * The single transport path for every request this client makes, handshakes
 * included. There used to be two near-identical copies, which is how one of
 * them ends up missing a later fix to timeouts or abort handling.
 */
async function postJson(
  peer: PeerRecord,
  path: string,
  bodyText: string,
  headers: Record<string, string>,
  timeout: number,
): Promise<HttpResult> {
  const body = Buffer.from(bodyText, "utf8");
  let url: string;
  try {
    if (
      typeof peer.host !== "string" ||
      peer.host.length === 0 ||
      !Number.isInteger(peer.port) ||
      peer.port < 1 ||
      peer.port > 65535
    ) {
      throw new TypeError("Peer record has an invalid host or port");
    }
    url = `${baseUrl(peer)}${path}`;
  } catch (error) {
    throw new PeerUnreachableError(
      String(peer.id),
      `http://${String(peer.host)}:${String(peer.port)}${path}`,
      error,
    );
  }
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
          if (response.statusCode === 401 || response.statusCode === 403) {
            finish(() =>
              reject(
                new PiMeshError(
                  ErrorCode.Unauthorized,
                  `Peer returned HTTP ${response.statusCode}`,
                ),
              ),
            );
            response.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer | string) => {
            const buffer =
              typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            size += buffer.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
              finish(() =>
                reject(
                  new ClientProtocolError("Peer response body is too large", {
                    status: response.statusCode ?? 0,
                  }),
                ),
              );
              response.destroy();
              return;
            }
            chunks.push(buffer);
          });
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
      client.on("error", (error) =>
        finish(() => reject(new PeerUnreachableError(peer.id, url, error))),
      );
      client.end(body);
    } catch (error) {
      finish(() => reject(new PeerUnreachableError(peer.id, url, error)));
    }
  });
}

/** Stream the documented A2A message/stream skill convention. */
export async function* streamSkill(
  peer: PeerRecord,
  skill: string,
  input: unknown,
  options: A2AClientOptions,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  if (signal?.aborted) return;
  await handshake(peer, options);
  if (signal?.aborted) return;

  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "message/stream",
    params: {
      message: {
        messageId: randomUUID(),
        role: "ROLE_USER",
        parts: [{ data: { skill, input } }],
      },
    },
  };
  const bodyText = JSON.stringify(request);
  const headers = signedHeaders(optionsKey(options), options.identity, {
    method: "POST",
    path: "/",
    body: bodyText,
    recipientPeerId: peer.id,
  });
  const body = Buffer.from(bodyText, "utf8");
  let url: string;
  try {
    url = `${baseUrl(peer)}/`;
  } catch (error) {
    throw new PeerUnreachableError(String(peer.id), "", error);
  }

  let response: IncomingMessage;
  let client: ReturnType<typeof httpRequest> | undefined;
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        client?.destroy(
          new Error(`Request timed out after ${timeoutMs(options)}ms`),
        );
      }, timeoutMs(options));
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
            path: "/",
            headers: {
              ...headers,
              "content-type": "application/json",
              "content-length": body.byteLength,
              "A2A-Version": A2A_PROTOCOL_VERSION,
              connection: "keep-alive",
            },
          },
          (incoming) => finish(() => resolve(incoming)),
        );
        client.on("error", (error) =>
          finish(() => reject(new PeerUnreachableError(peer.id, url, error))),
        );
        if (signal !== undefined) {
          signal.addEventListener("abort", () => client?.destroy(), {
            once: true,
          });
        }
        client.end(body);
      } catch (error) {
        finish(() => reject(new PeerUnreachableError(peer.id, url, error)));
      }
    });
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  }

  if (response.statusCode === 401 || response.statusCode === 403) {
    response.destroy();
    throw new PiMeshError(
      ErrorCode.Unauthorized,
      `JSON-RPC stream failed with HTTP ${response.statusCode}`,
    );
  }
  if (response.statusCode !== 200) {
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const value = parseJson(
      {
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      },
      "JSON-RPC stream",
    );
    rpcResponse(value, request, response.statusCode ?? 0);
    throw new ClientProtocolError("Peer returned an empty stream response", {
      ...(response.statusCode === undefined
        ? {}
        : { status: response.statusCode }),
    });
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let emitted = false;
  let rawSize = 0;
  const rawChunks: Buffer[] = [];
  const emit = (): unknown | undefined => {
    if (dataLines.length === 0) return undefined;
    const text = dataLines.join("\n");
    dataLines = [];
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new ClientProtocolError("Peer returned invalid SSE JSON", {
        cause: error,
        ...(response.statusCode === undefined
          ? {}
          : { status: response.statusCode }),
      });
    }
    emitted = true;
    return value;
  };

  try {
    for await (const chunk of response) {
      const chunkBuffer =
        typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      // Only while nothing has been emitted. rawChunks exists solely for the
      // !emitted fallback below, so retaining chunks an open-ended stream keeps
      // producing would grow without bound for the life of the session - the
      // server replays a session from the start, so a large session is a large
      // leak. Keep the fallback bounded like postJson's unary body.
      if (!emitted) {
        rawSize += chunkBuffer.byteLength;
        if (rawSize > MAX_RESPONSE_BYTES) {
          throw new ClientProtocolError("Peer response body is too large", {
            status: response.statusCode ?? 0,
          });
        }
        rawChunks.push(chunkBuffer);
      }
      buffer += decoder.decode(chunkBuffer, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const value = emit();
          if (value !== undefined) yield value;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      if (buffer.startsWith("data:"))
        dataLines.push(buffer.slice(5).trimStart());
    }
    const value = emit();
    if (value !== undefined) yield value;
    if (!emitted) {
      const fallbackBody = Buffer.concat(rawChunks);
      if (fallbackBody.toString("utf8").trim() === "") {
        throw new ClientProtocolError(
          "Peer returned an empty stream response",
          {
            ...(response.statusCode === undefined
              ? {}
              : { status: response.statusCode }),
          },
        );
      }
      const value = parseJson(
        {
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: fallbackBody,
        },
        "JSON-RPC stream",
      );
      rpcResponse(value, request, response.statusCode ?? 0);
      throw new ClientProtocolError("Peer returned an empty stream response", {
        ...(response.statusCode === undefined
          ? {}
          : { status: response.statusCode }),
      });
    }
  } catch (error) {
    if (signal?.aborted) return;
    if (error instanceof ClientProtocolError || error instanceof PiMeshError) {
      throw error;
    }
    throw new PeerUnreachableError(peer.id, url, error);
  } finally {
    response.destroy();
  }
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
    Array.isArray(response)
  ) {
    throw new ClientProtocolError(
      "Skill response was not an A2A response envelope",
    );
  }
  const envelope = response as {
    message?: unknown;
    task?: unknown;
    parts?: unknown;
  };
  if ("parts" in envelope) {
    throw new ClientProtocolError(
      "Skill response used a bare message; expected an A2A response envelope",
    );
  }
  const hasMessage = envelope.message !== undefined;
  const hasTask = envelope.task !== undefined;
  if (hasMessage && hasTask) {
    throw new ClientProtocolError(
      "Skill response contained both message and task payloads",
    );
  }
  if (hasTask) {
    if (
      typeof envelope.task !== "object" ||
      envelope.task === null ||
      Array.isArray(envelope.task)
    ) {
      throw new ClientProtocolError("Skill response contained an invalid task");
    }
    return envelope.task;
  }
  const message = envelope.message;
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message) ||
    !Array.isArray((message as { parts?: unknown }).parts)
  ) {
    throw new ClientProtocolError(
      "Skill response did not contain a message with parts",
    );
  }
  const part = (message as { parts: unknown[] }).parts.find(
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
