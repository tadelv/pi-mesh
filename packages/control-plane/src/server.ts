// SPDX-License-Identifier: GPL-3.0-or-later

import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { configuredMeshPort } from "@pi-mesh/shared";
import { ControlStore, type PairedAgent } from "./db.js";
import { PairingService } from "./pairing.js";
import {
  AgentSkillError,
  AgentUnreachableError,
  callAgent,
  fetchAgentCard,
  fetchSessionList,
} from "./client.js";
import { dashboard } from "./dashboard.js";
import { agentControls } from "./controls.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface ControlServerOptions {
  store: ControlStore;
  pairing?: PairingService;
  port?: number;
  host?: string;
  name?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /**
   * Serve the execution routes to a plaintext, non-loopback request. Off by
   * default; the deliberate override from ADR 0014 decision 3.
   */
  allowInsecureExecution?: boolean;
  /**
   * What counts as a confidential request. Injected only so a test can produce
   * a non-confidential caller, which a loopback test server otherwise cannot.
   */
  confidential?: (request: IncomingMessage) => boolean;
}
export interface ControlServer {
  readonly server: Server;
  start(): Promise<{ address: string; port: number }>;
  stop(): Promise<void>;
  dashboardUrl(host?: string): string;
}

export function createControlServer(
  options: ControlServerOptions,
): ControlServer {
  const { store } = options;
  const host = options.host ?? "0.0.0.0";
  const port = configuredMeshPort(options.port);
  const name = store.controlName(options.name ?? hostname());
  const pairing =
    options.pairing ??
    new PairingService({
      controlId: store.controlId(),
      controlName: name,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  let actualPort = port;
  const agentCaps = new Map<string, string[]>();
  const confidential = options.confidential ?? isConfidential;
  const allowInsecure = options.allowInsecureExecution === true;

  const server = createServer((request, response) => {
    void route(request, response).catch(() =>
      json(response, 500, { error: "internal_error" }),
    );
  });

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      // No token in the URL and no cookie: the page asks the operator for the
      // token once and keeps it in localStorage (ADR 0014 decision 2). Removing
      // it from here is what keeps it out of browser history, referrers and
      // server logs.
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(dashboard);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (
        !authorized(
          request,
          url.searchParams.get("token"),
          store.dashboardToken(),
        )
      ) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        json(response, 200, {
          control: { id: store.controlId(), name },
          // Never the credential. It is a signing key for the agents; a
          // dashboard-token holder is an operator, not a mesh member, and must
          // not be able to read sessions by calling agents directly. The
          // browser needs the identity and address, nothing more.
          agents: store.listAgents().map((agent) => {
            const skills = agentCaps.get(agent.peer_id) ?? null;
            return {
              ...publicAgent(agent),
              skills,
              controls: agentControls(skills),
            };
          }),
          sessions: store.listSessions(),
          jobs: store.listJobs(),
          // Computed from THIS request, so the page can explain a refused
          // button instead of looking broken. See ADR 0014 decision 6.
          execution_transport: confidential(request)
            ? "confidential"
            : allowInsecure
              ? "insecure_override"
              : "refused",
        });
        return;
      }
      const executionMatch =
        /^\/api\/agents\/([^/]+)\/(spawn|steer|stop|abort)$/.exec(url.pathname);
      if (request.method === "POST" && executionMatch !== null) {
        // The one thing a plaintext LAN observer must not be able to
        // originate. This credential is reusable, the mesh's is not (ADR 0007),
        // and the browser cannot sign without a secure origin - so there is no
        // plaintext path to execution. Refuse before reading the body: a
        // refused request does no work and reaches no agent. ADR 0014.
        if (!confidential(request) && !allowInsecure) {
          json(response, 403, {
            error: "confidential_transport_required",
            message:
              "Dashboard execution needs a confidential connection (TLS or loopback). Terminate TLS in front of the control plane, or set PI_MESH_ALLOW_INSECURE_EXECUTION=1 on a LAN you trust.",
          });
          return;
        }
        const body = await readJson(request, true);
        if (
          body === INVALID ||
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body)
        ) {
          json(response, 400, { error: "invalid_input" });
          return;
        }
        let peerId: string;
        try {
          peerId = decodeURIComponent(executionMatch[1]!);
        } catch {
          json(response, 400, { error: "invalid_input" });
          return;
        }
        const agent = store.getAgent(peerId);
        if (agent === undefined) {
          json(response, 404, { error: "unknown_agent" });
          return;
        }
        const action = executionMatch[2]!;
        const skill = {
          spawn: "process.spawn",
          steer: "session.steer",
          stop: "process.stop",
          abort: "session.abort",
        }[action]!;
        try {
          const result = await callAgent<Record<string, unknown>>(
            {
              peerId: agent.peer_id,
              host: agent.host,
              port: agent.port,
              credential: agent.credential,
            },
            skill,
            body,
            {
              controlId: store.controlId(),
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            },
          );
          // A defined-but-wrong result must not reach the field reads below:
          // an inner `result: null` would otherwise throw a TypeError and turn
          // into a 500 instead of the pinned 502.
          if (
            result === null ||
            typeof result !== "object" ||
            Array.isArray(result)
          ) {
            throw new AgentUnreachableError(
              `Agent returned a malformed ${skill} result`,
            );
          }
          if (
            action === "spawn" &&
            (typeof result.job_id !== "string" ||
              typeof result.session_id !== "string" ||
              (typeof result.pid !== "number" && result.pid !== null))
          ) {
            throw new AgentUnreachableError(
              "Agent returned a malformed process.spawn result",
            );
          }
          if (
            action === "stop" &&
            (typeof result.state !== "string" ||
              typeof result.job_id !== "string" ||
              (typeof result.pid !== "number" && result.pid !== null))
          ) {
            throw new AgentUnreachableError(
              "Agent returned a malformed process.stop result",
            );
          }
          if (action === "spawn") {
            const spawn = body as { project: string };
            store.upsertJob({
              agent_id: agent.peer_id,
              job_id: result.job_id as string,
              session_id:
                (result.session_id as string | null | undefined) ?? null,
              pid: (result.pid as number | null | undefined) ?? null,
              project: spawn.project,
              created_at: new Date((options.now ?? Date.now)()).toISOString(),
              state: "running",
            });
          } else if (action === "stop") {
            store.setJobState(
              agent.peer_id,
              (body as { job_id: string }).job_id,
              result.state as string,
            );
          }
          json(response, 200, { ok: true, result });
        } catch (error) {
          if (error instanceof AgentSkillError) {
            json(response, 200, {
              ok: false,
              code: error.code,
              message: error.message,
            });
          } else if (error instanceof AgentUnreachableError) {
            json(response, 502, {
              error: "agent_unreachable",
              message: error.message,
            });
          } else {
            throw error;
          }
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/pair/token") {
        const body = await readJson(request);
        if (body === INVALID) {
          json(response, 400, { error: "invalid_json" });
          return;
        }
        json(response, 200, pairing.issue());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/sync") {
        const body = await readJson(request);
        if (body === INVALID) {
          json(response, 400, { error: "invalid_json" });
          return;
        }
        const results = await Promise.all(
          store.listAgents().map(async (agent) => {
            const target = {
              peerId: agent.peer_id,
              host: agent.host,
              port: agent.port,
              credential: agent.credential,
            };
            const callOptions = {
              controlId: store.controlId(),
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            };
            const card = await fetchAgentCard(target, callOptions);
            if (card === undefined) agentCaps.delete(agent.peer_id);
            else agentCaps.set(agent.peer_id, card.skills);
            try {
              const sessions = await fetchSessionList(target, callOptions);
              store.upsertSessions(
                agent.peer_id,
                sessions,
                new Date((options.now ?? Date.now)()).toISOString(),
              );
              return {
                peer_id: agent.peer_id,
                ok: true as const,
                count: sessions.length,
              };
            } catch (error) {
              return {
                peer_id: agent.peer_id,
                ok: false as const,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }),
        );
        json(response, 200, { results });
        return;
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && sessionMatch !== null) {
        let agentId: string, sessionId: string;
        try {
          agentId = decodeURIComponent(sessionMatch[1]!);
          sessionId = decodeURIComponent(sessionMatch[2]!);
        } catch {
          json(response, 400, { error: "invalid_path" });
          return;
        }
        const agent = store.getAgent(agentId);
        if (agent === undefined) {
          json(response, 404, { error: "unknown_agent" });
          return;
        }
        let stale = false;
        try {
          const result = await callAgent<{
            entries: import("@pi-mesh/protocol").Event[];
          }>(
            {
              peerId: agent.peer_id,
              host: agent.host,
              port: agent.port,
              credential: agent.credential,
            },
            "session.read",
            { id: sessionId },
            {
              controlId: store.controlId(),
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            },
          );
          store.upsertEvents(agent.peer_id, sessionId, result.entries);
        } catch {
          stale = true;
        }
        json(response, 200, {
          events: store.listEvents(agentId, sessionId),
          stale,
        });
        return;
      }
    }
    if (
      request.method === "POST" &&
      (url.pathname === "/pair/hello" || url.pathname === "/pair/verify")
    ) {
      const body = await readJson(request);
      if (body === INVALID) {
        json(response, 400, { error: "invalid_json" });
        return;
      }
      if (url.pathname === "/pair/hello") {
        const result = pairing.hello(
          body,
          request.socket.remoteAddress ?? undefined,
        );
        json(response, result.status, result.body);
      } else {
        const result = pairing.verify(body);
        if (result.paired !== undefined)
          store.upsertAgent({
            peer_id: result.paired.agentId,
            name: result.paired.agentName,
            // The address is the one the hello arrived at, not this POST's:
            // verify is the forgeable one, so its source cannot be trusted.
            host:
              result.paired.agentHost ??
              request.socket.remoteAddress ??
              "127.0.0.1",
            port: result.paired.agentPort,
            credential: result.paired.credential,
            paired_at: result.paired.pairedAt,
          });
        json(response, result.status, result.body);
      }
      return;
    }
    json(response, 404, { error: "not_found" });
  }

  return {
    server,
    async start() {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Server did not expose an address");
      actualPort = address.port;
      return { address: host, port: actualPort };
    },
    async stop() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
        // close() waits for existing sockets, so a keep-alive client would
        // block shutdown forever. Ending them here is the same fix the agent
        // listener uses; it must run alongside close(), not after it.
        server.closeAllConnections();
      });
    },
    dashboardUrl(urlHost = "127.0.0.1") {
      // Deliberately no token. It is read with `pi-mesh-control-plane token`
      // or `serve --print-token` and pasted into the page (ADR 0014 decision 2).
      return `http://${urlHost}:${actualPort}/`;
    },
  };
}

