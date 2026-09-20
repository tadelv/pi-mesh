// SPDX-License-Identifier: GPL-3.0-or-later

import type { PeerSummary, Skill } from "@pi-mesh/protocol";
import { ErrorCode, PiMeshError } from "@pi-mesh/shared";
import { PeerRegistry } from "./registry.js";
import { SessionStore, type SessionStoreOptions } from "./sessions.js";

export type SkillInput = Record<string, unknown>;
export type SkillHandler = (input: SkillInput) => Promise<unknown>;

export interface SkillRegistryOptions extends SessionStoreOptions {
  registry?: PeerRegistry;
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
    this.handlers.set(skill, handler);
    return this;
  }

  /**
   * Register a skill that starts or steers work.
   *
   * `EXECUTION_SKILLS` stops the gate being applied to a skill that is not
   * served. This is the other direction: it stops a skill that executes from
   * being served without the gate, by making the omission a startup error
   * rather than a silent hole. Prefer this over `register` for any handler
   * that can spawn or steer.
   */
  registerExecution(skill: Skill, handler: SkillHandler): this {
    if (!(EXECUTION_SKILLS as readonly string[]).includes(skill)) {
      throw new Error(
        `Skill ${skill} executes but is not in EXECUTION_SKILLS, so it would bypass the spawn gate`,
      );
    }
    return this.register(skill, handler);
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

export function servedSkills(): Skill[] {
  return [...SERVED_SKILLS];
}
