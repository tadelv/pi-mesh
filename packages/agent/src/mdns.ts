// SPDX-License-Identifier: GPL-3.0-or-later

import { isIPv4 } from "node:net";
import Bonjour from "bonjour-service";
import createMulticastDns from "multicast-dns";
import {
  SERVICE_TYPE_CONTROL,
  SERVICE_TYPE_MESH,
  chunkTxtValue,
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

/**
 * What `publish()` returns when the library completed the announce: a
 * bonjour-service `Service` emits `up` after its probe/announce round
 * (`lib/registry.js:105`) and `down` when withdrawn. A publish that never
 * reaches `up` is a machine that answers nobody - and until this was observed
 * there was no way to tell that from a peer that simply was not there.
 */
export interface BonjourPublishedLike {
  on?: (event: "up" | "down", listener: () => void) => void;
}

/** Publishing still goes through bonjour-service; browsing no longer does. */
export interface BonjourLike {
  publish(options: BonjourPublishOptions): unknown;
  destroy(): void | PromiseLike<void>;
}

export interface MdnsQuestion {
  name: string;
  type: string;
}

export interface MdnsRecord {
  name: string;
  type: string;
  ttl: number;
  data: unknown;
}

export interface MdnsResponse {
  answers?: readonly MdnsRecord[];
  additionals?: readonly MdnsRecord[];
}

export interface MdnsResponder {
  address?: string;
}

export type MdnsResponseHandler = (
  response: MdnsResponse,
  rinfo: MdnsResponder,
) => void;

/**
 * The slice of the multicast-dns socket the browser uses: ask, listen,
 * close. Inject a fake through `BrowseOptions.createMdns` in tests so no
 * socket is opened - the same pattern `bonjour` used for publishing.
 */
export interface MdnsSocketLike {
  query(questions: readonly MdnsQuestion[]): void;
  on(event: "response", handler: MdnsResponseHandler): void;
  destroy(): void;
}

export type MdnsFactory = () => MdnsSocketLike;

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
    // Chunked because one mDNS TXT string cannot exceed 255 bytes and the skill
    // list passed that at 20 capabilities; see chunkTxtValue.
    ...chunkTxtValue(
      TXT_KEY_CAPABILITIES,
      descriptor.capabilities.join(","),
    ),
  });
}

