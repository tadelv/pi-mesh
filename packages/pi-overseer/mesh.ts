// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Mesh tool - lets a Pi session act as a delegator instead of leaving that
 * to the dashboard: discover peers, hand one task to a chosen peer, keep the
 * returned handles, then follow, steer or stop the work.
 *
 * Reuse, not invention (ADR 0021 decision 5): this module opens no listener
 * and serves no route. Every action speaks to the local agent over loopback
 * through the agent's own authenticated client (`sendSkill` plus the
 * credential loaders in `@pi-mesh/agent`), and from there to whichever peer
 * the session chose - using only skills the peer already serves. No HTTP or
 * HMAC code lives here, and no credential file is read by hand.
 *
 * Two limits are stated, not discovered:
 * - a handoff addressed at loopback starts work on THIS machine, and the
 *   success text says so rather than presenting it as remote delegation;
 * - a peer refusal (for example -32102 when the destination has execution
 *   closed) is a result carrying the agent's own code, never a throw and
 *   never swallowed into "ok".
 *
 * With no agent credential on this machine every action refuses with a
 * stated reason before any request is constructed. The tool never prints
 * key material, signatures or file contents.
 */

import {
  loadOrCreateIdentity,
  loadSwarmKey,
  sendSkill as agentSendSkill,
  type PeerIdentity,
  type PeerRecord,
} from "@pi-mesh/agent";

export const MESH_ACTIONS = [
  "peers",
  "handoff",
  "follow",
  "steer",
  "stop",
] as const;
export type MeshAction = (typeof MESH_ACTIONS)[number];

export function isMeshAction(value: unknown): value is MeshAction {
  return (
    value === "peers" ||
    value === "handoff" ||
    value === "follow" ||
    value === "steer" ||
    value === "stop"
  );
}

export interface MeshActionParams {
  action: string;
  peer?: string;
  task?: string;
  project?: string;
  context?: Record<string, unknown>;
  session?: string;
  job?: string;
  message?: string;
  since?: string;
}

export interface MeshToolDetails {
  action: string;
  ok: boolean;
  refused?: boolean;
  unavailable?: boolean;
  declined?: boolean;
  loopback?: boolean;
  code?: number;
  peer?: string;
  peers?: { id: string; name: string }[];
  taskId?: string;
  sessionId?: string;
  jobId?: string;
  entries?: number;
  state?: string;
}

export interface MeshToolResult {
  content: [{ type: "text"; text: string }];
  details: MeshToolDetails;
  isError?: boolean;
}

export interface MeshCredentials {
  identity: PeerIdentity;
  swarmKey: Uint8Array;
}

/**
 * The seam the tests stub so no test touches the network. The default
 * implementation is the shipped client path: the agent's own loaders and
 * `sendSkill`, signed, over loopback for fleet reads.
 */
export interface MeshDeps {
  loadCredentials(): Promise<MeshCredentials>;
  localPort(): number;
  sendSkill(
    peer: PeerRecord,
    skill: string,
    input: unknown,
    options: MeshCredentials,
  ): Promise<unknown>;
}

export function defaultMeshDeps(): MeshDeps {
  return {
    async loadCredentials(): Promise<MeshCredentials> {
      const [identity, swarmKey] = await Promise.all([
        loadOrCreateIdentity(),
        loadSwarmKey(),
      ]);
      return { identity, swarmKey };
    },
    localPort(): number {
      return resolveLocalPort();
    },
    sendSkill(peer, skill, input, options): Promise<unknown> {
      return agentSendSkill(peer, skill, input, options);
    },
  };
}

/** The loopback port of the local agent. Mirrors the agent's own default. */
export function resolveLocalPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PI_MESH_PORT;
  if (raw === undefined || raw.trim() === "") return 7330;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 7330;
  return port;
}

const HANDOFF_DEADLINE_MS = 60_000;
const STEER_MAX_BYTES = 4096;

const UNAVAILABLE_REASON =
  "no pi-mesh agent credential on this machine (no identity or swarm key could be loaded, so no agent is installed here); " +
  "mesh actions are unavailable and nothing was sent. Local oversight is unaffected.";

function fail(
  action: string,
  text: string,
  extra?: Partial<MeshToolDetails>,
): MeshToolResult {
  return {
    content: [{ type: "text", text }],
    details: { action, ok: false, ...extra },
    isError: true,
  };
}