/**
 * A request that did not cross the network in the clear: TLS-terminated here,
 * or dialed over loopback (which includes a TLS proxy on this host). ADR 0014.
 */
function isConfidential(request: IncomingMessage): boolean {
  // `encrypted` exists on TLS sockets; Node's type for a plain Socket omits it,
  // so this is the one place the two are distinguished.
  if ((request.socket as { encrypted?: boolean }).encrypted === true)
    return true;
  return isLoopback(request.socket.remoteAddress);
}

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  return (
    address === "::1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

const INVALID = Symbol("invalid-json");

/**
 * The projection of a paired agent the browser receives. Explicit rather than a
 * delete or a rest-destructure, so adding a secret column later cannot ride
 * along unnoticed: a new field must be added here on purpose.
 */
function publicAgent(agent: PairedAgent): Omit<PairedAgent, "credential"> {
  return {
    peer_id: agent.peer_id,
    name: agent.name,
    host: agent.host,
    port: agent.port,
    paired_at: agent.paired_at,
  };
}

async function readJson(
  request: IncomingMessage,
  emptyInvalid = false,
): Promise<unknown | typeof INVALID> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) return INVALID;
    chunks.push(bytes);
  }
  if (length === 0) return emptyInvalid ? INVALID : {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return INVALID;
  }
}
function authorized(
  request: IncomingMessage,
  queryToken: string | null,
  expected: string,
): boolean {
  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
  const header = request.headers["x-pi-mesh-ui"];
  const cookieHeader = request.headers.cookie;
  const cookie = cookieHeader
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("pi_mesh_ui="))
    ?.slice("pi_mesh_ui=".length);
  const candidates = [
    bearer,
    typeof header === "string" ? header : undefined,
    queryToken ?? undefined,
    cookie === undefined ? undefined : decodeURIComponentSafe(cookie),
  ].filter((value): value is string => value !== undefined);
  return candidates.some((candidate) => {
    const a = Buffer.from(candidate),
      b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}
