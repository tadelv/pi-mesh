// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type {
  AgentCard,
  AgentSkill,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcRequest,
  Message,
  Part,
  StreamResponse,
} from "@pi-mesh/protocol";
import {
  A2A_ERROR_CODES,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  AGENT_CARD_ROUTE,
  PI_MESH_HEADERS,
  REPLAY_WINDOW_MS,
  computeHandshakeHmac,
  createNonce,
  encodeTranscript,
  acceptTimestamp,
  verifyHandshake as verifyHandshakeHmac,
  verifyRequestSignature,
  type HandshakeTranscript,
} from "@pi-mesh/protocol";
import {
  configuredMeshPort,
  createLogger,
  ErrorCode,
  PiMeshError,
} from "@pi-mesh/shared";
import {
  assertExecutionAllowed,
  parseSpawnPolicy,
  type SpawnPolicy,
} from "./spawn-policy.js";
import {
  createSkillRegistry,
  servedSkills,
  type SkillRegistry,
  type SkillRegistryOptions,
} from "./skills.js";
import {
  sessionStream,
  type SessionStream,
  type SessionStreamOptions,
} from "./stream.js";
import type { SessionReadRequest } from "./sessions.js";
import { TaskStore } from "./tasks.js";
import { loadOrCreateIdentity, type PeerIdentity } from "./identity.js";
import { loadSwarmKey } from "./swarm-key.js";
import {
  controlCredentialBytes,
  defaultControlCredentialsPath,
  loadControlCredentials,
  type ControlCredential,
} from "./control-credentials.js";
import type { JobManager, LiveStreamEvent } from "./jobs.js";

const MAX_REPLAY_ENTRIES = 10_000;
const MAX_PENDING_HANDSHAKES = 1_024;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface Principal {
  id: string;
  kind: "peer" | "control";
}

export interface AgentServerOptions extends SkillRegistryOptions {
  controlCredentials?: readonly ControlCredential[];
  controlCredentialsPath?: string;
  port?: number;
  host?: string;
  name?: string;
  description?: string;
  version?: string;
  agentUrl?: string;
  swarmKey?: Uint8Array;
  identity?: PeerIdentity;
  taskStore?: TaskStore;
  /**
   * Bounded state limits, exposed so a test can exercise the bounds without
   * issuing 10,000 requests. Defaults are the documented constants.
   */
  maxReplayEntries?: number;
  maxPendingHandshakes?: number;
  stream?: (
    request: SessionReadRequest,
    options: SessionStreamOptions,
  ) => SessionStream;
  skillRegistry?: SkillRegistry;
  /**
   * The local execution policy (ADR 0008). Defaults to the value of
   * `PI_MESH_ALLOW_SPAWN` when no CLI flag selected it, which is unset by
   * default: nothing executes until a machine says so. Injectable so tests can
   * open and close the gate without
   * mutating the process environment.
   */
  spawnPolicy?: SpawnPolicy;
  jobs?: JobManager;
}

export interface AgentServer {
  readonly server: Server;
  readonly tasks: TaskStore;
  start(): Promise<{ address: string; port: number }>;
  stop(): Promise<void>;
  agentCard(): AgentCard;
}

function isId(value: unknown): value is JsonRpcId {
  return (
    value === null || typeof value === "string" || typeof value === "number"
  );
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function reasonFor(code: number): string | undefined {
  if (code === ErrorCode.Unauthorized) return "PI_MESH_UNAUTHORIZED";
  if (code === ErrorCode.UnknownSession) return "PI_MESH_UNKNOWN_SESSION";
  if (code === ErrorCode.SpawnDenied) return "PI_MESH_SPAWN_DENIED";
  if (code === ErrorCode.SpawnFailed) return "PI_MESH_SPAWN_FAILED";
  if (code === ErrorCode.UnknownJob) return "PI_MESH_UNKNOWN_JOB";
  if (code === ErrorCode.TooManyJobs) return "PI_MESH_TOO_MANY_JOBS";
  // A2A's own errors carry a reason too. The spec makes ErrorInfo a SHOULD for
  // the JSON-RPC binding (a MUST for gRPC and HTTP details), but emitting it
  // only for pi-mesh errors and not for A2A's would be an odd inconsistency,
  // and the reason string is what a peer routes on.
  if (code === A2A_ERROR_CODES.TaskNotFound) return "TASK_NOT_FOUND";
  if (code === A2A_ERROR_CODES.VersionNotSupported) {
    return "VERSION_NOT_SUPPORTED";
  }
  return undefined;
}

/** A2A errors are the interface's, so they are not logged as pi-mesh failures. */
function domainFor(code: number): string {
  return code >= -32099 && code <= -32001 ? "a2a-protocol.org" : "pi-mesh.dev";
}

function errorResponse(id: JsonRpcId, error: unknown): JsonRpcErrorResponse {
  if (error instanceof RpcFailure) {
    return rpcError(id, error.code, error.message);
  }
  if (error instanceof PiMeshError) {
    const reason = reasonFor(error.code);
    return rpcError(
      id,
      error.code,
      error.message,
      reason === undefined
        ? undefined
        : {
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason,
                domain: domainFor(error.code),
              },
            ],
          },
    );
  }
  return rpcError(id, -32603, "Internal error");
}

