// SPDX-License-Identifier: GPL-3.0-or-later

import { isIPv4 } from "node:net";
import Bonjour from "bonjour-service";
import {
  SERVICE_TYPE_CONTROL,
  SERVICE_TYPE_MESH,
  TXT_KEY_AGENT_VERSION,
  TXT_KEY_CAPABILITIES,
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

const BROWSED_SERVICES: ReadonlyArray<[string, PeerServiceType]> = [
  [SERVICE_TYPE_MESH, "mesh"],
  [SERVICE_TYPE_CONTROL, "control"],
];

export function browsePeers(
  registry: PeerRegistry,
  options: BrowseOptions = {},
): BrowseHandle {
  if (options.profile === "public") {
    return NOOP_HANDLE;
  }

  const bonjour = options.bonjour ?? new Bonjour();
  let browsers: BonjourBrowserLike[] = [];

  const stopBrowsers = (): void => {
    for (const browser of browsers) {
      browser.stop();
    }
    browsers = [];
  };

  const startBrowsers = (): void => {
    for (const [serviceType, peerServiceType] of BROWSED_SERVICES) {
      const browser = bonjour.find(
        { type: toBonjourServiceName(serviceType) },
        (service) => {
          const peer = discoveredPeer(service, peerServiceType);
          if (peer === undefined) {
            return;
          }
          const known = registry.get(peerServiceType, peer.id) !== undefined;
          const record = registry.upsert(peer);
          // Only a genuinely new peer is a discovery event; a re-answer to the
          // periodic re-query is a liveness refresh and must stay quiet.
          if (!known) {
            options.onPeer?.(record);
          }
        },
      );
      browsers.push(browser);
    }
  };

  startBrowsers();

  // A responder does not re-announce an unchanged record, and bonjour-service
  // emits 'up' once per service per browser, so lastSeen would never refresh
  // and a blind prune would drop peers that are still alive. Re-querying with
  // fresh browsers lets a live peer refresh its own lastSeen and lets a
  // silent one age out.
  const intervalMs =
    options.intervalMs ??
    Math.min(5_000, Math.max(1_000, Math.floor(registry.ttlMs / 3)));
  const timer = setInterval(() => {
    stopBrowsers();
    startBrowsers();
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
      stopBrowsers();
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

  const host = connectHost(service);
  if (host === "") {
    return undefined;
  }
  return {
    id,
    name,
    serviceType,
    host,
    port,
    txt,
  };
}

/**
 * The host to actually dial for a discovered service.
 *
 * A DNS-SD SRV record carries a hostname RELATIVE to the `.local` domain, so
 * `service.host` comes back as something like `artemis` - which does not
 * resolve on its own (`ENOTFOUND`); only `artemis.local` does. Preferring it,
 * as this did, meant every discovered peer was reported correctly and then
 * failed to connect, on the one path that matters most: calling a peer on
 * another machine. Confirmed against a live browse, where the service carried
 * a perfectly good `192.168.12.100` that was ignored in favour of the
 * unresolvable name.
 *
 * An address needs no name resolution at all, so IPv4 wins; IPv6 link-local
 * addresses carry a zone that this record has nowhere to keep. The hostname is
 * the fallback, with the `.local` suffix restored when it is a bare label.
 */
function connectHost(service: BonjourDiscoveredService): string {
  const usable = (address: string | undefined): string | undefined => {
    if (!isIPv4(address ?? "")) return undefined;
    const octets = address!.split(".").map(Number);
    if (octets[0] === 0 || octets[0] === 127) return undefined;
    if (octets[0] === 169 && octets[1] === 254) return undefined;
    return address;
  };

  const refererAddress = usable(service.referer?.address);
  if (refererAddress !== undefined) return refererAddress;
  const ipv4 = service.addresses?.find(
    (address) => usable(address) !== undefined,
  );
  if (ipv4 !== undefined) return usable(ipv4)!;

  let host = (service.host ?? "").replace(/\.$/, "");
  if (host.includes(":")) {
    host = host.split("%", 1)[0]!;
  }
  return host.length > 0 && !host.includes(".") && !host.includes(":")
    ? `${host}.local`
    : host;
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