/** A peer refusal is a result: the agent's own code travels with its message. */
function refusal(
  action: string,
  peerLabel: string,
  code: number,
  message: string,
  extra?: Partial<MeshToolDetails>,
): MeshToolResult {
  return {
    content: [
      {
        type: "text",
        text: `refused by ${peerLabel} (code ${code}): ${message}`,
      },
    ],
    details: { action, ok: false, refused: true, code, ...extra },
    isError: true,
  };
}

function codeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "localhost"
  );
}

function localPeerRecord(creds: MeshCredentials, port: number): PeerRecord {
  return {
    id: creds.identity.peerId,
    name: creds.identity.name,
    serviceType: "mesh",
    host: "127.0.0.1",
    port,
    txt: {},
    lastSeen: Date.now(),
  };
}

interface KnownPeer {
  id: string;
  name: string;
  host: string;
  port: number;
}

function toPeerRecord(known: KnownPeer): PeerRecord {
  return {
    id: known.id,
    name: known.name,
    serviceType: "mesh",
    host: known.host,
    port: known.port,
    txt: {},
    lastSeen: Date.now(),
  };
}

function parsePeers(value: unknown): KnownPeer[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const peers = (value as { peers?: unknown }).peers;
  if (!Array.isArray(peers)) return undefined;
  const out: KnownPeer[] = [];
  for (const entry of peers) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return undefined;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0)
      return undefined;
    if (typeof record.host !== "string" || record.host.length === 0)
      return undefined;
    if (typeof record.port !== "number" || !Number.isInteger(record.port))
      return undefined;
    out.push({
      id: record.id,
      name: typeof record.name === "string" ? record.name : record.id,
      host: record.host,
      port: record.port,
    });
  }
  return out;
}

interface ResolvedPeer {
  peer: PeerRecord;
  name: string;
  loopback: boolean;
}

/**
 * Resolve a chosen peer id to an address. The fleet is read from the local
 * agent over loopback; a peer id equal to our own identity short-circuits
 * to loopback without a lookup.
 */
async function resolvePeer(
  deps: MeshDeps,
  creds: MeshCredentials,
  peerId: string,
): Promise<{ resolved: ResolvedPeer } | { result: MeshToolResult }> {
  const local = localPeerRecord(creds, deps.localPort());
  if (peerId === creds.identity.peerId) {
    return {
      resolved: { peer: local, name: creds.identity.name, loopback: true },
    };
  }
  let listing: unknown;
  try {
    listing = await deps.sendSkill(local, "mesh.peers", {}, creds);
  } catch (error) {
    const code = codeOf(error);
    if (code !== undefined)
      return {
        result: refusal("peers", "local agent", code, messageOf(error)),
      };
    return {
      result: fail(
        "peers",
        `could not reach the local agent over loopback: ${messageOf(error)}`,
      ),
    };
  }
  const peers = parsePeers(listing);
  if (peers === undefined) {
    return {
      result: fail(
        "peers",
        "the local agent returned an unrecognised peers reply",
      ),
    };
  }
  const found = peers.find((entry) => entry.id === peerId);
  if (found === undefined) {
    const known = peers.length
      ? peers.map((entry) => entry.id).join(", ")
      : "none discovered";
    return {
      result: fail(
        "peers",
        `unknown peer '${peerId}' (${peers.length} known: ${known}); use action "peers" to choose one. Nothing was sent to '${peerId}'.`,
      ),
    };
  }
  return {
    resolved: {
      peer: toPeerRecord(found),
      name: found.name,
      loopback: isLoopbackHost(found.host),
    },
  };
}

async function peersAction(
  deps: MeshDeps,
  creds: MeshCredentials,
): Promise<MeshToolResult> {
  const local = localPeerRecord(creds, deps.localPort());
  let result: unknown;
  try {
    result = await deps.sendSkill(local, "mesh.peers", {}, creds);
  } catch (error) {
    const code = codeOf(error);
    if (code !== undefined)
      return refusal("peers", "local agent", code, messageOf(error));
    return fail(
      "peers",
      `could not reach the local agent over loopback: ${messageOf(error)}`,
    );
  }
  const peers = parsePeers(result);
  if (peers === undefined) {
    return fail(
      "peers",
      "the local agent returned an unrecognised peers reply",
    );
  }
  const text = peers.length
    ? `${peers.length} peer(s):\n${peers.map((entry) => `• ${entry.name} ${entry.id}`).join("\n")}`
    : "no peers discovered (is the swarm key shared and are other agents running?)";
  return {
    content: [{ type: "text", text }],
    details: {
      action: "peers",
      ok: true,
      peers: peers.map((entry) => ({ id: entry.id, name: entry.name })),
    },
  };
}

