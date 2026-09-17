// SPDX-License-Identifier: GPL-3.0-or-later

import type { CONTROL_TXT_KEYS, MESH_TXT_KEYS } from "./constants.js";

export type Skill =
  | "session.list"
  | "session.read"
  | "session.stream"
  | "session.steer"
  | "session.abort"
  | "process.spawn"
  | "process.stop"
  | "mesh.peers"
  | "mesh.handoff";

export interface AgentSkill {
  id: Skill;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  skills: AgentSkill[];
  protocolVersion?: string;
  capabilities?: AgentCapabilities;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  provider?: AgentProvider;
  documentationUrl?: string;
  iconUrl?: string;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface AgentProvider {
  organization: string;
  url?: string;
}

export interface ControlTxtRecord {
  id: string;
  name: string;
  version: string;
  api_version: string;
  port: string;
  fp: string;
}

export interface MeshTxtRecord {
  id: string;
  name: string;
  version: string;
  agent_version: string;
  port: string;
  fp: string;
  caps: string;
}

export type ControlServiceTxtRecord = ControlTxtRecord;
export type MeshServiceTxtRecord = MeshTxtRecord;

export type ControlTxtKey = (typeof CONTROL_TXT_KEYS)[number];
export type MeshTxtKey = (typeof MESH_TXT_KEYS)[number];

export interface SessionSummary {
  id: string;
  project: string;
  status: string;
  started_at?: string;
  ended_at?: string;
}

export interface Event {
  seq: number;
  type: string;
  timestamp: string;
  data: unknown;
}

export interface PeerSummary {
  id: string;
  name: string;
  host: string;
  port: number;
  skills: Skill[];
  fingerprint?: string;
}

export interface HandoffPayload {
  task: string;
  project: string;
  context: Record<string, unknown>;
  preferred_agent: string | null;
  deadline_ms: number;
}

/** Wire shapes for GET /handshake, per docs/PROTOCOL.md. */
export interface HandshakeRequest {
  peer_id: string;
  nonce: string;
}

export interface HandshakeResponse {
  peer_id: string;
  nonce: string;
  hmac: string;
}

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<
  Method extends string = string,
  Params = unknown,
> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: Method;
  params: Params;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse<Result = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: Result;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcError;
}

export type JsonRpcResponse<Result = unknown> =
  | JsonRpcSuccessResponse<Result>
  | JsonRpcErrorResponse;

export type MessageRole = "user" | "agent";

export interface TextPart {
  kind: "text";
  text: string;
}

export interface FilePart {
  kind: "file";
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string;
    uri?: string;
  };
}

export interface DataPart {
  kind: "data";
  data: Record<string, unknown>;
}

export type MessagePart = TextPart | FilePart | DataPart;

export interface Message {
  role: MessageRole;
  parts: MessagePart[];
  messageId?: string;
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskStatus {
  state: string;
  message?: Message;
  timestamp?: string;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: MessagePart[];
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  contextId?: string;
  status: TaskStatus;
  history?: Message[];
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

export interface SendMessageConfiguration {
  acceptedOutputModes?: string[];
  historyLength?: number;
  returnImmediately?: boolean;
  pushNotificationConfig?: Record<string, unknown>;
}

export interface MessageSendParams {
  message: Message;
  configuration?: SendMessageConfiguration;
  metadata?: Record<string, unknown>;
}

export type MessageSendResult = Task | Message;

export type MessageSendRequest = JsonRpcRequest<
  "message/send",
  MessageSendParams
>;

export type MessageSendResponse = JsonRpcResponse<MessageSendResult>;

export type MessageStreamParams = MessageSendParams;

export interface TaskStatusUpdateEvent {
  id: string;
  status: TaskStatus;
  final?: boolean;
}

export interface TaskArtifactUpdateEvent {
  id: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
}

export type MessageStreamResult =
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent
  | Message;

export type MessageStreamRequest = JsonRpcRequest<
  "message/stream",
  MessageStreamParams
>;

export type MessageStreamResponse = JsonRpcResponse<MessageStreamResult>;

export interface TaskGetParams {
  id: string;
  historyLength?: number;
  metadata?: Record<string, unknown>;
}

export type TaskGetResult = Task;
export type TaskGetRequest = JsonRpcRequest<"tasks/get", TaskGetParams>;
export type TaskGetResponse = JsonRpcResponse<TaskGetResult>;

export interface TaskCancelParams {
  id: string;
  metadata?: Record<string, unknown>;
}

export type TaskCancelResult = Task;
export type TaskCancelRequest = JsonRpcRequest<
  "tasks/cancel",
  TaskCancelParams
>;
export type TaskCancelResponse = JsonRpcResponse<TaskCancelResult>;
