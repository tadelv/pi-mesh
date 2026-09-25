// SPDX-License-Identifier: GPL-3.0-or-later

import type { PeerSummary, Skill } from "@pi-mesh/protocol";
import { isAbsolute, join } from "node:path";
import { ErrorCode, PiMeshError } from "@pi-mesh/shared";
import { PeerRegistry } from "./registry.js";
import { SessionStore, type SessionStoreOptions } from "./sessions.js";
import { JobStartTimeoutError, type JobManager } from "./jobs.js";
import { assertInsideWorkspace, resolveWorkspaceRoot } from "./spawner.js";

export type SkillInput = Record<string, unknown>;
export type SkillHandler = (input: SkillInput) => Promise<unknown>;

export interface SkillRegistryOptions extends SessionStoreOptions {
  registry?: PeerRegistry;
  jobs?: JobManager;
  workspaceRoot?: string;
}

export const ALWAYS_SERVED_SKILLS: readonly Skill[] = [
  "mesh.peers",
  "session.list",
  "session.read",
  "session.stream",
];

export const JOB_SKILLS: readonly Skill[] = [
  "process.list",
  "process.stop",
  "session.abort",
];

/**
 * Skills that start or steer work, and so require the local spawn policy
 * (ADR 0008). This is the one list the dispatch gate reads, so a skill cannot
 * be named in the gate and forgotten here.
 *
 * Stopping skills are deliberately absent: reducing activity is never the more
 * dangerous operation, so `session.abort` and `process.stop` are allowed to any
 * member (ADR 0008 decision 5).
 */
export const EXECUTION_SKILLS: readonly Skill[] = [
  "process.spawn",
  "session.steer",
  "mesh.handoff",
];

/**
 * Every skill the protocol defines: the union of the two lists above.
 *
 * This, not `SERVED_SKILLS`, is the type guard for a *remote* peer's advertised
 * `caps`. A peer that has enabled execution advertises `process.spawn`,
 * `session.steer` and `mesh.handoff`, and `mesh.peers` is a report of what each
 * peer says it can serve - routing is the caller's job (ADR 0010), so the caller
 * needs the honest set. Filtering a remote advertisement through the local
 * ungated list deleted exactly the capabilities a caller routes on, while a
 * gate-closed peer still omits them because it never advertised them (issue #3).
 * Unknown future strings stay rejected until the protocol understands them.
 */
const KNOWN_SKILLS: readonly string[] = [
  ...ALWAYS_SERVED_SKILLS,
  ...JOB_SKILLS,
  ...EXECUTION_SKILLS,
];

function objectInput(value: unknown): SkillInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PiMeshError(-32602, "Skill input must be an object");
  }
  return value as SkillInput;
}

function requiredString(input: SkillInput, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PiMeshError(-32602, `Skill input requires string ${key}`);
  }
  return value;
}

function peerSummaries(registry: PeerRegistry): PeerSummary[] {
  return registry.peers.map((peer) => {
    const skills = (peer.txt.caps ?? "")
      .split(",")
      .filter((skill): skill is Skill => KNOWN_SKILLS.includes(skill));
    return {
      id: peer.id,
      name: peer.name,
      host: peer.host,
      port: peer.port,
      skills,
    };
  });
}

export class SkillRegistry {
  private readonly handlers = new Map<Skill, SkillHandler>();

  register(skill: Skill, handler: SkillHandler): this {
    // The other direction of drift from registerExecution. `EXECUTION_SKILLS`
    // stops the gate guarding a skill that is not served; this stops a skill
    // that executes from being served without the gate. Making both omissions
    // a startup error is what turns the invariant into code instead of memory.
    if ((EXECUTION_SKILLS as readonly string[]).includes(skill)) {
      throw new Error(
        `Skill ${skill} starts or steers work; register it with registerExecution so it meets the spawn gate`,
      );
    }
    return this.registerUngated(skill, handler);
  }