interface HandoffHandles {
  taskId: string;
  sessionId: string;
  jobId: string;
}

function parseHandoffTask(
  value: unknown,
): { declined: true } | { handles: HandoffHandles } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const status = (value as { status?: unknown }).status;
  if (typeof status !== "object" || status === null || Array.isArray(status))
    return undefined;
  const state = (status as { state?: unknown }).state;
  if (state === "TASK_STATE_REJECTED") return { declined: true };
  const message = (status as { message?: unknown }).message;
  if (typeof message !== "object" || message === null || Array.isArray(message))
    return undefined;
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    if (typeof part !== "object" || part === null || Array.isArray(part))
      continue;
    const data = (part as { data?: unknown }).data;
    if (typeof data !== "object" || data === null || Array.isArray(data))
      continue;
    const result = (data as { result?: unknown }).result;
    if (typeof result !== "object" || result === null || Array.isArray(result))
      continue;
    const handles = result as Record<string, unknown>;
    if (
      typeof handles.task_id === "string" &&
      handles.task_id.length > 0 &&
      typeof handles.session_id === "string" &&
      handles.session_id.length > 0 &&
      typeof handles.job_id === "string" &&
      handles.job_id.length > 0
    ) {
      return {
        handles: {
          taskId: handles.task_id,
          sessionId: handles.session_id,
          jobId: handles.job_id,
        },
      };
    }
  }
  return undefined;
}

async function handoffAction(
  deps: MeshDeps,
  creds: MeshCredentials,
  params: MeshActionParams,
): Promise<MeshToolResult> {
  const peerId = (params.peer ?? "").trim();
  if (!peerId) {
    return fail(
      "handoff",
      'handoff requires peer (a peer id from action "peers"); nothing was sent.',
    );
  }
  const task = (params.task ?? "").trim();
  if (!task)
    return fail(
      "handoff",
      "handoff requires a non-blank task; nothing was sent.",
    );
  const project = (params.project ?? "").trim();
  if (!project)
    return fail(
      "handoff",
      "handoff requires a non-blank project; nothing was sent.",
    );
  const context = params.context ?? {};
  if (
    typeof context !== "object" ||
    context === null ||
    Array.isArray(context)
  ) {
    return fail(
      "handoff",
      "handoff context must be an object; nothing was sent.",
    );
  }
  const outcome = await resolvePeer(deps, creds, peerId);
  if ("result" in outcome) {
    if (outcome.result.details.action === "peers") {
      outcome.result.details.action = "handoff";
      outcome.result.content[0].text = outcome.result.content[0].text.replace(
        /^unknown peer/,
        "handoff refused: unknown peer",
      );
    }
    return outcome.result;
  }
  const { peer, name, loopback } = outcome.resolved;
  let result: unknown;
  try {
    result = await deps.sendSkill(
      peer,
      "mesh.handoff",
      {
        task,
        project,
        context,
        preferred_agent: null,
        deadline_ms: HANDOFF_DEADLINE_MS,
      },
      creds,
    );
  } catch (error) {
    const code = codeOf(error);
    if (code !== undefined) {
      return refusal(
        "handoff",
        `${name} (${shortId(peer.id)})`,
        code,
        messageOf(error),
        {
          peer: peer.id,
        },
      );
    }
    return fail(
      "handoff",
      `handoff to ${name} (${shortId(peer.id)}) failed: ${messageOf(error)}`,
      {
        peer: peer.id,
      },
    );
  }
  const parsed = parseHandoffTask(result);
  if (parsed === undefined) {
    return fail(
      "handoff",
      `handoff to ${name} (${shortId(peer.id)}) returned an unrecognised reply`,
      {
        peer: peer.id,
      },
    );
  }
  if ("declined" in parsed) {
    return {
      content: [
        {
          type: "text",
          text: `handoff declined by ${name} (${shortId(peer.id)}): rejected, nothing started.`,
        },
      ],
      details: { action: "handoff", ok: false, declined: true, peer: peer.id },
      isError: true,
    };
  }
  const localNote = loopback
    ? " Note: the destination is loopback, so this work started on this machine, not on a remote peer."
    : "";
  return {
    content: [
      {
        type: "text",
        text:
          `handed off to ${name} (${peer.id}): task ${parsed.handles.taskId} ` +
          `session ${parsed.handles.sessionId} job ${parsed.handles.jobId}.${localNote}`,
      },
    ],
    details: {
      action: "handoff",
      ok: true,
      peer: peer.id,
      taskId: parsed.handles.taskId,
      sessionId: parsed.handles.sessionId,
      jobId: parsed.handles.jobId,
      loopback,
    },
  };
}

