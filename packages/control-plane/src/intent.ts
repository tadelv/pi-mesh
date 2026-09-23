// SPDX-License-Identifier: GPL-3.0-or-later

import { systemOne, type JevOptions } from "./jev.js";

export const INTENT_ACTIONS = [
  "show_devices",
  "show_sessions",
  "sync_now",
  "open_session",
  "none",
] as const;
export const ACTION_CONFIDENCE_FLOOR = 0.6;
export const ARGUMENT_CONFIDENCE_FLOOR = 0.5;
/**
 * TypeSafe rejects a Choice with more than 255 options (verified: 300 options ->
 * HTTP 400 "Too many choices"), so a fleet larger than that must be trimmed
 * before the request is built or the whole call fails and intent routing goes
 * dark. 50 is chosen well below the limit to bound token cost as well.
 */
export const MAX_CHOICE_OPTIONS = 255;
export const MAX_INTENT_SESSIONS = 50;

export interface IntentContext {
  devices: Array<{ id: string; name: string }>;
  sessions: Array<{
    agent_id: string;
    session_id: string;
    name: string | null;
    project: string;
  }>;
}
export interface IntentResult {
  action: (typeof INTENT_ACTIONS)[number];
  confidence: number;
  arguments: { agent_id?: string; session_id?: string };
}

function isIntentAction(
  value: string,
): value is (typeof INTENT_ACTIONS)[number] {
  return INTENT_ACTIONS.some((action) => action === value);
}

export async function routeIntent(
  text: string,
  context: IntentContext,
  options: JevOptions,
): Promise<IntentResult | undefined> {
  const actions = {
    show_devices: "list the paired machines",
    show_sessions: "list sessions, optionally on one named machine",
    sync_now: "refresh the cached sessions now",
    open_session: "open one specific session to read it",
    none: "the request does not ask for any of these",
  };
  // The caller passes the most recent first, so trimming keeps the candidates a
  // person is most likely to mean.
  const devices = context.devices.slice(0, MAX_CHOICE_OPTIONS);
  const sessions = context.sessions.slice(0, MAX_INTENT_SESSIONS);
  const questions = {
    action: {
      type: "choice" as const,
      instructions: "Choose the action that best matches the request.",
      criteria: actions,
    },
    ...(devices.length === 0
      ? {}
      : {
          names_device: {
            type: "noul" as const,
            instructions: "Does the request name one of the known machines?",
          },
          device: {
            type: "choice" as const,
            instructions: "Choose the named machine, if any.",
            criteria: Object.fromEntries(devices.map((d) => [d.id, d.name])),
          },
        }),
    ...(sessions.length === 0
      ? {}
      : {
          names_session: {
            type: "noul" as const,
            instructions: "Does the request name one of the known sessions?",
          },
          session: {
            type: "choice" as const,
            instructions: "Choose the named session, if any.",
            criteria: Object.fromEntries(
              sessions.map((session, index) => [
                String(index),
                `${session.name ?? session.project} on ${session.agent_id}`,
              ]),
            ),
          },
        }),
  };
  const answers = await systemOne({ text, ...context }, questions, options);
  if (answers === undefined) return undefined;
  const actionAnswer = answers.action;
  if (actionAnswer === undefined || actionAnswer.type !== "choice")
    return undefined;
  const action = actionAnswer.choice;
  const confidence = actionAnswer.confidence;
  const noneProbability = actionAnswer.probabilities.none ?? 0;
  if (
    !isIntentAction(action) ||
    action === "none" ||
    confidence < ACTION_CONFIDENCE_FLOOR ||
    noneProbability >= (actionAnswer.probabilities[action] ?? 0)
  )
    return { action: "none", confidence, arguments: {} };

  if (action === "show_devices" || action === "sync_now")
    return { action, confidence, arguments: {} };

  const resolveDevice = ():
    | { kind: "absent" }
    | { kind: "unresolved" }
    | { kind: "resolved"; id: string } => {
    if (devices.length === 0) return { kind: "absent" };
    const named = answers.names_device;
    const chosen = answers.device;
    if (named === undefined || named.type !== "noul")
      return { kind: "unresolved" };
    if (named.noul < ARGUMENT_CONFIDENCE_FLOOR) return { kind: "absent" };
    if (
      chosen === undefined ||
      chosen.type !== "choice" ||
      chosen.confidence < ARGUMENT_CONFIDENCE_FLOOR ||
      !devices.some((device) => device.id === chosen.choice)
    )
      return { kind: "unresolved" };
    return { kind: "resolved", id: chosen.choice };
  };
  if (action === "show_sessions") {
    const device = resolveDevice();
    // A named-but-unresolved machine is not "all machines": showing everything
    // when the operator asked for one is a guess, and ADR 0012 says the code
    // does not guess an argument.
    if (device.kind === "unresolved")
      return { action: "none", confidence, arguments: {} };
    return {
      action,
      confidence,
      arguments: device.kind === "resolved" ? { agent_id: device.id } : {},
    };
  }
  const device = resolveDevice();
  if (device.kind !== "resolved")
    return { action: "none", confidence, arguments: {} };
  const agentId = device.id;
  const namesSession = answers.names_session;
  const chosenSession = answers.session;
  // Number("") and Number("   ") are both 0, so an empty or whitespace choice
  // would silently select the first session. Only an exact candidate index key
  // may be used.
  const chosenIndex =
    chosenSession?.type === "choice" && /^\d+$/.test(chosenSession.choice)
      ? Number(chosenSession.choice)
      : -1;
  const session =
    Number.isInteger(chosenIndex) && chosenIndex >= 0
      ? sessions[chosenIndex]
      : undefined;
  if (
    agentId === undefined ||
    namesSession === undefined ||
    chosenSession === undefined ||
    namesSession.type !== "noul" ||
    namesSession.noul < ARGUMENT_CONFIDENCE_FLOOR ||
    chosenSession.type !== "choice" ||
    chosenSession.confidence < ARGUMENT_CONFIDENCE_FLOOR ||
    session === undefined ||
    session.agent_id !== agentId
  )
    return { action: "none", confidence, arguments: {} };
  return {
    action,
    confidence,
    arguments: { agent_id: session.agent_id, session_id: session.session_id },
  };
}
