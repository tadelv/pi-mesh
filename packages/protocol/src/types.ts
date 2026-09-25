// SPDX-License-Identifier: GPL-3.0-or-later

import type { CONTROL_TXT_KEYS, MESH_TXT_KEYS } from "./constants.js";

export type Skill =
  | "session.list"
  | "session.read"
  | "session.stream"
  | "session.steer"
  | "session.resume"
  | "session.models"
  | "session.set_model"
  | "session.abort"
  | "process.spawn"
  | "process.list"
  | "process.stop"
  | "mesh.peers"
  | "mesh.handoff";

export interface ControlTxtRecord {
  id: string;
  name: string;
  version: string;
  api_version: string;
  port: string;
}

export interface MeshTxtRecord {
  id: string;
  name: string;
  version: string;
  agent_version: string;
  port: string;
  caps: string;
}

export type ControlServiceTxtRecord = ControlTxtRecord;
export type MeshServiceTxtRecord = MeshTxtRecord;

export type ControlTxtKey = (typeof CONTROL_TXT_KEYS)[number];
export type MeshTxtKey = (typeof MESH_TXT_KEYS)[number];

export interface SessionSummary {
  /** Public session ID: the session-file header UUID. */
  id: string;
  /** Derived from the session header's working directory. */
  project: string;
  /** Display name from a session_info entry, when the session has one. */
  name?: string;
  /** Header timestamp. */
  started_at: string;
  /**
   * Timestamp of the last entry: last activity, not an end time. Named
   * updated_at deliberately, because Pi's session format records no lifecycle
   * state - there is no `status` and no `ended_at` here, and inventing either
   * would ship a field that looks like data and carries none (the reason the
   * `fp` TXT key was removed in ADR 0006).
   */
  updated_at: string;
}

export interface Event {
  /**
   * Pi's durable entry ID, and the replay cursor. Deliberately a string: Pi
   * appends entries with string IDs and there is no numeric sequence to
   * resume from. Named entryId rather than id so it is not confused with a
   * session ID.
   */
  entryId: string;
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
  /**
   * Removed from v1 discovery: M0 advertised a constant "unpaired", which
   * looks like data and verifies nothing. Returns when it has verification
   * semantics (ADR 0006).
   */
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
  JsonRpcSuccessResponse<Result> | JsonRpcErrorResponse;

export type Role = "ROLE_UNSPECIFIED" | "ROLE_USER" | "ROLE_AGENT";
export type MessageRole = Role;

export type TaskState =
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED";

export interface AgentInterface {
  url: string;
  protocolBinding: string;
  tenant?: string;
  protocolVersion: string;
}

export interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: AgentInterface[];
  provider?: AgentProvider;
  version: string;
  documentationUrl?: string;
  capabilities: AgentCapabilities;
  securitySchemes?: Record<string, SecurityScheme>;
  securityRequirements?: SecurityRequirement[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  signatures?: AgentCardSignature[];
  iconUrl?: string;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: AgentExtension[];
  extendedAgentCard?: boolean;
}

export interface AgentProvider {
  url: string;
  organization: string;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  securityRequirements?: SecurityRequirement[];
}

export interface SecurityRequirement {
  schemes: Record<string, StringList>;
}

export interface StringList {
  list: string[];
}

export type SecurityScheme = Record<string, unknown>;
export type AgentExtension = {
  uri: string;
  description: string;
  required: boolean;
  params?: Record<string, unknown>;
};
export type AgentCardSignature = {
  protected: string;
  signature: string;
  header?: Record<string, unknown>;
};

export interface Part {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
  filename?: string;
  mediaType?: string;
}

export type MessagePart = Part;

export interface Message {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: Role;
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp?: string;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

export interface Task {
  id: string;
  contextId?: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

export interface SendMessageConfiguration {
  acceptedOutputModes?: string[];
  taskPushNotificationConfig?: Record<string, unknown>;
  historyLength?: number;
  // A2A v1.0.1 spells this field return_immediately; it is not blocking.
  returnImmediately?: boolean;
}

export interface MessageSendParams {
  tenant?: string;
  message: Message;
  configuration?: SendMessageConfiguration;
  metadata?: Record<string, unknown>;
}

export interface MessageSendResult {
  task?: Task;
  message?: Message;
}

export type MessageSendRequest = JsonRpcRequest<
  "message/send",
  MessageSendParams
>;

export type MessageSendResponse = JsonRpcResponse<MessageSendResult>;

export type MessageStreamParams = MessageSendParams;

export interface TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: TaskStatus;
  metadata?: Record<string, unknown>;
}

export interface TaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

export interface StreamResponse {
  task?: Task;
  message?: Message;
  statusUpdate?: TaskStatusUpdateEvent;
  artifactUpdate?: TaskArtifactUpdateEvent;
}

export type MessageStreamResult = StreamResponse;

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