function parseEntries(value: unknown): unknown[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const entries = (value as { entries?: unknown }).entries;
  return Array.isArray(entries) ? entries : undefined;
}

function entryCursor(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    return undefined;
  const cursor = (entry as { entryId?: unknown }).entryId;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

async function followAction(
  deps: MeshDeps,
  creds: MeshCredentials,
  params: MeshActionParams,
): Promise<MeshToolResult> {
  const peerId = (params.peer ?? "").trim();
  if (!peerId)
    return fail(
      "follow",
      'follow requires peer (a peer id from action "peers"); nothing was sent.',
    );
  const sessionId = (params.session ?? "").trim();
  if (!sessionId)
    return fail(
      "follow",
      "follow requires session (a session id from a handoff); nothing was sent.",
    );
  const outcome = await resolvePeer(deps, creds, peerId);
  if ("result" in outcome) {
    if (outcome.result.details.action === "peers")
      outcome.result.details.action = "follow";
    return outcome.result;
  }
  const { peer, name } = outcome.resolved;
  let result: unknown;
  try {
    result = await deps.sendSkill(
      peer,
      "session.read",
      {
        id: sessionId,
        ...(params.since !== undefined && params.since !== ""
          ? { since: params.since }
          : {}),
      },
      creds,
    );
  } catch (error) {
    const code = codeOf(error);
    if (code !== undefined) {
      return refusal(
        "follow",
        `${name} (${shortId(peer.id)})`,
        code,
        messageOf(error),
        {
          peer: peer.id,
          sessionId,
        },
      );
    }
    return fail(
      "follow",
      `follow on ${name} (${shortId(peer.id)}) failed: ${messageOf(error)}`,
      {
        peer: peer.id,
        sessionId,
      },
    );
  }
  const entries = parseEntries(result);
  if (entries === undefined) {
    return fail(
      "follow",
      `follow on ${name} (${shortId(peer.id)}) returned an unrecognised reply`,
      {
        peer: peer.id,
        sessionId,
      },
    );
  }
  const last = entries.length ? entries[entries.length - 1] : undefined;
  const cursor = last === undefined ? undefined : entryCursor(last);
  const noun = entries.length === 1 ? "entry" : "entries";
  return {
    content: [
      {
        type: "text",
        text:
          `session ${shortId(sessionId)} on ${name}: ${entries.length} ${noun}.` +
          (cursor !== undefined ? ` Resume with since: "${cursor}".` : ""),
      },
    ],
    details: {
      action: "follow",
      ok: true,
      peer: peer.id,
      sessionId,
      entries: entries.length,
    },
  };
}

async function steerAction(
  deps: MeshDeps,
  creds: MeshCredentials,
  params: MeshActionParams,
): Promise<MeshToolResult> {
  const peerId = (params.peer ?? "").trim();
  if (!peerId)
    return fail(
      "steer",
      'steer requires peer (a peer id from action "peers"); nothing was sent.',
    );
  const jobId = (params.job ?? "").trim();
  if (!jobId)
    return fail(
      "steer",
      "steer requires job (a job id from a handoff); nothing was sent.",
    );
  const message = params.message ?? "";
  if (!message.trim())
    return fail(
      "steer",
      "steer requires a non-blank message; nothing was sent.",
    );
  if (Buffer.byteLength(message, "utf8") > STEER_MAX_BYTES) {
    return fail(
      "steer",
      `steer message exceeds ${STEER_MAX_BYTES} UTF-8 bytes; nothing was sent.`,
    );
  }
  const outcome = await resolvePeer(deps, creds, peerId);
  if ("result" in outcome) {
    if (outcome.result.details.action === "peers")
      outcome.result.details.action = "steer";
    return outcome.result;
  }
  const { peer, name } = outcome.resolved;
  try {
    await deps.sendSkill(
      peer,
      "session.steer",
      { job_id: jobId, message },
      creds,
    );
  } catch (error) {
    const code = codeOf(error);
    if (code !== undefined) {
      return refusal(
        "steer",
        `${name} (${shortId(peer.id)})`,
        code,
        messageOf(error),
        {
          peer: peer.id,
          jobId,
        },
      );
    }
    return fail(
      "steer",
      `steer on ${name} (${shortId(peer.id)}) failed: ${messageOf(error)}`,
      {
        peer: peer.id,
        jobId,
      },
    );
  }
  return {
    content: [
      {
        type: "text",
        text: `steer accepted by ${name} for job ${shortId(jobId)}.`,
      },
    ],
    details: { action: "steer", ok: true, peer: peer.id, jobId },
  };
}

async function stopAction(
  deps: MeshDeps,
  creds: MeshCredentials,
  params: MeshActionParams,
): Promise<MeshToolResult> {
  const peerId = (params.peer ?? "").trim();
  if (!peerId)
    return fail(
      "stop",
      'stop requires peer (a peer id from action "peers"); nothing was sent.',
    );
  const jobId = (params.job ?? "").trim();
  if (!jobId)
    return fail(
      "stop",
      "stop requires job (a job id from a handoff); nothing was sent.",
    );
  const outcome = await resolvePeer(deps, creds, peerId);
  if ("result" in outcome) {
    if (outcome.result.details.action === "peers")
      outcome.result.details.action = "stop";
    return outcome.result;
  }
  const { peer, name } = outcome.resolved;
  let result: unknown;
  try {
    result = await deps.sendSkill(
      peer,
      "process.stop",
      { job_id: jobId },
      creds,
    );
  } catch (error) {
    const code = codeOf(error);
    if (code !== undefined) {
      return refusal(
        "stop",
        `${name} (${shortId(peer.id)})`,
        code,
        messageOf(error),
        {
          peer: peer.id,
          jobId,
        },
      );
    }
    return fail(
      "stop",
      `stop on ${name} (${shortId(peer.id)}) failed: ${messageOf(error)}`,
      {
        peer: peer.id,
        jobId,
      },
    );
  }
  const state =
    typeof result === "object" && result !== null && !Array.isArray(result)
      ? (result as { state?: unknown }).state
      : undefined;
  return {
    content: [
      {
        type: "text",
        text: `stop accepted by ${name} for job ${shortId(jobId)}${typeof state === "string" ? ` (state ${state})` : ""}.`,
      },
    ],
    details: {
      action: "stop",
      ok: true,
      peer: peer.id,
      jobId,
      ...(typeof state === "string" ? { state } : {}),
    },
  };
}

/**
 * Run one mesh action. Credential loading comes first: when no identity or
 * swarm key can be loaded the action refuses with a stated reason and no
 * request is constructed. A peer's JSON-RPC refusal surfaces as a result
 * carrying its code, never as a throw and never as "ok".
 */
export async function executeMeshAction(
  params: MeshActionParams,
  deps: MeshDeps = defaultMeshDeps(),
): Promise<MeshToolResult> {
  const action = params.action;
  if (!isMeshAction(action)) {
    return fail(
      action,
      `unknown mesh action '${action}'; use one of ${MESH_ACTIONS.join(" | ")}.`,
    );
  }
  let creds: MeshCredentials;
  try {
    creds = await deps.loadCredentials();
  } catch {
    return {
      content: [
        {
          type: "text",
          text: `mesh ${action} unavailable: ${UNAVAILABLE_REASON}`,
        },
      ],
      details: { action, ok: false, unavailable: true },
      isError: true,
    };
  }
  switch (action) {
    case "peers":
      return peersAction(deps, creds);
    case "handoff":
      return handoffAction(deps, creds, params);
    case "follow":
      return followAction(deps, creds, params);
    case "steer":
      return steerAction(deps, creds, params);
    case "stop":
      return stopAction(deps, creds, params);
  }
}