function messageFrom(
  result: unknown,
  contextId?: string,
  taskId?: string,
): Message {
  return {
    messageId: randomUUID(),
    ...(contextId === undefined ? {} : { contextId }),
    ...(taskId === undefined ? {} : { taskId }),
    role: "ROLE_AGENT",
    parts: [{ data: { result } }],
  };
}

function invocation(message: unknown): {
  skill: string;
  input: unknown;
  contextId?: string;
} {
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    throw new PiMeshError(-32602, "params.message must be an object");
  }
  const value = message as Record<string, unknown>;
  if (value.role !== "ROLE_USER" || !Array.isArray(value.parts)) {
    throw new PiMeshError(-32602, "params.message must be a ROLE_USER message");
  }
  const part = value.parts.find((item): item is Part => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return false;
    return "data" in item;
  });
  if (
    part === undefined ||
    typeof part.data !== "object" ||
    part.data === null ||
    Array.isArray(part.data)
  ) {
    throw new PiMeshError(-32602, "message must contain a skill data part");
  }
  const data = part.data as Record<string, unknown>;
  if (
    typeof data.skill !== "string" ||
    data.skill.length === 0 ||
    !("input" in data)
  ) {
    throw new PiMeshError(-32602, "skill data requires skill and input");
  }
  return {
    skill: data.skill,
    input: data.input,
    ...(typeof value.contextId === "string"
      ? { contextId: value.contextId }
      : {}),
  };
}

function skillInfo(skill: string): AgentSkill {
  return {
    id: skill,
    name: skill,
    description: `Read-only ${skill} skill`,
    tags: ["read-only", "pi-mesh"],
    examples: [],
    inputModes: ["application/json"],
    outputModes: ["application/json"],
    securityRequirements: [],
  };
}

export class HttpAgentServer implements AgentServer {
  readonly server: Server;
  readonly tasks: TaskStore;
  private readonly options: AgentServerOptions;
  private readonly port: number;
  private readonly host: string;
  private readonly skills: SkillRegistry;
  private listening = false;
  private actualPort: number | undefined;
  private swarmKey: Uint8Array | undefined;
  private controlCredentials: readonly ControlCredential[] = [];
  /**
   * Set only when the credentials are file-backed: the absolute path to stat
   * and the mtime it was last loaded at. A pairing runs in a SEPARATE process
   * (`pi-mesh-agent pair`), so without this the server kept verifying against
   * the list it read at startup and rejected a freshly paired control plane
   * until it was restarted (issue #2).
   */
  private controlCredentialsPath: string | undefined;
  private controlCredentialsMtimeMs: number | undefined;
  private identity: PeerIdentity | undefined;
  private readonly replay = new Map<string, number>();
  private readonly maxReplayEntries: number;
  private readonly spawnPolicy: SpawnPolicy;
  private readonly maxPendingHandshakes: number;
  private readonly pendingHandshakes = new Map<
    string,
    { transcript: HandshakeTranscript; expiresAt: number }
  >();