  /**
   * Register a skill that starts or steers work (ADR 0008).
   *
   * Use this rather than `register` for any handler that can spawn or steer;
   * `register` refuses those skills outright, so the gate cannot be skipped by
   * picking the wrong method.
   */
  registerExecution(skill: Skill, handler: SkillHandler): this {
    if (!(EXECUTION_SKILLS as readonly string[]).includes(skill)) {
      throw new Error(
        `Skill ${skill} does not start or steer work, so it is not in EXECUTION_SKILLS and must use register`,
      );
    }
    return this.registerUngated(skill, handler);
  }

  private registerUngated(skill: Skill, handler: SkillHandler): this {
    this.handlers.set(skill, handler);
    return this;
  }

  has(skill: string): skill is Skill {
    return this.handlers.has(skill as Skill);
  }

  list(): Skill[] {
    return [...this.handlers.keys()];
  }

  async invoke(skill: string, input: unknown): Promise<unknown> {
    const handler = this.handlers.get(skill as Skill);
    if (handler === undefined) {
      throw new PiMeshError(-32004, `Skill is not supported: ${skill}`);
    }
    return handler(objectInput(input));
  }
}

export function createSkillRegistry(
  options: SkillRegistryOptions = {},
): SkillRegistry {
  const sessions = new SessionStore(options);
  const registry = options.registry ?? new PeerRegistry();
  const skills = new SkillRegistry();

  // Registered UNCONDITIONALLY, exactly like session.steer - and that is
  // load-bearing, not a style choice. The gate can only report "execution is
  // disabled on this machine" (-32102) for a skill it can SEE; registering
  // process.spawn only when a job manager exists (which is only when the gate
  // is already open) meant a gate-closed machine answered -32004 "not supported
  // at all" instead. That contradicts the M2 exit criterion ("a machine with no
  // opt-in refuses execution with -32102") and left the two gated skills
  // disagreeing on the one thing a peer routes on. Measured on devpi:
  // session.steer -32102, process.spawn -32004, same machine, same moment.
  // -32004 remains correct for a skill that is genuinely not implemented.
  skills.registerExecution("process.spawn", async (input) => {
    const jobs = options.jobs;
    const project = input.project;
    if (typeof project !== "string" || project.trim().length === 0) {
      throw new PiMeshError(
        -32602,
        "process.spawn requires a non-blank project",
      );
    }
    if (input.cwd !== undefined && typeof input.cwd !== "string") {
      throw new PiMeshError(-32602, "process.spawn cwd must be a string");
    }
    const prompt = input.prompt;
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new PiMeshError(
        -32602,
        "process.spawn requires a non-blank prompt",
      );
    }
    if (jobs === undefined) {
      throw new PiMeshError(-32004, "process.spawn requires a job manager");
    }
    let root: string;
    try {
      root = resolveWorkspaceRoot(options.workspaceRoot);
    } catch (error) {
      throw new PiMeshError(
        ErrorCode.SpawnDenied,
        `process.spawn refused: workspace root is unusable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    let cwd: string;
    try {
      // A relative cwd resolves against the workspace ROOT, never against the
      // agent's incidental process.cwd(): `realpathSync("sub")` would resolve
      // against whatever directory the daemon was started in, so a legitimate
      // request would be refused - or worse, silently point somewhere
      // unrelated. The root is an accident guard and project selector, not a
      // sandbox; `..` is still caught by the realpath check inside.
      const requested = input.cwd ?? root;
      cwd = assertInsideWorkspace(
        root,
        isAbsolute(requested) ? requested : join(root, requested),
      );
    } catch (error) {
      throw new PiMeshError(
        ErrorCode.SpawnDenied,
        `process.spawn refused: cwd is outside the workspace accident guard (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const deadlineMs = input._acceptanceDeadlineMs;
    const deadlineAt =
      typeof deadlineMs === "number" ? Date.now() + deadlineMs : undefined;
    let record;
    try {
      const remaining =
        deadlineAt === undefined
          ? undefined
          : Math.max(0, deadlineAt - Date.now());
      record = await jobs.startReady(
        {
          peerId:
            typeof input._peerId === "string" ? input._peerId : "unknown-peer",
          project,
          cwd,
          name: project,
        },
        remaining,
      );
    } catch (error) {
      if (error instanceof JobStartTimeoutError) throw error;
      if (error instanceof PiMeshError) throw error;
      throw new PiMeshError(
        ErrorCode.SpawnFailed,
        `process.spawn failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (record.sessionId === undefined) {
      throw new PiMeshError(
        ErrorCode.SpawnFailed,
        "process.spawn failed: Pi did not report a session id",
      );
    }
    try {
      // Pi answers when the prompt is accepted, not when its turn finishes;
      // events continue streaming asynchronously so the peer can steer it.
      const response = await sendBeforeDeadline(
        jobs,
        record.id,
        { type: "prompt", message: prompt },
        deadlineAt,
      );
      if (response.success === false) {
        throw new Error(
          typeof response.error === "string"
            ? response.error
            : "Pi refused the prompt",
        );
      }
    } catch (error) {
      await jobs.stop(record.id).catch(() => undefined);
      if (error instanceof JobStartTimeoutError) throw error;
      throw new PiMeshError(
        ErrorCode.SpawnFailed,
        `process.spawn failed: prompt was not accepted (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }
    return {
      job_id: record.id,
      pid: record.pid,
      session_id: record.sessionId,
    };
  });

  skills.registerExecution("mesh.handoff", async (input) => {
    const task = input.task;
    if (typeof task !== "string" || task.trim().length === 0) {
      throw new PiMeshError(-32602, "mesh.handoff requires a non-blank task");
    }
    const project = input.project;
    if (typeof project !== "string" || project.trim().length === 0) {
      throw new PiMeshError(
        -32602,
        "mesh.handoff requires a non-blank project",
      );
    }
    const context = input.context;
    if (
      typeof context !== "object" ||
      context === null ||
      Array.isArray(context)
    ) {
      throw new PiMeshError(-32602, "mesh.handoff context must be an object");
    }
    const preferredAgent = input.preferred_agent;
    if (preferredAgent !== null && typeof preferredAgent !== "string") {
      throw new PiMeshError(
        -32602,
        "mesh.handoff preferred_agent must be a peer id or null",
      );
    }
    const deadlineMs = input.deadline_ms;
    if (
      typeof deadlineMs !== "number" ||
      !Number.isInteger(deadlineMs) ||
      deadlineMs < 0
    ) {
      throw new PiMeshError(
        -32602,
        "mesh.handoff deadline_ms must be a non-negative integer",
      );
    }
    if (preferredAgent !== null && preferredAgent !== input._localPeerId) {
      return { accepted: false };
    }
    if (deadlineMs === 0) return { accepted: false };

    const prompt =
      Object.keys(context).length === 0
        ? task
        : `${task}\n\nContext:\n${JSON.stringify(context, null, 2)}`;
    try {
      const result = await skills.invoke("process.spawn", {
        project,
        cwd: project,
        prompt,
        _peerId: input._peerId,
        _acceptanceDeadlineMs: deadlineMs,
      });
      return { accepted: true, result };
    } catch (error) {
      if (error instanceof JobStartTimeoutError) return { accepted: false };
      throw error;
    }
  });

  skills.register("process.list", async () => {
    if (options.jobs === undefined) {
      throw new PiMeshError(-32004, "process.list requires a job manager");
    }
    return {
      jobs: options.jobs.list().map((job) => ({
        job_id: job.id,
        session_id: job.sessionId ?? null,
        pid: job.pid ?? null,
        project: job.project,
        cwd: job.cwd,
        state: job.state,
        started_at: new Date(job.startedAt).toISOString(),
        ...(job.exit === undefined
          ? {}
          : {
              exit: {
                code: job.exit.code,
                signal: job.exit.signal,
                at: job.exit.at,
              },
            }),
      })),
    };
  });
  skills.register("process.stop", async (input) => {
    const jobId = requiredString(input, "job_id");
    if (options.jobs === undefined) {
      throw new PiMeshError(-32004, "process.stop requires a job manager");
    }
    const record = await options.jobs.stop(jobId);
    return { job_id: record.id, state: record.state, pid: record.pid };
  });
  skills.register("session.abort", async (input) => {
    const jobId = requiredString(input, "job_id");
    if (options.jobs === undefined) {
      throw new PiMeshError(-32004, "session.abort requires a job manager");
    }
    return options.jobs.send(jobId, { type: "abort" });
  });
  skills.registerExecution("session.steer", async (input) => {
    const jobId = requiredString(input, "job_id");
    const message = requiredString(input, "message");
    if (message.trim().length === 0) {
      throw new PiMeshError(-32602, "Skill input requires non-blank message");
    }
    if (Buffer.byteLength(message, "utf8") > 4096) {
      throw new PiMeshError(
        -32602,
        "session.steer message exceeds 4096 UTF-8 bytes",
      );
    }
    if (options.jobs === undefined) {
      throw new PiMeshError(-32004, "session.steer requires a job manager");
    }
    // A PROMPT marked streamingBehavior:"steer", not pi's `steer` command.
    //
    // pi's `steer` only pushes onto the in-flight turn's steering queue. On a
    // session that is alive but waiting - which is what a job looks like between
    // turns, and what the dashboard offers a Steer box for - nothing reads that
    // queue, so the command is acknowledged and the session never moves. That was
    // the behaviour until it was reproduced on hardware: the RPC answered
    // success:true and the transcript did not gain a single entry.
    //
    // `prompt` is the command that distinguishes the two states: it queues as a
    // steer when a turn is in flight, and starts a turn when the session is idle.
    // That is what someone clicking Steer on a running-but-waiting session means.
    // The gate is unchanged - session.steer is an execution skill (ADR 0008), so
    // only a control plane this machine allowed can reach it.
    return options.jobs.send(jobId, {
      type: "prompt",
      message,
      streamingBehavior: "steer",
    });
  });

  skills.register("mesh.peers", async () => ({
    peers: peerSummaries(registry),
  }));
  skills.register("session.list", async () => ({
    sessions: await sessions.list(),
  }));
  skills.register("session.read", async (input) => {
    try {
      return {
        entries: await sessions.read({
          id: requiredString(input, "id"),
          ...(typeof input.since === "string" ? { since: input.since } : {}),
        }),
      };
    } catch (error) {
      throw new PiMeshError(
        ErrorCode.UnknownSession,
        error instanceof Error ? error.message : "Unknown session",
      );
    }
  });
  // The transport owns this handler because it must keep the iterator alive
  // after the JSON-RPC request has returned.
  skills.register("session.stream", async () => {
    throw new PiMeshError(-32004, "session.stream requires message/stream");
  });

  return skills;
}

/**
 * What this agent advertises, as a function of two separate facts.
 *
 * `jobsAvailable` is whether a JobManager exists; `gateOpen` is the spawn policy
 * (ADR 0008). cli.ts constructs the manager iff the policy is enabled, so in
 * production these always agree - but the exported server constructor accepts
 * them independently, and a single flag made a server built with a manager and a
 * closed policy advertise execution it answers with -32102.
 *
 * EVERY execution skill needs the manager, `mesh.handoff` included: it does not
 * touch `options.jobs` directly, it delegates to the local `process.spawn`, so a
 * manager-less handoff fails with -32004 rather than being refused cleanly. That
 * indirection is why this was wrong twice.
 */
export function servedSkills(jobsAvailable = false, gateOpen = false): Skill[] {
  return [
    ...ALWAYS_SERVED_SKILLS,
    ...(jobsAvailable ? JOB_SKILLS : []),
    ...(jobsAvailable && gateOpen ? EXECUTION_SKILLS : []),
  ];
}

async function sendBeforeDeadline(
  jobs: JobManager,
  jobId: string,
  command: Parameters<JobManager["send"]>[1],
  deadlineAt: number | undefined,
) {
  if (deadlineAt === undefined) return jobs.send(jobId, command);
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new JobStartTimeoutError();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      jobs.send(jobId, command),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JobStartTimeoutError()), remaining);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
