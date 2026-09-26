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
import { dashboardHtml } from "./dashboard.js";
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
  /**
   * Where to read the dashboard markup from. The dev server points this at
   * src/dashboard.html so editing the page is a browser refresh, no rebuild.
   * Defaults to the compiled next-to-dist read in dashboard.ts.
   */
  dashboardHtml?: () => string;
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
  const jobsSyncedAt = new Map<string, number>();
  /**
   * Monotonic counters, deliberately NOT wall-clock. A write and a listing can
   * land in the same millisecond, and a clock can move backwards; comparing
   * timestamps then lets an older answer overwrite a newer one and be labelled
   * fresh. `jobsWrites` counts this control plane's own writes to an agent's
   * rows; `jobsListingSettled` records the newest completed attempt, including
   * failures, so an older success cannot undo a newer failure's withdrawal.
   */
  const jobsWrites = new Map<string, number>();
  const jobsListingSettled = new Map<string, number>();
  let jobsListingSeq = 0;
  const confidential = options.confidential ?? isConfidential;
  const allowInsecure = options.allowInsecureExecution === true;
  const serveDashboard = options.dashboardHtml ?? dashboardHtml;

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
      response.end(serveDashboard());
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
              jobs_synced_at: jobsSyncedAt.get(agent.peer_id) ?? null,
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
      const readMatch =
        /^\/api\/agents\/([^/]+)\/(models|commands|status)$/.exec(url.pathname);
      if (request.method === "GET" && readMatch !== null) {
        let peerId: string;
        try {
          peerId = decodeURIComponent(readMatch[1]!);
        } catch {
          json(response, 400, { error: "invalid_input" });
          return;
        }
        const kind = readMatch[2]!;
        const skill =
          kind === "commands"
            ? "session.commands"
            : kind === "status"
              ? "session.status"
              : "session.models";
        // Commands and status belong to one running Pi process, so the caller
        // must name it (ADR 0017/0016). The agent enforces the same rule; a
        // missing parameter is refused here rather than spent as a round trip.
        const jobId = url.searchParams.get("job_id");
        if (
          (kind === "commands" || kind === "status") &&
          (jobId === null || jobId === "")
        ) {
          json(response, 400, { error: "invalid_input" });
          return;
        }
        const agent = store.getAgent(peerId);
        if (agent === undefined) {
          json(response, 404, { error: "unknown_agent" });
          return;
        }
        try {
          const result = await callAgent<Record<string, unknown>>(
            {
              peerId: agent.peer_id,
              host: agent.host,
              port: agent.port,
              credential: agent.credential,
            },
            skill,
            jobId === null ? {} : { job_id: jobId },
            {
              controlId: store.controlId(),
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            },
          );
          if (kind === "status") {
            // A status is one object, not a list.
            if (
              typeof result !== "object" ||
              result === null ||
              Array.isArray(result)
            )
              throw new AgentUnreachableError(
                "Agent returned a malformed session.status result",
              );
            json(response, 200, result);
            return;
          }
          const list = result?.[kind];
          if (!Array.isArray(list))
            throw new AgentUnreachableError(
              `Agent returned a malformed ${skill} result`,
            );
          json(response, 200, { [kind]: list });
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
      const executionMatch =
        /^\/api\/agents\/([^/]+)\/(spawn|resume|steer|stop|abort|setmodel)$/.exec(
          url.pathname,
        );
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
          resume: "session.resume",
          steer: "session.steer",
          stop: "process.stop",
          abort: "session.abort",
          setmodel: "session.set_model",
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
            action === "resume" &&
            (typeof result.job_id !== "string" ||
              typeof result.session_id !== "string" ||
              result.session_id !==
                (body as { session_id?: unknown }).session_id ||
              (typeof result.pid !== "number" && result.pid !== null))
          ) {
            throw new AgentUnreachableError(
              "Agent returned a malformed session.resume result",
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
          let wroteJobs = false;
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
            wroteJobs = true;
          } else if (action === "resume") {
            // The agent started a job the mirror has not listed yet. Even without
            // a local row write, the confirmed listing is now obsolete.
            wroteJobs = true;
          } else if (action === "stop") {
            // A stop for a job this cache has never seen updates no row, so it is
            // not a write and must not withdraw the freshness claim.
            wroteJobs = store.setJobState(
              agent.peer_id,
              (body as { job_id: string }).job_id,
              result.state as string,
            );
          }
          // Spawn and resume change the agent's job table; a local stop changes
          // a cached row. None leaves the last confirmed listing authoritative.
          // Steer and abort do not change the job list.
          if (wroteJobs) {
            jobsWrites.set(
              agent.peer_id,
              (jobsWrites.get(agent.peer_id) ?? 0) + 1,
            );
            jobsSyncedAt.delete(agent.peer_id);
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
            // One sequence number per agent per sync, taken BEFORE the card is
            // fetched, so every path below - including a card that never arrives
            // and a listing that fails - is ordered against the others. Without
            // this an older sync that failed would erase the mark a newer sync
            // had just established, and the label would say "cached" about rows
            // that are exactly the agent's list.
            const sequence = ++jobsListingSeq;
            const superseded = (): boolean =>
              (jobsListingSettled.get(agent.peer_id) ?? 0) > sequence;
            // NOTE: capabilities are deliberately NOT ordered by `sequence`, only
            // the jobs mirror is. An older sync's card can therefore overwrite or
            // clear a newer one's for a moment, showing stale controls until the
            // next sync. It cannot authorise anything - the agent's own gate and
            // ADR 0014's transport check both still apply - and ordering it means
            // one sequence governing every per-agent write, which is a refactor
            // rather than a line. Recorded here because it is the same class of
            // bug as the three the reviews found, and the next reader will be
            // standing in this exact spot.
            const card = await fetchAgentCard(target, callOptions);
            if (card === undefined) agentCaps.delete(agent.peer_id);
            else agentCaps.set(agent.peer_id, card.skills);
            if (card?.skills.includes("process.list")) {
              const writesAtStart = jobsWrites.get(agent.peer_id) ?? 0;
              try {
                const result = await callAgent<{
                  jobs: Array<{
                    job_id: string;
                    session_id: string | null;
                    pid: number | null;
                    project: string;
                    state: string;
                    started_at: string;
                  }>;
                }>(target, "process.list", {}, callOptions);
                // Two ways this answer can be stale: a row was written while the
                // listing was in flight, or a later listing has already applied.
                // Neither may overwrite the newer state, and neither withdraws a
                // freshness claim that a newer listing established.
                const overtakenByWrite =
                  (jobsWrites.get(agent.peer_id) ?? 0) !== writesAtStart;
                if (!superseded()) {
                  if (!overtakenByWrite) {
                    store.replaceJobs(
                      agent.peer_id,
                      result.jobs.map((job) => ({
                        job_id: job.job_id,
                        session_id: job.session_id,
                        pid: job.pid,
                        project: job.project,
                        created_at: job.started_at,
                        state: job.state,
                      })),
                    );
                    jobsSyncedAt.set(
                      agent.peer_id,
                      (options.now ?? Date.now)(),
                    );
                  }
                  jobsListingSettled.set(agent.peer_id, sequence);
                }
              } catch {
                // A failure withdraws freshness and supersedes older attempts.
                // The cached rows themselves are untouched.
                if (!superseded()) {
                  jobsSyncedAt.delete(agent.peer_id);
                  jobsListingSettled.set(agent.peer_id, sequence);
                }
              }
            } else if (!superseded()) {
              // Without a process.list capability the cache is not a confirmed
              // mirror; this also supersedes any older in-flight listing.
              jobsSyncedAt.delete(agent.peer_id);
              jobsListingSettled.set(agent.peer_id, sequence);
            }
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
        const all = url.searchParams.get("all");
        const before = url.searchParams.get("before") ?? undefined;
        const tailParam = url.searchParams.get("tail");
        const tail = tailParam === null ? 200 : Number(tailParam);
        if (
          (all !== null && all !== "1") ||
          !Number.isInteger(tail) ||
          tail < 1 ||
          tail > 1000
        ) {
          json(response, 400, { error: "invalid_query" });
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
        const total = store.countEvents(agentId, sessionId);
        const page =
          all === "1"
            ? {
                events: store.listEvents(agentId, sessionId),
                hasEarlier: false,
              }
            : store.listEventPage(agentId, sessionId, tail, before);
        json(response, 200, {
          ...page,
          total,
          all: all === "1",
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