  constructor(options: AgentServerOptions = {}) {
    this.options = options;
    this.port = configuredMeshPort(options.port);
    this.host = options.host ?? "0.0.0.0";
    this.tasks = options.taskStore ?? new TaskStore();
    this.maxReplayEntries = options.maxReplayEntries ?? MAX_REPLAY_ENTRIES;
    this.maxPendingHandshakes =
      options.maxPendingHandshakes ?? MAX_PENDING_HANDSHAKES;
    this.skills = options.skillRegistry ?? createSkillRegistry(options);
    this.spawnPolicy = options.spawnPolicy ?? parseSpawnPolicy();
    if (this.spawnPolicy.warning !== undefined) {
      // stderr, not stdout: the CLI prints machine-readable JSON on stdout, and
      // a rejected policy must be visible - silently denying everything looks
      // like a bug, and silently allowing everything is the failure this
      // feature exists to prevent.
      // Explicit level, not the environment's: PI_MESH_LOG_LEVEL=error would
      // otherwise suppress the one message explaining a fail-closed policy,
      // producing exactly the mystery refusal this warning exists to prevent.
      createLogger({ level: "warn", name: "spawn-policy" }).warn(
        this.spawnPolicy.warning,
      );
    }
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          writeJson(response, 500, errorResponse(null, error));
        } else {
          response.destroy();
        }
      });
    });
  }

  async start(): Promise<{ address: string; port: number }> {
    if (this.listening && this.actualPort !== undefined) {
      return { address: this.host, port: this.actualPort };
    }
    this.swarmKey = this.options.swarmKey ?? (await loadSwarmKey());
    if (this.options.controlCredentials !== undefined) {
      // Injected credentials are the caller's to manage; there is no file to
      // watch and reloading would only undo an intentional override.
      this.controlCredentials = this.options.controlCredentials;
      this.controlCredentialsPath = undefined;
      this.controlCredentialsMtimeMs = undefined;
    } else {
      this.controlCredentialsPath = defaultControlCredentialsPath(
        this.options.controlCredentialsPath,
      );
      this.controlCredentials = await loadControlCredentials({
        path: this.controlCredentialsPath,
      });
      this.controlCredentialsMtimeMs = await controlCredentialsMtime(
        this.controlCredentialsPath,
      );
    }
    if (this.swarmKey.byteLength === 0) {
      throw new Error("A swarm key is required to start the agent");
    }
    this.identity = this.options.identity ?? (await loadOrCreateIdentity());
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    if (address === null || typeof address === "string")
      throw new Error("Server did not expose an address");
    this.actualPort = address.port;
    this.listening = true;
    return { address: this.host, port: address.port };
  }

  async stop(): Promise<void> {
    if (!this.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
      // close() only stops accepting and then waits for existing sockets, so a
      // peer holding an SSE stream open would block this forever and an agent
      // could never be shut down while someone was streaming from it. Ending
      // the sockets here also fires the request 'close' handler, which stops
      // the underlying SessionStream.
      this.server.closeAllConnections();
    });
    this.listening = false;
    this.actualPort = undefined;
  }

  agentCard(): AgentCard {
    const port = this.actualPort ?? this.port;
    const baseUrl = this.options.agentUrl ?? `http://127.0.0.1:${port}`;
    return {
      name: this.options.name ?? this.identity?.name ?? "pi-mesh agent",
      description:
        this.options.description ?? "Read-only Pi session mesh agent",
      supportedInterfaces: [
        {
          url: baseUrl,
          protocolBinding: "JSONRPC",
          tenant: "",
          protocolVersion: A2A_PROTOCOL_VERSION,
        },
      ],
      provider: { url: "https://pi-mesh.dev", organization: "pi-mesh" },
      version: this.options.version ?? "0.0.0",
      documentationUrl: "https://github.com/pi-mesh/pi-mesh",
      capabilities: {
        streaming: true,
        pushNotifications: false,
        extensions: [],
        extendedAgentCard: false,
      },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      // One expression, shared with the mDNS advertisement in cli.ts. This used
      // to read `enabled && skills.has("process.spawn")` while `caps` read
      // `enabled && jobs !== undefined` - different conditions that agreed only
      // because an invariant in two other files made them equivalent. Now that
      // every execution skill is registered unconditionally, the gate alone
      // decides, and the card and `caps` cannot drift apart.
      skills: servedSkills(this.spawnPolicy.enabled).map(skillInfo),
      signatures: [],
      iconUrl: "",
    };
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // The card stays unauthenticated because a peer cannot sign a request
    // before it knows anything about this agent.
    if (request.method === "GET" && request.url === AGENT_CARD_ROUTE) {
      writeJson(response, 200, this.agentCard());
      return;
    }
    if (request.method === "POST" && request.url === "/handshake") {
      await this.handshake(request, response);
      return;
    }
    if (request.method === "POST" && request.url === "/handshake/verify") {
      await this.verifyHandshake(request, response);
      return;
    }
    if (request.method !== "POST" || request.url !== "/") {
      response.writeHead(404).end();
      return;
    }

    const rawBody = await readBody(request);
    let principal = this.verifyRequest(request, rawBody);
    if (principal === undefined && (await this.refreshControlCredentials())) {
      // The first attempt failing is what triggers the stat, so an ordinary
      // swarm or already-paired request does no filesystem access at all. A
      // failed signature is the only thing that does, which also means this
      // cannot be used to reach the file from an unauthenticated request.
      principal = this.verifyRequest(request, rawBody);
    }
    if (principal === undefined) {
      this.unauthorized(response);
      return;
    }

    const version = request.headers[A2A_VERSION_HEADER.toLowerCase()];
    if (version !== A2A_PROTOCOL_VERSION) {
      // The spec is explicit: "If the version is not supported by the
      // interface, agents MUST return a VersionNotSupportedError". That is
      // -32009, not the generic -32600, and the distinction is not cosmetic:
      // a peer routes on the code, and -32600 tells it its request was
      // malformed when in fact the request was fine and the version was not.
      const error = new PiMeshError(
        A2A_ERROR_CODES.VersionNotSupported,
        `Unsupported ${A2A_VERSION_HEADER}; expected ${A2A_PROTOCOL_VERSION}`,
      );
      writeJson(response, 200, errorResponse(null, error));
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      writeJson(response, 200, rpcError(null, -32700, "Parse error"));
      return;
    }
    if (!isRequest(body)) {
      writeJson(response, 200, rpcError(null, -32600, "Invalid Request"));
      return;
    }
    if (body.method === "message/stream") {
      await this.streamMessage(body, principal.id, request, response);
      return;
    }
    try {
      const result = await this.call(body, principal.id);
      // Acknowledge on `finish`, not on a flag read before the write. `finish`
      // never fires for a response whose socket was destroyed (verified: only
      // `close` fires), so it is positive evidence the payload actually left.
      // A pre-write check also passes when the socket dies during the write,
      // which would mark a job delivered that the peer never heard about and
      // exempt it from the reaping deadline - the exact orphan the deadline
      // exists to prevent. The remaining window (accepted by the kernel, never
      // sent) is not closable from here and is why the deadline is best-effort.
      response.once("finish", () => {
        this.options.jobs?.acknowledgeResult(result);
      });
      writeJson(response, 200, { jsonrpc: "2.0", id: body.id, result });
    } catch (error) {
      writeJson(response, 200, errorResponse(body.id, error));
    }
  }

  private unauthorized(response: ServerResponse): void {
    writeJson(
      response,
      200,
      errorResponse(
        null,
        new PiMeshError(ErrorCode.Unauthorized, "Unauthorized"),
      ),
    );
  }

  /**
   * Verify a signed request and return the peer it came from, or undefined if
   * the proof does not hold. The caller needs the identity, not just the
   * verdict: the spawn gate (ADR 0008) is keyed on it.
   */
  /**
   * Re-read the credentials file when it changed under us, so a pairing that
   * completed while this process was running takes effect without a restart.
   * Returns whether the list changed. Never falls back across signer kinds:
   * the caller retries the same verification, with the same signer selection
   * (a known control id still uses that control credential, a swarm peer the
   * swarm key); only the file's contents move.
   */
  private async refreshControlCredentials(): Promise<boolean> {
    const path = this.controlCredentialsPath;
    if (path === undefined) return false;
    const mtimeMs = await controlCredentialsMtime(path);
    if (mtimeMs === this.controlCredentialsMtimeMs) return false;
    this.controlCredentials = await loadControlCredentials({ path });
    this.controlCredentialsMtimeMs = mtimeMs;
    return true;
  }

  private verifyRequest(
    request: IncomingMessage,
    body: Uint8Array,
  ): Principal | undefined {
    const peerId = header(request, PI_MESH_HEADERS.peer);
    const nonce = header(request, PI_MESH_HEADERS.nonce);
    const timestamp = header(request, PI_MESH_HEADERS.timestamp);
    const signature = header(request, PI_MESH_HEADERS.signature);
    if (
      peerId === undefined ||
      nonce === undefined ||
      timestamp === undefined ||
      signature === undefined
    ) {
      return undefined;
    }
    const now = Date.now();
    // Accept against the same value the replay lifetime is derived from, so the
    // acceptance window and the cache entry cannot disagree.
    const accepted = acceptTimestamp(timestamp, new Date(now));
    if (accepted === undefined) return undefined;
    const identity = this.identity;
    if (identity === undefined) return undefined;
    const control = this.controlCredentials.find(
      (entry) => entry.controlId === peerId,
    );
    const key =
      control === undefined ? this.swarmKey : controlCredentialBytes(control);
    if (key === undefined) return undefined;
    if (
      !verifyRequestSignature(
        key,
        {
          method: request.method ?? "",
          path: request.url ?? "/",
          body,
          peerId,
          // Verifying against our OWN peer id is what makes a captured request
          // useless elsewhere: a signature made out to another agent does not
          // verify here, so it cannot be replayed against every member.
          recipientPeerId: identity.peerId,
          nonce,
          timestamp,
        },
        signature,
      )
    ) {
      return undefined;
    }
    this.pruneReplay(now);
    const replayKey = `${peerId}\u0000${nonce}`;
    if (this.replay.has(replayKey)) return undefined;
    // Hard cap: discard the OLDEST INSERTED nonce so an input flood cannot grow
    // memory. That is deliberately not "the entry nearest to expiring": a
    // request dated in the future is retained for longer than one dated in the
    // past, so insertion order and expiry order are not the same. The choice is
    // deterministic and not caller-controlled either way.
    if (this.replay.size >= this.maxReplayEntries) {
      const oldest = this.replay.keys().next().value;
      if (oldest !== undefined) this.replay.delete(oldest);
    }
    // Expire relative to whichever is LATER. A request may legitimately be dated
    // up to the skew tolerance in the future and stays acceptable until that
    // instant plus the window; expiring at receipt-plus-window would leave it
    // replayable after its documented acceptance window had already closed.
    this.replay.set(replayKey, Math.max(accepted, now) + REPLAY_WINDOW_MS);
    return { id: peerId, kind: control === undefined ? "peer" : "control" };
  }

  private pruneReplay(now: number): void {
    for (const [key, expiresAt] of this.replay) {
      if (expiresAt <= now) this.replay.delete(key);
    }
  }

  private async handshake(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse((await readBody(request)).toString("utf8")) as unknown;
    } catch {
      handshakeFailure(response, "invalid_json");
      return;
    }
    const body = handshakeObject(value);
    if (body === undefined) {
      handshakeFailure(response, "invalid_hello");
      return;
    }
    const identity = this.identity;
    const key = this.swarmKey;
    if (identity === undefined || key === undefined) {
      handshakeFailure(response, "unavailable");
      return;
    }
    const now = Date.now();
    this.pruneHandshakes(now);
    const serverNonce = createNonce();
    const transcript: HandshakeTranscript = {
      clientPeerId: body.peer_id,
      clientNonce: body.nonce,
      serverPeerId: identity.peerId,
      serverNonce,
    };
    // Keyed by the SERVER nonce, which the verify POST echoes back, so the
    // lookup below is exact and needs no search. The client nonce must NOT also
    // be accepted as a lookup key: a client that repeats a hello leaves several
    // pending entries sharing one client nonce, and resolving that ambiguity by
    // scanning for the oldest entry made the server validate a proof against a
    // superseded transcript while rejecting the current one.
    // Refuse rather than evict. This route carries no proof, so evicting the
    // oldest pending hello would let an unauthenticated flood displace the one a
    // legitimate peer is about to verify. Nothing is issued either way, so a
    // refusal is cheap to retry.
    if (this.pendingHandshakes.size >= this.maxPendingHandshakes) {
      handshakeFailure(response, "too_many_pending_handshakes", 503);
      return;
    }
    this.pendingHandshakes.set(handshakeKey(body.peer_id, serverNonce), {
      transcript,
      expiresAt: now + REPLAY_WINDOW_MS,
    });
    writeJson(response, 200, {
      peer_id: identity.peerId,
      nonce: serverNonce,
      hmac: computeHandshakeHmac(key, encodeTranscript(transcript)),
    });
  }

  private async verifyHandshake(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse((await readBody(request)).toString("utf8")) as unknown;
    } catch {
      handshakeFailure(response, "invalid_json");
      return;
    }
    const body = handshakeObject(value);
    const identity = this.identity;
    const key = this.swarmKey;
    if (body === undefined || identity === undefined || key === undefined) {
      handshakeFailure(response, "invalid_proof");
      return;
    }
    this.pruneHandshakes(Date.now());
    // Exact lookup, no scan. The client nonce is deliberately not accepted
    // here: it cannot identify a single pending handshake once a client repeats
    // a hello, and the scan that used to paper over that matched whichever
    // entry came first. Echo the SERVER nonce instead.
    const pendingKey = handshakeKey(body.peer_id, body.nonce);
    const pending = this.pendingHandshakes.get(pendingKey);
    if (
      pending === undefined ||
      !verifyHandshakeHmac(key, body.hmac, encodeTranscript(pending.transcript))
    ) {
      handshakeFailure(response, "invalid_proof");
      return;
    }
    this.pendingHandshakes.delete(pendingKey);
    writeJson(response, 200, { ok: true });
  }

  private pruneHandshakes(now: number): void {
    for (const [key, pending] of this.pendingHandshakes) {
      if (pending.expiresAt <= now) this.pendingHandshakes.delete(key);
    }
  }

  /**
   * The single execution gate (ADR 0008). Every dispatch path must call this
   * before touching a skill: `message/send` and `message/stream` are separate
   * routes, and a gate present in only one of them is a bypass waiting for the
   * day a gated skill becomes streamable.
   *
   * Gated only when the skill is actually served, because the two refusals mean
   * different things: -32102 says "this agent does it, but not for you", while
   * -32004 says "this agent does not do it at all". Reporting a spawn denial
   * for a skill that was never implemented would be a lie, and a peer routes on
   * the code.
   */
  private gateExecution(skill: string, peerId: string): void {
    if (!this.skills.has(skill)) return;
    assertExecutionAllowed(this.spawnPolicy, peerId, skill);
  }

  private async call(
    request: JsonRpcRequest,
    peerId: string,
  ): Promise<unknown> {
    if (request.method === "message/send") {
      const call = invocation(objectParams(request.params).message);
      this.gateExecution(call.skill, peerId);
      const inputWithPeer =
        typeof call.input === "object" &&
        call.input !== null &&
        !Array.isArray(call.input)
          ? {
              ...(call.input as Record<string, unknown>),
              _peerId: peerId,
              _localPeerId: this.identity?.peerId,
            }
          : call.input;
      if (call.skill === "mesh.handoff") {
        const task = this.tasks.create(
          call.contextId === undefined ? {} : { contextId: call.contextId },
        );
        try {
          const outcome = await this.skills.invoke(call.skill, inputWithPeer);
          if (
            typeof outcome !== "object" ||
            outcome === null ||
            Array.isArray(outcome) ||
            typeof (outcome as { accepted?: unknown }).accepted !== "boolean"
          ) {
            throw new Error("mesh.handoff returned an invalid outcome");
          }
          if (!(outcome as { accepted: boolean }).accepted) {
            return {
              task: this.tasks.update(task.id, "TASK_STATE_REJECTED"),
            };
          }
          const handoffResult = (outcome as { result?: unknown }).result;
          const handles =
            typeof handoffResult === "object" &&
            handoffResult !== null &&
            !Array.isArray(handoffResult)
              ? (handoffResult as {
                  session_id?: unknown;
                  job_id?: unknown;
                })
              : {};
          const result = {
            task_id: task.id,
            session_id: handles.session_id,
            job_id: handles.job_id,
          };
          const statusMessage = messageFrom(result, call.contextId, task.id);
          return {
            task: this.tasks.update(
              task.id,
              "TASK_STATE_WORKING",
              statusMessage,
            ),
          };
        } catch (error) {
          this.tasks.delete(task.id);
          throw error;
        }
      }
      const result = await this.skills.invoke(call.skill, inputWithPeer);
      return { message: messageFrom(result, call.contextId) };
    }
    if (request.method === "tasks/get") {
      const params = objectParams(request.params);
      const taskId = params.id;
      if (typeof taskId !== "string")
        throw new PiMeshError(-32602, "Invalid params");
      const task = this.tasks.get(taskId);
      if (task === undefined) throw new PiMeshError(-32001, "Task not found");
      return task;
    }
    if (request.method === "tasks/cancel") {
      const params = objectParams(request.params);
      const taskId = params.id;
      if (typeof taskId !== "string")
        throw new PiMeshError(-32602, "Invalid params");
      const task = this.tasks.cancel(taskId);
      if (task === undefined) throw new PiMeshError(-32001, "Task not found");
      return task;
    }
    throw new RpcFailure(-32601, "Method not found");
  }

  private async streamMessage(
    request: JsonRpcRequest,
    peerId: string,
    incoming: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const call = invocation(objectParams(request.params).message);
      // The same gate as message/send: this is a second dispatch path, and
      // gating only one of them would leave a silence hole the moment a gated
      // skill becomes streamable.
      this.gateExecution(call.skill, peerId);
      if (call.skill !== "session.stream")
        throw new RpcFailure(
          -32004,
          "Streaming is only supported by session.stream",
        );
      const input = call.input;
      if (
        typeof input !== "object" ||
        input === null ||
        Array.isArray(input) ||
        typeof (input as Record<string, unknown>).id !== "string"
      ) {
        throw new PiMeshError(-32602, "session.stream requires input.id");
      }
      const id = (input as Record<string, unknown>).id as string;
      const task = this.tasks.create(
        call.contextId === undefined ? {} : { contextId: call.contextId },
      );
      const live = this.options.jobs?.liveStream(id);
      const iterator =
        (live as AsyncIterableIterator<LiveStreamEvent> | undefined) ??
        (this.options.stream ?? sessionStream)({ id }, this.options);
      let closed = false;
      const stop = (): void => {
        closed = true;
        if ("stop" in iterator && typeof iterator.stop === "function")
          void iterator.stop();
        else void iterator.return?.();
      };
      incoming.once("aborted", stop);
      response.once("close", stop);
      response.writeHead(200, {
        "A2A-Version": A2A_PROTOCOL_VERSION,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      writeSse(response, { task });
      for (;;) {
        const next = await iterator.next();
        if (closed || next.done) break;
        const event: StreamResponse = {
          message: messageFrom(
            (next.value as { data: unknown }).data,
            call.contextId,
            task.id,
          ),
        };
        writeSse(response, event);
      }
      if (!closed) {
        this.tasks.update(task.id, "TASK_STATE_COMPLETED");
        response.end();
      }
    } catch (error) {
      if (!response.headersSent)
        writeJson(response, 200, errorResponse(request.id, error));
      else response.destroy();
    }
  }
}

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function objectParams(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new PiMeshError(-32602, "Invalid params");
  return value as Record<string, unknown>;
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const request = value as Record<string, unknown>;
  return (
    request.jsonrpc === "2.0" &&
    isId(request.id) &&
    typeof request.method === "string"
  );
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        reject(new PiMeshError(-32600, "Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

type HandshakeBody = {
  peer_id: string;
  nonce: string;
  hmac?: unknown;
};

function handshakeObject(value: unknown): HandshakeBody | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.peer_id !== "string" ||
    typeof body.nonce !== "string" ||
    body.peer_id.length === 0 ||
    body.nonce.length === 0 ||
    body.peer_id.includes("\u0000") ||
    body.nonce.includes("\u0000")
  ) {
    return undefined;
  }
  return {
    peer_id: body.peer_id,
    nonce: body.nonce,
    ...("hmac" in body ? { hmac: body.hmac } : {}),
  };
}

function handshakeKey(peerId: string, nonce: string): string {
  return `${peerId}\u0000${nonce}`;
}

function handshakeFailure(
  response: ServerResponse,
  reason: string,
  status = 401,
): void {
  writeJson(response, status, { error: reason });
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "A2A-Version": A2A_PROTOCOL_VERSION,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

/**
 * The credentials file's mtime, or undefined when it does not exist yet - the
 * normal state before the first pairing. "Missing" and "present" therefore
 * compare unequal, so the first pairing is noticed as a change.
 */
async function controlCredentialsMtime(
  path: string,
): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
}

function writeSse(
  response: ServerResponse,
  value: StreamResponse | { task: unknown },
): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

export function createAgentServer(
  options: AgentServerOptions = {},
): AgentServer {
  return new HttpAgentServer(options);
}

export async function startAgentServer(
  options: AgentServerOptions = {},
): Promise<AgentServer> {
  const server = createAgentServer(options);
  await server.start();
  return server;
}
