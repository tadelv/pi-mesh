// SPDX-License-Identifier: GPL-3.0-or-later

import { ErrorCode, PiMeshError } from "@pi-mesh/shared";
import { EXECUTION_SKILLS } from "./skills.js";

/**
 * The local spawn policy (ADR 0008).
 *
 * Swarm membership grants reading. Starting or steering work on this machine
 * is a separate, larger grant that each machine makes for itself, and it is
 * off unless explicitly enabled. `PI_MESH_ALLOW_SPAWN` is unset (nothing
 * executes), `*` (any member may), or a comma-separated list of peer IDs.
 *
 * The peer-ID list is a convenience, NOT an authorisation boundary. A claimed
 * `peer_id` is a routing label rather than an authenticated identity (ADR
 * 0007), and every member holds the same swarm key, so a malicious member can
 * claim the ID of an allowed peer and inherit its permission. What actually
 * protects this machine is the machine-wide opt-in; the list narrows *which*
 * of your own agents may execute, not which adversary may. Per-peer keys would
 * be needed to make it a boundary, and that is deliberately not v1.
 */
export interface SpawnPolicy {
  /** Whether this peer may start or steer work on this machine. */
  allows(peerId: string): boolean;
  /**
   * Whether any peer at all may execute here. Drives capability advertising:
   * a machine that refuses a capability must not advertise it (ADR 0006 §4).
   */
  readonly enabled: boolean;
}

const DENY_ALL: SpawnPolicy = { allows: () => false, enabled: false };

/**
 * Parse a policy value. Anything unrecognised denies rather than permits: a
 * configuration mistake must not silently become a grant of execution.
 */
export function parseSpawnPolicy(
  value?: string,
  environmentValue = process.env.PI_MESH_ALLOW_SPAWN,
): SpawnPolicy {
  const raw = (value ?? environmentValue ?? "").trim();
  if (raw.length === 0) return DENY_ALL;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return DENY_ALL;
  if (entries.includes("*")) {
    return { allows: (peerId) => peerId.length > 0, enabled: true };
  }
  const allowed = new Set(entries);
  return { allows: (peerId) => allowed.has(peerId), enabled: true };
}

/** Whether a skill starts or steers work, and therefore needs the gate. */
export function isExecutionSkill(skill: string): boolean {
  return (EXECUTION_SKILLS as readonly string[]).includes(skill);
}

/**
 * Throw unless this peer may execute here.
 *
 * Called at the single dispatch point rather than from each handler, so a new
 * execution skill cannot be added without meeting the gate: the gate and the
 * advertised capability list both read `EXECUTION_SKILLS`.
 *
 * The message distinguishes "you are not allowed" from "this machine allows
 * nobody", because the fix is different in each case - a different peer, or a
 * local change to `PI_MESH_ALLOW_SPAWN`.
 */
export function assertExecutionAllowed(
  policy: SpawnPolicy,
  peerId: string,
  skill: string,
): void {
  if (!isExecutionSkill(skill)) return;
  if (policy.allows(peerId)) return;
  throw new PiMeshError(
    ErrorCode.SpawnDenied,
    policy.enabled
      ? `Peer is not permitted to execute on this machine: ${skill}`
      : `Execution is disabled on this machine (set PI_MESH_ALLOW_SPAWN to enable): ${skill}`,
  );
}
