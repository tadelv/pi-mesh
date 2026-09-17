// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
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
} from "@pi-mesh/protocol";
import { ErrorCode, PiMeshError } from "@pi-mesh/shared";
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

const DEFAULT_PORT = 7330;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface AgentServerOptions extends SkillRegistryOptions {
  port?: number;
  host?: string;
  name?: string;
  description?: string;
  version?: string;
  agentUrl?: string;
  authorize?: (request: IncomingMessage) => boolean;
  taskStore?: TaskStore;
  stream?: (
    request: SessionReadRequest,
    options: SessionStreamOptions,
  ) => SessionStream;
  skillRegistry?: SkillRegistry;
}

export interface AgentServer {
  readonly server: Server;
  readonly tasks: TaskStore;
  start(): Promise<{ address: string; port: number }>;
  stop(): Promise<void>;
  agentCard(): AgentCard;
}

function configuredPort(value: number | undefined): number {
  const port = value ?? Number(process.env.PI_MESH_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }
  return port;
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

  constructor(options: AgentServerOptions = {}) {
    this.options = options;
    this.port = configuredPort(options.port);
    this.host = options.host ?? "0.0.0.0";
    this.tasks = options.taskStore ?? new TaskStore();
    this.skills = options.skillRegistry ?? createSkillRegistry(options);
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
    });
    this.listening = false;
    this.actualPort = undefined;
  }

  agentCard(): AgentCard {
    const port = this.actualPort ?? this.port;
    const baseUrl = this.options.agentUrl ?? `http://127.0.0.1:${port}`;
    return {
      name: this.options.name ?? "pi-mesh agent",
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
      skills: servedSkills().map(skillInfo),
      signatures: [],
      iconUrl: "",
    };
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method === "GET" && request.url === AGENT_CARD_ROUTE) {
      if (
        this.options.authorize !== undefined &&
        !this.options.authorize(request)
      ) {
        response.writeHead(401).end();
        return;
      }
      writeJson(response, 200, this.agentCard());
      return;
    }
    if (request.method !== "POST" || request.url !== "/") {
      response.writeHead(404).end();
      return;
    }
    if (
      this.options.authorize !== undefined &&
      !this.options.authorize(request)
    ) {
      writeJson(
        response,
        200,
        errorResponse(
          null,
          new PiMeshError(ErrorCode.Unauthorized, "Unauthorized"),
        ),
      );
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
      body = JSON.parse(await readBody(request)) as unknown;
    } catch {
      writeJson(response, 200, rpcError(null, -32700, "Parse error"));
      return;
    }
    if (!isRequest(body)) {
      writeJson(response, 200, rpcError(null, -32600, "Invalid Request"));
      return;
    }
    if (body.method === "message/stream") {
      await this.streamMessage(body, request, response);
      return;
    }
    try {
      const result = await this.call(body);
      writeJson(response, 200, { jsonrpc: "2.0", id: body.id, result });
    } catch (error) {
      writeJson(response, 200, errorResponse(body.id, error));
    }
  }

  private async call(request: JsonRpcRequest): Promise<unknown> {
    if (request.method === "message/send") {
      const call = invocation(objectParams(request.params).message);
      const result = await this.skills.invoke(call.skill, call.input);
      return messageFrom(result, call.contextId);
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
    incoming: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const call = invocation(objectParams(request.params).message);
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
      const iterator = (this.options.stream ?? sessionStream)(
        { id },
        this.options,
      );
      let closed = false;
      const stop = (): void => {
        closed = true;
        void iterator.stop();
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

function readBody(request: IncomingMessage): Promise<string> {
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
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
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
