// SPDX-License-Identifier: GPL-3.0-or-later

export type PeerServiceType = "mesh" | "control";

export interface PeerRecord {
  id: string;
  name: string;
  serviceType: PeerServiceType;
  host: string;
  port: number;
  txt: Record<string, string>;
  lastSeen: number;
}

export type PeerInput = Omit<PeerRecord, "lastSeen"> &
  Partial<Pick<PeerRecord, "lastSeen">>;

export interface PeerRegistryOptions {
  ttlMs?: number;
  now?: () => number;
}

export class PeerRegistry {
  readonly ttlMs: number;
  private readonly now: () => number;
  private readonly records = new Map<string, PeerRecord>();

  constructor(options: PeerRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("Peer registry TTL must be greater than zero");
    }
  }

  add(peer: PeerInput): PeerRecord {
    const record = this.record(peer);
    this.records.set(this.key(record), record);
    return record;
  }

  upsert(peer: PeerInput): PeerRecord {
    return this.add(peer);
  }

  prune(at = this.now()): PeerRecord[] {
    const expired: PeerRecord[] = [];
    for (const [key, peer] of this.records) {
      if (at - peer.lastSeen >= this.ttlMs) {
        this.records.delete(key);
        expired.push(peer);
      }
    }
    return expired;
  }

  get peers(): PeerRecord[] {
    return [...this.records.values()];
  }

  get(serviceType: PeerServiceType, id: string): PeerRecord | undefined {
    return this.records.get(`${serviceType}:${id}`);
  }

  list(): PeerRecord[] {
    return this.peers;
  }

  toJSON(): PeerRecord[] {
    return this.peers;
  }

  private record(peer: PeerInput): PeerRecord {
    return {
      id: peer.id,
      name: peer.name,
      serviceType: peer.serviceType,
      host: peer.host,
      port: peer.port,
      txt: { ...peer.txt },
      lastSeen: peer.lastSeen ?? this.now(),
    };
  }

  private key(peer: PeerRecord): string {
    return `${peer.serviceType}:${peer.id}`;
  }
}

export function createPeerRegistry(
  options?: PeerRegistryOptions,
): PeerRegistry {
  return new PeerRegistry(options);
}