export async function publishAgent(
  descriptor: AgentDescriptor,
  options: {
    bonjour?: BonjourLike;
    profile?: NetworkProfile;
    swarmKey?: Uint8Array;
    /** Where the announce is reported; silence in this path used to be invisible. */
    log?: (line: string) => void;
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
  const txt = buildAgentTxtRecord(descriptor);
  const published = bonjour.publish({
    // bonjour-service composes `_<name>._<protocol>` itself. The DNS-SD
    // constant must therefore be converted to its bare service name.
    type: toBonjourServiceName(SERVICE_TYPE_MESH),
    name: descriptor.name,
    port: descriptor.port,
    txt,
  }) as BonjourPublishedLike | undefined;
  const log = options.log;
  if (log !== undefined) {
    log(
      `mdns: published ${SERVICE_TYPE_MESH} name=${descriptor.name} port=${descriptor.port} caps=${descriptor.capabilities.length} txt=${Object.keys(txt).join(",")}`,
    );
    if (typeof published?.on === "function") {
      published.on("up", () =>
        log(`mdns: announced ${descriptor.name} (probe complete)`),
      );
      published.on("down", () => log(`mdns: withdrawn ${descriptor.name}`));
    } else {
      log(
        `mdns: ${descriptor.name}: publish returned no event handle, so the announce cannot be observed`,
      );
    }
  }

  return {
    stop: async () => {
      await bonjour.destroy();
    },
  };
}

export interface BrowseOptions {
  /** Factory for the query socket; defaults to a real multicast-dns client. */
  createMdns?: MdnsFactory;
  profile?: NetworkProfile;
  intervalMs?: number;
  onPeer?: (peer: PeerRecord) => void;
  /** Every sighting, so "the peer is not there" can be told from "we never heard it". */
  log?: (line: string) => void;
}

export interface BrowseHandle {
  stop: () => Promise<void>;
}

const BROWSED_SERVICES: ReadonlyArray<{
  serviceType: string;
  peerServiceType: PeerServiceType;
}> = [
  { serviceType: SERVICE_TYPE_MESH, peerServiceType: "mesh" },
  { serviceType: SERVICE_TYPE_CONTROL, peerServiceType: "control" },
];

/**
 * Browse by asking the wire directly instead of through bonjour-service.
 *
 * Two macOS machines (phobos, artemis, 2026-11-07) advertised fine but never
 * surfaced each other through bonjour-service's find(), while a raw
 * multicast-dns PTR query on the same host got an answer. Publishing was
 * never the problem, so publishing stays on bonjour-service and only the
 * browse half speaks DNS-SD here: PTR for each service type on an interval,
 * assembled per instance name from whatever packets arrive.
 */
export function browsePeers(
  registry: PeerRegistry,
  options: BrowseOptions = {},
): BrowseHandle {
  if (options.profile === "public") {
    return NOOP_HANDLE;
  }

  const socket = (options.createMdns ?? defaultMdnsFactory)();
  const assembler = new DnsSdAssembler(registry, options);
  socket.on("response", (response, rinfo) => {
    assembler.handleResponse(response, rinfo);
  });

  const queryAll = (): void => {
    socket.query(
      BROWSED_SERVICES.map(({ serviceType }) => ({
        name: `${serviceType}.local`,
        type: "PTR",
      })),
    );
  };
  queryAll();

  // A responder does not re-announce an unchanged record, so lastSeen would
  // never refresh and a blind prune would drop peers that are still alive.
  // Re-querying lets a live peer refresh its own lastSeen on re-answer and
  // lets a silent one age out.
  const intervalMs = options.intervalMs ?? 3_000;
  const timer = setInterval(() => {
    queryAll();
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
      socket.destroy();
    },
  };
}

function defaultMdnsFactory(): MdnsSocketLike {
  return createMulticastDns();
}

interface InstanceState {
  serviceType: PeerServiceType;
  instance: string;
  hasPtr: boolean;
  srv?: { target: string; port: number };
  txt?: Record<string, string>;
  responder?: string;
}

/**
 * Turns DNS-SD answer records into registry peers, one instance at a time.
 *
 * A PTR answer names an instance; the instance's SRV gives target+port; TXT
 * gives the keys; an A record gives IPv4. A response may carry the pieces in
 * any order or across separate packets, and one packet may carry several
 * services, so state accumulates per instance name and an instance is only
 * emitted once PTR+SRV+TXT are all known. A discovered TXT value is a
 * routing label, never identity (ADR 0007): it is read for addressing and
 * never authorises anything.
 */
class DnsSdAssembler {
  private readonly instances = new Map<string, InstanceState>();
  private readonly aRecords = new Map<string, string[]>();
  private readonly aaaaRecords = new Map<string, string[]>();

  constructor(
    private readonly registry: PeerRegistry,
    private readonly options: BrowseOptions,
  ) {}

  handleResponse(response: MdnsResponse, rinfo: MdnsResponder): void {
    const records = [
      ...(response.answers ?? []),
      ...(response.additionals ?? []),
    ];
    for (const record of records) {
      this.handleRecord(record, rinfo.address);
    }
  }

  private handleRecord(
    record: MdnsRecord,
    responder: string | undefined,
  ): void {
    const name = normalizeDnsName(record.name);
    const type = record.type.toUpperCase();
    const ttl = typeof record.ttl === "number" ? record.ttl : 120;
    if (name === "" || type === "") {
      return;
    }
    switch (type) {
      case "PTR":
        this.handlePtr(name, record.data, ttl, responder);
        return;
      case "SRV":
        this.handleSrv(name, record.data, ttl, responder);
        return;
      case "TXT":
        this.handleTxt(name, record.data, ttl, responder);
        return;
      case "A":
        this.handleAddress(this.aRecords, name, record.data, ttl);
        break;
      case "AAAA":
        this.handleAddress(this.aaaaRecords, name, record.data, ttl);
        break;
      default:
        return;
    }
    // An address belongs to an SRV target, which may serve several
    // instances; re-resolve each of them against the new address set.
    for (const state of this.instances.values()) {
      if (state.srv?.target === name) {
        this.reconcile(state);
      }
    }
  }

  private handlePtr(
    serviceName: string,
    data: unknown,
    ttl: number,
    responder: string | undefined,
  ): void {
    const browsed = BROWSED_SERVICES.find(
      ({ serviceType }) => `${serviceType}.local` === serviceName,
    );
    if (browsed === undefined || typeof data !== "string") {
      return;
    }
    const instance = normalizeDnsName(data);
    if (instance === "") {
      return;
    }
    if (ttl === 0) {
      this.goodbye(instance, "PTR");
      return;
    }
    const state = this.stateFor(instance, browsed.peerServiceType);
    state.hasPtr = true;
    if (responder !== undefined) {
      state.responder = responder;
    }
    this.reconcile(state);
  }

  private handleSrv(
    name: string,
    data: unknown,
    ttl: number,
    responder: string | undefined,
  ): void {
    const peerServiceType = serviceTypeForInstance(name);
    if (peerServiceType === undefined) {
      return;
    }
    if (ttl === 0) {
      this.goodbye(name, "SRV");
      return;
    }
    const srv = parseSrvData(data);
    if (srv === undefined) {
      this.options.log?.(`mdns: ignoring malformed SRV for ${name}`);
      return;
    }
    const state = this.stateFor(name, peerServiceType);
    state.srv = srv;
    if (responder !== undefined) {
      state.responder = responder;
    }
    this.reconcile(state);
  }

  private handleTxt(
    name: string,
    data: unknown,
    ttl: number,
    responder: string | undefined,
  ): void {
    const peerServiceType = serviceTypeForInstance(name);
    if (peerServiceType === undefined) {
      return;
    }
    if (ttl === 0) {
      this.goodbye(name, "TXT");
      return;
    }
    const state = this.stateFor(name, peerServiceType);
    state.txt = parseTxtData(data);
    if (responder !== undefined) {
      state.responder = responder;
    }
    this.reconcile(state);
  }

  private handleAddress(
    table: Map<string, string[]>,
    name: string,
    data: unknown,
    ttl: number,
  ): void {
    if (typeof data !== "string" || data === "") {
      return;
    }
    if (ttl === 0) {
      const kept = (table.get(name) ?? []).filter(
        (address) => address !== data,
      );
      if (kept.length === 0) {
        table.delete(name);
      } else {
        table.set(name, kept);
      }
      return;
    }
    const known = table.get(name) ?? [];
    if (!known.includes(data)) {
      table.set(name, [...known, data]);
    }
  }

  private stateFor(
    instance: string,
    serviceType: PeerServiceType,
  ): InstanceState {
    let state = this.instances.get(instance);
    if (state === undefined) {
      state = { serviceType, instance, hasPtr: false };
      this.instances.set(instance, state);
    }
    return state;
  }

  /**
   * A TTL-0 record is a goodbye: forget the instance and drop a peer that
   * was assembled from it, so the registry's prune() is not the only way a
   * withdrawn advertisement disappears.
   */
  private goodbye(instance: string, recordType: string): void {
    const state = this.instances.get(instance);
    this.instances.delete(instance);
    if (state?.srv !== undefined) {
      this.aRecords.delete(state.srv.target);
      this.aaaaRecords.delete(state.srv.target);
    }
    const id = state?.txt?.[TXT_KEY_ID];
    if (state === undefined || id === undefined || id === "") {
      return;
    }
    if (this.registry.get(state.serviceType, id) !== undefined) {
      this.registry.remove(state.serviceType, id);
      this.options.log?.(
        `mdns: goodbye ${instance}: TTL 0 for ${recordType}, removing ${state.serviceType}:${id}`,
      );
    }
  }

  private reconcile(state: InstanceState): void {
    // Pieces may arrive in any order or in separate packets: stay silent
    // until PTR+SRV+TXT are all known.
    if (!state.hasPtr || state.srv === undefined || state.txt === undefined) {
      return;
    }
    const id = state.txt[TXT_KEY_ID];
    if (id === undefined || id === "") {
      this.options.log?.(
        `mdns: skipping ${state.instance}: TXT record has no id, so there is no peer to name (TXT values are routing labels, never identity)`,
      );
      return;
    }
    const port = state.srv.port;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      this.options.log?.(
        `mdns: skipping ${state.instance}: SRV port ${String(port)} is not a dialable port`,
      );
      return;
    }
    const addresses = this.aRecords.get(state.srv.target) ?? [];
    const host = selectHost(addresses, state.responder);
    if (host === undefined) {
      this.options.log?.(
        `mdns: skipping ${state.instance}: no IPv4 host for ${state.srv.target} (AAAA records are never used as a dial address)`,
      );
      return;
    }
    const name =
      state.txt[TXT_KEY_NAME] ?? shortInstanceName(state.instance) ?? id;
    this.options.log?.(
      `mdns: saw ${dnsServiceType(state.serviceType)} name=${name} host=${host} port=${String(port)} addresses=${addresses.join("|") || "none"}`,
    );
    const peer: PeerInput = {
      id,
      name,
      serviceType: state.serviceType,
      host,
      port,
      txt: state.txt,
    };
    const known = this.registry.get(state.serviceType, id) !== undefined;
    const record = this.registry.upsert(peer);
    // Only a genuinely new peer is a discovery event; a re-answer to the
    // periodic re-query is a liveness refresh and must stay quiet.
    if (!known) {
      this.options.onPeer?.(record);
    }
  }
}

