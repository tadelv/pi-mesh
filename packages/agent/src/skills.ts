// SPDX-License-Identifier: GPL-3.0-or-later

import type { PeerSummary, Skill } from "@pi-mesh/protocol";
import { isAbsolute, join, relative, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { ErrorCode, PiMeshError } from "@pi-mesh/shared";
import { PeerRegistry } from "./registry.js";
import { SessionStore, type SessionStoreOptions } from "./sessions.js";
import { JobStartTimeoutError, type JobManager } from "./jobs.js";
import { ModelCatalog, hasExactModel } from "./model-catalog.js";
import { assertInsideWorkspace, resolveWorkspaceRoot } from "./spawner.js";
import { defaultSessionsRoot, isPlainUuid } from "./sessions.js";

export type SkillInput = Record<string, unknown>;
export type SkillHandler = (input: SkillInput) => Promise<unknown>;

export interface SkillRegistryOptions extends SessionStoreOptions {
  registry?: PeerRegistry;
  jobs?: JobManager;
  workspaceRoot?: string;
  piBinary?: string;
  modelCatalogTtlMs?: number;
  modelCatalogTimeoutMs?: number;
}

export const ALWAYS_SERVED_SKILLS: readonly Skill[] = [
  "mesh.peers",
  "session.list",
  "session.read",
  "session.stream",
  "session.models",
];

export const JOB_SKILLS: readonly Skill[] = [
  "process.list",
  "process.stop",
  "session.abort",
  "session.commands",
  "session.status",
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
  "session.resume",
  "session.set_model",
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
  private readonly closers: (() => Promise<void> | void)[] = [];

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

  /**
   * Register a resource this registry owns and must release on shutdown.
   *
   * The catalog helper is the reason: its `pi --mode rpc` child can be
   * in-flight when the agent stops, and nothing outside this registry holds a
   * reference to it.
   */
  onClose(closer: () => Promise<void> | void): this {
    this.closers.push(closer);
    return this;
  }

  /** Release owned resources. Safe to call more than once. */
  async close(): Promise<void> {
    await Promise.allSettled(this.closers.map((closer) => closer()));
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
  const catalog = new ModelCatalog({
    ...(options.piBinary === undefined ? {} : { piBinary: options.piBinary }),
    ...(options.modelCatalogTtlMs === undefined
      ? {}
      : { ttlMs: options.modelCatalogTtlMs }),
    ...(options.modelCatalogTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.modelCatalogTimeoutMs }),
  });
  // A killed agent must not leave the helper's child behind: shutdown closes it.
  skills.onClose(() => catalog.close());

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
    // ADR 0017: a model choice is the one bounded exception to "no argv". The
    // caller names an exact (provider, model_id); the agent compares it for
    // equality against its own Pi catalog BEFORE any process starts, never
    // passing a free string or a fuzzy pattern to Pi's CLI.
    let model: { provider: string; modelId: string } | undefined;
    if (input.model !== undefined) {
      const requested = input.model;
      if (
        typeof requested !== "object" ||
        requested === null ||
        Array.isArray(requested) ||
        typeof (requested as { provider?: unknown }).provider !== "string" ||
        (requested as { provider: string }).provider.trim().length === 0 ||
        typeof (requested as { model_id?: unknown }).model_id !== "string" ||
        (requested as { model_id: string }).model_id.trim().length === 0
      ) {
        throw new PiMeshError(
          -32602,
          "process.spawn model must be { provider, model_id } with non-blank strings",
        );
      }
      const provider = (requested as { provider: string }).provider;
      const modelId = (requested as { model_id: string }).model_id;
      let models: unknown[];
      try {
        models = await catalog.get();
      } catch (error) {
        throw new PiMeshError(
          ErrorCode.CatalogUnavailable,
          `process.spawn refused: the model catalog is unavailable (${error instanceof Error ? error.message : String(error)})`,
          { cause: error },
        );
      }
      if (!hasExactModel(models, provider, modelId)) {
        throw new PiMeshError(
          -32602,
          `process.spawn refused: ${provider}/${modelId} is not in this agent's Pi model catalog`,
        );
      }
      model = { provider, modelId };
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
          ...(model === undefined ? {} : { model }),
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

  const resumingSessions = new Set<string>();
  skills.registerExecution("session.resume", async (input) => {
    const sessionId = requiredString(input, "session_id");
    if (!isPlainUuid(sessionId)) {
      throw new PiMeshError(-32602, "session.resume session_id must be a UUID");
    }
    const jobs = options.jobs;
    if (jobs === undefined) {
      throw new PiMeshError(-32004, "session.resume requires a job manager");
    }
    if (input.acknowledge_concurrent_writers !== true) {
      throw new PiMeshError(
        -32602,
        "session.resume requires acknowledge_concurrent_writers: true; a running external Pi TUI can corrupt the session file",
      );
    }
    const matches = await sessions.findSessionPaths(sessionId);
    if (matches.length !== 1) {
      throw new PiMeshError(
        ErrorCode.UnknownSession,
        matches.length === 0
          ? `Unknown session id: ${sessionId}`
          : `Ambiguous session id: ${sessionId}`,
      );
    }
    const found = matches[0]!;
    let root: string;
    let sessionFile: string;
    let cwd: string;
    try {
      root = resolveWorkspaceRoot(options.workspaceRoot);
      const sessionsRoot = await realpath(
        options.sessionsRoot ?? defaultSessionsRoot(),
      );
      sessionFile = await realpath(found.path);
      const fileRelative = relative(sessionsRoot, sessionFile);
      if (
        fileRelative === "" ||
        fileRelative === ".." ||
        fileRelative.startsWith(`..${sep}`) ||
        isAbsolute(fileRelative) ||
        !(await stat(sessionFile)).isFile()
      ) {
        throw new Error("session file is outside the configured sessions root");
      }
      if (!isAbsolute(found.parsed.header?.cwd ?? "")) {
        throw new Error("session cwd is not an absolute path");
      }
      cwd = assertInsideWorkspace(root, found.parsed.header!.cwd);
    } catch (error) {
      throw new PiMeshError(
        ErrorCode.SpawnDenied,
        `session.resume refused: session file or cwd failed validation (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (
      resumingSessions.has(sessionId) ||
      jobs
        .list()
        .some((job) => job.sessionId === sessionId && job.state !== "exited")
    ) {
      throw new PiMeshError(
        ErrorCode.JobNotRunning,
        `session.resume refused: a job already owns session ${sessionId}`,
      );
    }
    resumingSessions.add(sessionId);
    try {
      const record = await jobs.startReady({
        peerId:
          typeof input._peerId === "string" ? input._peerId : "unknown-peer",
        project: cwd,
        cwd,
        name: "resume",
        sessionFile,
      });
      if (record.sessionId !== sessionId) {
        await jobs.stop(record.id).catch(() => undefined);
        throw new PiMeshError(
          ErrorCode.SpawnFailed,
          `session.resume failed: Pi opened a different session (${record.sessionId ?? "no session id"})`,
        );
      }
      return { job_id: record.id, pid: record.pid, session_id: sessionId };
    } catch (error) {
      if (error instanceof PiMeshError) throw error;
      throw new PiMeshError(
        ErrorCode.SpawnFailed,
        `session.resume failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      resumingSessions.delete(sessionId);
    }
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

  skills.register("session.models", async (input) => {
    if (input.job_id === undefined) {
      try {
        return { models: await catalog.get() };
      } catch (error) {
        throw new PiMeshError(
          ErrorCode.CatalogUnavailable,
          `Model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    const jobId = requiredString(input, "job_id");
    if (options.jobs === undefined) {
      throw new PiMeshError(-32004, "session.models requires a job manager");
    }
    const job = options.jobs.get(jobId);
    if (job === undefined) {
      throw new PiMeshError(ErrorCode.UnknownJob, `Unknown job: ${jobId}`);
    }
    if (job.state !== "running") {
      throw new PiMeshError(
        ErrorCode.JobNotRunning,
        `Job is not running: ${jobId}`,
      );
    }
    try {
      const response = await options.jobs.send(jobId, {
        type: "get_available_models",
      });
      const models = (response.data as { models?: unknown } | undefined)
        ?.models;
      if (!Array.isArray(models))
        throw new Error("Pi returned an invalid model catalog");
      return { models };
    } catch (error) {
      if (error instanceof PiMeshError) throw error;
      throw new PiMeshError(
        ErrorCode.CatalogUnavailable,
        `Model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
  skills.register("session.commands", async (input) => {
    const jobId = requiredString(input, "job_id");
    if (jobId.trim().length === 0) {
      throw new PiMeshError(
        -32602,
        "session.commands job_id must be non-blank",
      );
    }
    if (options.jobs === undefined) {
      throw new PiMeshError(-32004, "session.commands requires a job manager");
    }
    const job = options.jobs.get(jobId);
    if (job === undefined) {
      throw new PiMeshError(ErrorCode.UnknownJob, `Unknown job: ${jobId}`);
    }
    if (job.state !== "running") {
      throw new PiMeshError(
        ErrorCode.JobNotRunning,
        `Job is not running: ${jobId}`,
      );
    }
    const response = await options.jobs.send(jobId, { type: "get_commands" });
    const commands = (response.data as { commands?: unknown } | undefined)
      ?.commands;
    if (!Array.isArray(commands))
      throw new Error("Pi returned an invalid command list");
    // Name, description and the source kind only. Pi also returns absolute
    // resource paths under `sourceInfo`, and a peer has no business learning this
    // host's filesystem layout (ADR 0017: the list reveals resource names).
    return {
      commands: commands.map((command) => {
        const record = (command ?? {}) as Record<string, unknown>;
        return {
          name: record.name,
          ...(record.description === undefined
            ? {}
            : { description: record.description }),
          ...(record.source === undefined ? {} : { source: record.source }),
        };
      }),
    };
  });
  skills.register("session.status", async (input) => {
    const jobId = requiredString(input, "job_id");
    if (jobId.trim().length === 0) {
      throw new PiMeshError(-32602, "session.status job_id must be non-blank");
    }
    if (options.jobs === undefined) {
      throw new PiMeshError(-32004, "session.status requires a job manager");
    }
    const job = options.jobs.get(jobId);
    if (job === undefined) {
      throw new PiMeshError(ErrorCode.UnknownJob, `Unknown job: ${jobId}`);
    }
    if (job.state !== "running") {
      throw new PiMeshError(
        ErrorCode.JobNotRunning,
        `Job is not running: ${jobId}`,
      );
    }
    // Two read-only RPC calls; nothing here mutates. Pi is the authority for the
    // numbers, and the fields are passed through only when it reported them.
    const stateResponse = await options.jobs.send(jobId, { type: "get_state" });
    const statsResponse = await options.jobs.send(jobId, {
      type: "get_session_stats",
    });
    const stateData = (stateResponse.data ?? {}) as Record<string, unknown>;
    const statsData = (statsResponse.data ?? {}) as Record<string, unknown>;
    return {
      ...(stateData.model === undefined ? {} : { model: stateData.model }),
      ...(stateData.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: stateData.thinkingLevel }),
      ...(statsData.tokens === undefined ? {} : { tokens: statsData.tokens }),
      ...(statsData.cost === undefined ? {} : { cost: statsData.cost }),
      ...(statsData.contextUsage === undefined
        ? {}
        : { contextUsage: statsData.contextUsage }),
    };
  });
  skills.registerExecution("session.set_model", async (input) => {
    const jobId = requiredString(input, "job_id");
    const provider = requiredString(input, "provider");
    const modelId = requiredString(input, "model_id");
    if (
      jobId.trim().length === 0 ||
      provider.trim().length === 0 ||
      modelId.trim().length === 0
    ) {
      throw new PiMeshError(
        -32602,
        "session.set_model fields must be non-blank",
      );
    }
    if (options.jobs === undefined) {
      throw new PiMeshError(-32004, "session.set_model requires a job manager");
    }
    const job = options.jobs.get(jobId);
    if (job === undefined) {
      throw new PiMeshError(ErrorCode.UnknownJob, `Unknown job: ${jobId}`);
    }
    if (job.state !== "running") {
      throw new PiMeshError(
        ErrorCode.JobNotRunning,
        `Job is not running: ${jobId}`,
      );
    }
    let models: unknown[];
    try {
      const response = await options.jobs.send(jobId, {
        type: "get_available_models",
      });
      const result = (response.data as { models?: unknown } | undefined)
        ?.models;
      if (!Array.isArray(result))
        throw new Error("Pi returned an invalid model catalog");
      models = result;
    } catch (error) {
      if (error instanceof PiMeshError) throw error;
      throw new PiMeshError(
        ErrorCode.CatalogUnavailable,
        `Model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!hasExactModel(models, provider, modelId)) {
      throw new PiMeshError(-32602, "Model is not in the Pi catalog");
    }
    const response = await options.jobs.send(jobId, {
      type: "set_model",
      provider,
      modelId,
    });
    return response.data;
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
