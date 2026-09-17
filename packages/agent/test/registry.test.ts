// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { PeerRegistry } from "../src/index.js";

const peer = {
  id: "agent-1",
  name: "Agent 1",
  serviceType: "mesh" as const,
  host: "agent.local",
  port: 7330,
  txt: { id: "agent-1" },
};

describe("peer registry", () => {
  it("adds and updates peers by service and id", () => {
    let now = 100;
    const registry = new PeerRegistry({ ttlMs: 30, now: () => now });

    registry.add(peer);
    expect(registry.peers).toHaveLength(1);
    now = 110;
    registry.upsert({ ...peer, name: "Updated" });

    expect(registry.peers).toEqual([
      { ...peer, name: "Updated", lastSeen: 110 },
    ]);
  });

  it("keeps a peer at TTL minus one and expires it at TTL plus one", () => {
    let now = 1_000;
    const registry = new PeerRegistry({ ttlMs: 30, now: () => now });
    registry.add(peer);

    now = 1_029;
    expect(registry.prune()).toEqual([]);
    expect(registry.peers).toHaveLength(1);
    now = 1_031;
    expect(registry.prune()).toHaveLength(1);
    expect(registry.peers).toEqual([]);
  });

  it("prunes deterministically at an injected time", () => {
    const registry = new PeerRegistry({ ttlMs: 30, now: () => 0 });
    registry.add({ ...peer, lastSeen: 5 });

    expect(registry.prune(34)).toEqual([]);
    expect(registry.prune(35)).toHaveLength(1);
  });
});