function dnsServiceType(peerServiceType: PeerServiceType): string {
  return peerServiceType === "control"
    ? SERVICE_TYPE_CONTROL
    : SERVICE_TYPE_MESH;
}

/** Wire names vary in case and in the trailing root label; compare folded. */
function normalizeDnsName(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\.$/, "").toLowerCase()
    : "";
}

function serviceTypeForInstance(
  instanceName: string,
): PeerServiceType | undefined {
  for (const { serviceType, peerServiceType } of BROWSED_SERVICES) {
    if (instanceName.endsWith(`${serviceType}.local`)) {
      return peerServiceType;
    }
  }
  return undefined;
}

function shortInstanceName(instanceName: string): string | undefined {
  const serviceType = serviceTypeForInstance(instanceName);
  if (serviceType === undefined) {
    return undefined;
  }
  const short = instanceName.slice(
    0,
    -(dnsServiceType(serviceType).length + ".local".length + 1),
  );
  return short === "" ? undefined : short;
}

function parseSrvData(
  data: unknown,
): { target: string; port: number } | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const { port, target } = data as { port?: unknown; target?: unknown };
  const normalisedTarget = normalizeDnsName(target);
  if (typeof port !== "number" || normalisedTarget === "") {
    return undefined;
  }
  return { target: normalisedTarget, port };
}

