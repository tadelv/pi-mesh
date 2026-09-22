// SPDX-License-Identifier: GPL-3.0-or-later

import { ErrorCode, PiMeshError } from "@pi-mesh/shared";
import { isUuid } from "./identity.js";
import { EXECUTION_SKILLS } from "./skills.js";

/**
 * The local spawn policy (ADR 0008).
 *
 * Swarm membership grants reading. Starting or steering work on this machine
 * is a separate, larger grant that each machine makes for itself, and it is
 * off unless explicitly enabled. `--allow-execution` has exactly three
 * forms: absent (nothing executes), alone (any member may), or followed by a
 * comma-separated list of peer IDs. `PI_MESH_ALLOW_SPAWN` is the same policy
 * as a lower-precedence service-manager fallback.
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
  /**
   * Why a configuration was rejected, when it was. Configuration problems must
   * be reported rather than silently reinterpreted - the failure mode of a
   * misread policy is either an unwanted grant or a mystery refusal.
   */
  readonly warning?: string;
  /** Where the policy value came from, for operator diagnostics. */
  readonly source?: "cli" | "environment" | "none";
}

const DENY_ALL: SpawnPolicy = {
  allows: () => false,
  enabled: false,
  source: "none",
};

function denyWith(
  warning: string,
  source: "cli" | "environment" | "none",
): SpawnPolicy {
  return { ...DENY_ALL, warning, source };
}

/**
 * Parse a policy value. Anything unrecognised denies rather than permits: a
 * configuration mistake must not silently become a grant of execution.
 *
 * The subtle case is a wildcard mixed with IDs, `"*,<uuid>"`. Treating any
 * entry equal to `*` as a wildcard would mean an operator who had `*` and
 * appended a peer ID - intending to narrow the grant - silently widened it to
 * every member instead. A wildcard is therefore only a wildcard on its own,
 * which is the only form ADR 0008 defines.
 */
export function parseSpawnPolicy(
  value?: string,
  environmentValue = process.env.PI_MESH_ALLOW_SPAWN,
): SpawnPolicy {
  const source =
    value !== undefined
      ? "cli"
      : environmentValue?.trim().length
        ? "environment"
        : "none";
  const raw = (value ?? environmentValue ?? "").trim();
  if (raw.length === 0) return { ...DENY_ALL, source };
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return { ...DENY_ALL, source };
  if (entries.includes("*")) {
    if (entries.length === 1) {
      return {
        allows: (peerId) => peerId.length > 0,
        enabled: true,
        source,
      };
    }
    return denyWith(
      `PI_MESH_ALLOW_SPAWN must be either "*" on its own, or a list of peer IDs. Execution is disabled.`,
      source,
    );
  }
  const invalid = entries.filter((entry) => !isUuid(entry));
  if (invalid.length > 0) {
    // A token that cannot be a peer ID can never name a real peer. Accepting it
    // would set `enabled` while allowing nobody, which misreports this machine's
    // capability (ADR 0006 §4) and turns a typo into a silent no-op.
    return denyWith(
      `PI_MESH_ALLOW_SPAWN contains entries that are not peer IDs: ${invalid.join(", ")}. Execution is disabled.`,
      source,
    );
  }
  // Case-insensitive, matching how the ID is validated: an operator writing a
  // listed ID in uppercase should not get a silent refusal.
  const allowed = new Set(entries.map((entry) => entry.toLowerCase()));
  return {
    allows: (peerId) => allowed.has(peerId.toLowerCase()),
    enabled: true,
    source,
  };
}

/** Whether a skill starts or steers work, and therefore needs the gate. */
export function isExecutionSkill(skill: string): boolean {
  return (EXECUTION_SKILLS as readonly string[]).includes(skill);
}

/**
 * Throw unless this peer may execute here.
 *
 * The gate reads `EXECUTION_SKILLS`, the one list of skills that start or
 * steer work, so the check cannot drift from the list of things it guards.
 *
 * The message distinguishes "you are not allowed" from "this machine allows
 * nobody", because the fix is different in each case - a different peer, or a
 * local change to the execution opt-in (`--allow-execution`, or its
 * `PI_MESH_ALLOW_SPAWN` service-manager fallback).
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
      : `Execution is disabled on this machine (start with --allow-execution or set PI_MESH_ALLOW_SPAWN for a service manager): ${skill}`,
  );
}
