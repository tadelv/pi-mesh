// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Overseer control channel over pi-intercom's extension bus.
 *
 * Every pi session running this extension joins the `overseer/v1` namespace. A
 * control command is published to `capable` peers; only the session whose
 * transcript path matches `target` acts on it, so a run is always controlled by
 * the process that owns it.
 *
 * pi-intercom is optional. We import nothing from it: the register/ready event
 * names are stable strings, so the overseer degrades to observe-only (plus local
 * control of its own runs) when intercom is not loaded.
 */

import type { EventBus } from "./control.ts";

export const INTERCOM_REGISTER_EVENT = "intercom:extension-register";
export const INTERCOM_REGISTRY_READY_EVENT = "intercom:extension-registry-ready";
export const OVERSEER_NAMESPACE = "overseer/v1";

export interface ControlCommand {
  kind: "overseer.control";
  v: 1;
  /** owning session transcript path this command is addressed to */
  target: string;
  runId: string;
  verb: "steer" | "stop" | "interrupt";
  text?: string;
}

export interface ControlResult {
  kind: "overseer.result";
  v: 1;
  /** requester to report back to (informational) */
  target: string;
  runId: string;
  verb: string;
  ok: boolean;
  detail: string;
}

export function isControlCommand(payload: unknown): payload is ControlCommand {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    p.kind === "overseer.control" &&
    p.v === 1 &&
    typeof p.target === "string" &&
    p.target.length > 0 &&
    typeof p.runId === "string" &&
    p.runId.length > 0 &&
    (p.verb === "steer" || p.verb === "stop" || p.verb === "interrupt")
  );
}

export function isControlResult(payload: unknown): payload is ControlResult {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return p.kind === "overseer.result" && p.v === 1 && typeof p.runId === "string";
}

interface RawChannel {
  snapshot(): { connected?: boolean; supported?: boolean };
  publish(payload: unknown, options?: { audience?: "owner" | "capable" }): void;
}

interface RawEvent {
  type?: string;
  connected?: boolean;
  supported?: boolean;
  payload?: unknown;
}

export interface ControlChannelHandlers {
  /** transcript path of the session this node controls */
  selfSessionFile(): string | undefined;
  /** handle a command addressed to this session */
  onCommand(command: ControlCommand): void;
}

export interface ControlChannelStatus {
  available: boolean;
  connected: boolean;
  supported: boolean;
}

export interface ControlChannel {
  register(): void;
  publishCommand(command: Omit<ControlCommand, "kind" | "v">): { ok: boolean; detail: string };
  publishResult(result: Omit<ControlResult, "kind" | "v">): void;
  status(): ControlChannelStatus;
  dispose(): void;
}

export function createControlChannel(bus: EventBus, handlers: ControlChannelHandlers): ControlChannel {
  let raw: RawChannel | undefined;
  let registered = false;
  let connected = false;
  let supported = false;

  function handleEvent(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const e = event as RawEvent;
    if (e.type === "connection") {
      connected = Boolean(e.connected);
      supported = Boolean(e.supported);
      return;
    }
    if (e.type !== "message") return;
    if (!isControlCommand(e.payload)) return;
    const self = handlers.selfSessionFile();
    if (self && e.payload.target === self) handlers.onCommand(e.payload);
  }

  function register(): void {
    if (registered) return;
    let handled = false;
    bus.emit(INTERCOM_REGISTER_EVENT, {
      namespace: OVERSEER_NAMESPACE,
      ownerEligible: true,
      onReady: (channel: RawChannel) => {
        handled = true;
        raw = channel;
      },
      onEvent: handleEvent,
    });
    // emit() is synchronous: a listener either handled it or intercom is absent.
    if (handled) registered = true;
  }

  // pi-intercom may load after us (extensions dir loads before packages), so it
  // announces its registry; we also retry on session_start.
  const unsubscribeReady = bus.on(INTERCOM_REGISTRY_READY_EVENT, register);

  return {
    register,

    publishCommand(partial) {
      register();
      if (!raw) return { ok: false, detail: "control channel unavailable — is pi-intercom installed and loaded?" };
      try {
        raw.publish({ kind: "overseer.control", v: 1, ...partial }, { audience: "capable" });
        return { ok: true, detail: "broadcast to peers" };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },

    publishResult(partial) {
      if (!raw) return;
      try {
        raw.publish({ kind: "overseer.result", v: 1, ...partial }, { audience: "capable" });
      } catch {
        // best-effort reporting; the command itself already ran
      }
    },

    status() {
      return { available: Boolean(raw), connected, supported };
    },

    dispose() {
      unsubscribeReady();
      registered = false;
      raw = undefined;
    },
  };
}