/**
 * dns-packet decodes a TXT rdata into one Buffer per `key=value` string.
 * Accept the neighbouring shapes too (a lone Buffer, plain strings) so a
 * hand-built fixture and the real decoder agree on what parses. Keys fold to
 * lowercase: DNS-SD TXT keys are case-insensitive and the publisher emits
 * them lowercase. The first occurrence of a key wins.
 */
function parseTxtData(data: unknown): Record<string, string> {
  const parts: unknown[] = Array.isArray(data) ? data : [data];
  const out: Record<string, string> = {};
  for (const part of parts) {
    let text: string | undefined;
    if (typeof part === "string") {
      text = part;
    } else if (Buffer.isBuffer(part)) {
      text = part.toString("utf8");
    } else if (part instanceof Uint8Array) {
      text = Buffer.from(part).toString("utf8");
    }
    if (text === undefined) {
      continue;
    }
    const separator = text.indexOf("=");
    const key =
      separator === -1
        ? text.toLowerCase()
        : text.slice(0, separator).toLowerCase();
    if (key === "" || key in out) {
      continue;
    }
    out[key] = separator === -1 ? "" : text.slice(separator + 1);
  }
  return out;
}

/**
 * The host to actually dial for a discovered instance.
 *
 * An A record for the SRV target needs no name resolution at all, so it
 * wins; anything `node:net` accepts as IPv4 is dialable, including loopback
 * (a test peer lives there). Otherwise the responder's address is the only
 * observed address for the instance. AAAA records are never used: an IPv6
 * literal has no place in this record, and a zone-suffixed link-local one
 * cannot be carried inside a bracketed URL host. When neither exists there
 * is no host to report, and the instance is skipped rather than guessed.
 */
function selectHost(
  addresses: readonly string[],
  responder: string | undefined,
): string | undefined {
  const ipv4 = addresses.find((address) => isIPv4(address));
  if (ipv4 !== undefined) {
    return ipv4;
  }
  return responder !== undefined && isIPv4(responder) ? responder : undefined;
}

export { SERVICE_TYPE_CONTROL, SERVICE_TYPE_MESH, toBonjourServiceName };
export type { PeerRecord } from "./registry.js";
