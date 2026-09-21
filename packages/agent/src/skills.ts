// SPDX-License-Identifier: GPL-3.0-or-later

import type { PeerSummary, Skill } from "@pi-mesh/protocol";
import { isAbsolute, join } from "node:path";
import { ErrorCode, PiMeshError } from "@pi-mesh/shared";
import { PeerRegistry } from "./registry.js";
import { SessionStore, type SessionStoreOptions } from "./sessions.js";
import type { JobManager } from "./jobs.js";
import { assertInsideWorkspace, resolveWorkspaceRoot } from "./spawner.js";

export type SkillInput = Record<string, unknown>;
export type SkillHandler = (input: SkillInput) => Promise<unknown>;

export interface SkillRegistryOptions extends SessionStoreOptions {
  registry?: PeerRegistry;
  jobs?: JobManager;
  workspaceRoot?: string;
}

const SERVED_SKILLS: readonly Skill[] = [
  "mesh.peers",
  "session.list",
  "session.read",
  "session.stream",
];

/**
 * Skills that start or steer work, and so require the local spawn policy
 * (ADR 0008). This is the one list the dispatch gate reads, so a skill cannot
 * be named in the gate and forgotten here. It does NOT yet drive advertising -
 * `servedSkills()` returns `SERVED_SKILLS` directly, and M2-8 is what makes the
 * advertised set depend on the gate.
 *
 * Stopping skills are deliberately absent: reducing activity is never the more
 * dangerous operation, so `session.abort` and `process.stop` are allowed to any
 * member (ADR 0008 decision 5).
 */
export const EXECUTION_SKILLS: readonly Skill[] = [
  "process.spawn",
  "session.steer",
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
      .filter((skill): skill is Skill =>
        (SERVED_SKILLS as readonly string[]).includes(skill),
      );
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

  if (options.jobs !== undefined) {
    skills.registerExecution("process.spawn", async (input) => {
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
      let root: string;
      try {
        root = resolveWorkspaceRoot(options.workspaceRoot);
      } catch (error) {
        throw new PiMeshError(
          ErrorCode.SpawnDenied,
          `process.spawn refused: workspace is not configured (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      let cwd: string;
      try {
        // A relative cwd resolves against the workspace ROOT, never against the
        // agent's incidental process.cwd(): `realpathSync("sub")` would resolve
        // against whatever directory the daemon was started in, so a legitimate
        // request would be refused - or worse, silently point somewhere
        // unrelated. `..` is still caught, by the realpath check inside.
        const requested = input.cwd ?? root;
        cwd = assertInsideWorkspace(
          root,
          isAbsolute(requested) ? requested : join(root, requested),
        );
      } catch (error) {
        throw new PiMeshError(
          ErrorCode.SpawnDenied,
          `process.spawn refused: cwd is outside the workspace (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      let record;
      try {
        record = await options.jobs!.startReady({
          peerId:
            typeof input._peerId === "string" ? input._peerId : "unknown-peer",
          project,
          cwd,
          name: project,
        });
      } catch (error) {
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
      return {
        job_id: record.id,
        pid: record.pid,
        session_id: record.sessionId,
      };
    });
  }

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

export function servedSkills(spawnEnabled = false): Skill[] {
  return [
    ...SERVED_SKILLS,
    ...(spawnEnabled ? (["process.spawn"] as Skill[]) : []),
  ];
}
