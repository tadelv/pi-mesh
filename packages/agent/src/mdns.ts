// SPDX-License-Identifier: GPL-3.0-or-later

import Bonjour from "bonjour-service";
import {
  SERVICE_TYPE_CONTROL,
  SERVICE_TYPE_MESH,
  TXT_KEY_AGENT_VERSION,
  TXT_KEY_CAPABILITIES,
  TXT_KEY_FINGERPRINT,
  TXT_KEY_ID,
  TXT_KEY_NAME,
  TXT_KEY_PORT,
  TXT_KEY_VERSION,
  toBonjourServiceName,
  withoutEmptyTxtValues,
} from "@pi-mesh/protocol";
import {
  PeerRegistry,
  type PeerInput,
  type PeerRecord,
  type PeerServiceType,
} from "./registry.js";

export type NetworkProfile = "lan" | "public";

export interface AgentDescriptor {
  id: string;
  name: string;
  version: string;
  agentVersion: string;
  port: number;
  fingerprint: string;
  capabilities: readonly string[];
  swarmKey?: Uint8Array;
  swarmKeyLoaded?: boolean;
  profile?: NetworkProfile;
}

export interface BonjourPublishOptions {
  type: string;
  name: string;
  port: number;
  txt: Record<string, string>;
}

export interface BonjourDiscoveredService {
  name?: string;
  host?: string;
  port?: number;
  txt?: Record<string, string | Uint8Array>;
  addresses?: readonly string[];
  referer?: { address?: string };
}

export interface BonjourBrowserLike {
  stop(): void;
}

export interface BonjourLike {
  publish(options: BonjourPublishOptions): unknown;
  find(
    options: { type: string },
    onup?: (service: BonjourDiscoveredService) => void,
  ): BonjourBrowserLike;
  destroy(): void | PromiseLike<void>;
}

const NOOP_HANDLE = { stop: async (): Promise<void> => {} };

export function buildAgentTxtRecord(
  descriptor: AgentDescriptor,
): Record<string, string> {
  return withoutEmptyTxtValues({
    [TXT_KEY_ID]: descriptor.id,
    [TXT_KEY_NAME]: descriptor.name,
    [TXT_KEY_VERSION]: descriptor.version,
    [TXT_KEY_AGENT_VERSION]: descriptor.agentVersion,
    [TXT_KEY_PORT]: String(descriptor.port),
    [TXT_KEY_FINGERPRINT]: descriptor.fingerprint,
    [TXT_KEY_CAPABILITIES]: descriptor.capabilities.join(","),
  });
}

export async function publishAgent(
  descriptor: AgentDescriptor,
  options: {
    bonjour?: BonjourLike;
    profile?: NetworkProfile;
    swarmKey?: Uint8Array;
  } = {},
): Promise<{ stop: () => Promise<void> }> {
  const profile = options.profile ?? descriptor.profile ?? "lan";
  const hasSwarmKey =
    options.swarmKey !== undefined ||
    descriptor.swarmKey !== undefined ||
    descriptor.swarmKeyLoaded === true;
  if (profile !== "lan" || !hasSwarmKey) {
    return NOOP_HANDLE;
  }

  const bonjour = options.bonjour ?? new Bonjour();
  bonjour.publish({
    // bonjour-service composes `_<name>._<protocol>` itself. The DNS-SD
    // constant must therefore be converted to its bare service name.
    type: toBonjourServiceName(SERVICE_TYPE_MESH),
    name: descriptor.name,
    port: descriptor.port,
    txt: buildAgentTxtRecord(descriptor),
  });

  return {
    stop: async () => {
      await bonjour.destroy();
    },
  };
}

export interface BrowseOptions {
  bonjour?: BonjourLike;
  profile?: NetworkProfile;
  intervalMs?: number;
  onPeer?: (peer: PeerRecord) => void;
}

export interface BrowseHandle {
  stop: () => Promise<void>;
}

export function browsePeers(
  registry: PeerRegistry,
  options: BrowseOptions = {},
): BrowseHandle {
  if (options.profile === "public") {
    return NOOP_HANDLE;
  }

  const bonjour = options.bonjour ?? new Bonjour();
  const browsers: BonjourBrowserLike[] = [];
  const browse = (
    serviceType: string,
    peerServiceType: PeerServiceType,
  ): void => {
    const browser = bonjour.find(
      { type: toBonjourServiceName(serviceType) },
      (service) => {
        const peer = discoveredPeer(service, peerServiceType);
        if (peer !== undefined) {
          const record = registry.upsert(peer);
          options.onPeer?.(record);
        }
      },
    );
    browsers.push(browser);
  };

  browse(SERVICE_TYPE_MESH, "mesh");
  browse(SERVICE_TYPE_CONTROL, "control");
  const intervalMs =
    options.intervalMs ?? Math.min(1_000, Math.max(1, registry.ttlMs / 2));
  const timer = setInterval(() => {
    registry.prune();
  }, intervalMs);

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      for (const browser of browsers) {
        browser.stop();
      }
      await bonjour.destroy();
    },
  };
}

function discoveredPeer(
  service: BonjourDiscoveredService,
  serviceType: PeerServiceType,
): PeerInput | undefined {
  const txt = normalizeTxt(service.txt);
  const id = txt[TXT_KEY_ID];
  if (id === undefined || id.length === 0) {
    return undefined;
  }

  const name = txt[TXT_KEY_NAME] ?? service.name ?? id;
  const portValue = txt[TXT_KEY_PORT] ?? service.port?.toString();
  const port = portValue === undefined ? service.port : Number(portValue);
  if (
    port === undefined ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535
  ) {
    return undefined;
  }

  return {
    id,
    name,
    serviceType,
    host:
      service.host ?? service.addresses?.[0] ?? service.referer?.address ?? "",
    port,
    txt,
  };
}

function normalizeTxt(
  txt: Record<string, string | Uint8Array> | undefined,
): Record<string, string> {
  if (txt === undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(txt).map(([key, value]) => [
      key,
      typeof value === "string" ? value : new TextDecoder().decode(value),
    ]),
  );
}

export { SERVICE_TYPE_CONTROL, SERVICE_TYPE_MESH, toBonjourServiceName };
export type { PeerRecord } from "./registry.js";
