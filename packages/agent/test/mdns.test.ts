// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import {
  browsePeers,
  PeerRegistry,
  publishAgent,
  SERVICE_TYPE_CONTROL,
  SERVICE_TYPE_MESH,
} from "../src/index.js";
import type {
  BonjourBrowserLike,
  BonjourDiscoveredService,
  BonjourLike,
  BonjourPublishOptions,
} from "../src/index.js";

class FakeBrowser implements BonjourBrowserLike {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeBonjour implements BonjourLike {
  published: BonjourPublishOptions[] = [];
  finds: {
    type: string;
    onup?: (service: BonjourDiscoveredService) => void;
  }[] = [];
  destroyed = false;
  browsers: FakeBrowser[] = [];

  publish(options: BonjourPublishOptions): void {
    this.published.push(options);
  }

  find(
    options: { type: string },
    onup?: (service: BonjourDiscoveredService) => void,
  ): FakeBrowser {
    this.finds.push({ type: options.type, onup });
    const browser = new FakeBrowser();
    this.browsers.push(browser);
    return browser;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

const descriptor = {
  id: "agent-1",
  name: "Agent 1",
  version: "1.0.0",
  agentVersion: "0.0.0",
  port: 7330,
  fingerprint: "fp-1",
  capabilities: ["mesh.peers", "session.list"],
};

describe("agent mDNS", () => {
  it("publishes the mesh record using bonjour's bare service name", async () => {
    const bonjour = new FakeBonjour();

    const handle = await publishAgent(descriptor, {
      bonjour,
      swarmKey: new Uint8Array(32),
    });

    expect(bonjour.published).toEqual([
      {
        type: "pi-mesh",
        name: "Agent 1",
        port: 7330,
        txt: {
          id: "agent-1",
          name: "Agent 1",
          version: "1.0.0",
          agent_version: "0.0.0",
          port: "7330",
          fp: "fp-1",
          caps: "mesh.peers,session.list",
        },
      },
    ]);
    expect(Object.keys(bonjour.published[0]?.txt ?? {}).sort()).toEqual([
      "agent_version",
      "caps",
      "fp",
      "id",
      "name",
      "port",
      "version",
    ]);
    await handle.stop();
    expect(bonjour.destroyed).toBe(true);
  });

  it("omits caps when the agent supports no skills", async () => {
    // mDNS TXT attributes are `key=value` with no separate value concept, so an
    // empty value reaches the wire as `caps=`. Readers then disagree: the
    // publisher's own parser drops the entry, a remote one returns a key
    // literally named "caps=". Omitting the key is the only round-trippable
    // encoding, and it means the same thing to a reader.
    const bonjour = new FakeBonjour();
    await publishAgent(
      { ...descriptor, capabilities: [] },
      {
        bonjour,
        swarmKey: new Uint8Array(32),
      },
    );

    const txt = (bonjour.published[0]?.txt ?? {}) as Record<string, string>;
    expect(Object.keys(txt)).not.toContain("caps");
    expect(Object.keys(txt)).not.toContain("caps=");
    expect(Object.keys(txt)).toHaveLength(6);
  });

  it.each([
    ["without a swarm key", {}],
    [
      "with the public profile",
      { swarmKey: new Uint8Array(32), profile: "public" as const },
    ],
  ])("publishes nothing %s", async (_reason, options) => {
    const bonjour = new FakeBonjour();
    await publishAgent(descriptor, { bonjour, ...options });
    expect(bonjour.published).toEqual([]);
    expect(bonjour.destroyed).toBe(false);
  });

  it("browses mesh and control using bare bonjour names and records peers", async () => {
    let now = 100;
    const registry = new PeerRegistry({ ttlMs: 30, now: () => now });
    const bonjour = new FakeBonjour();
    const handle = browsePeers(registry, { bonjour });

    expect(bonjour.finds.map((find) => find.type)).toEqual([
      "pi-mesh",
      "pi-mesh-control",
    ]);
    bonjour.finds[0]?.onup?.({
      name: "Agent 1",
      host: "agent.local",
      port: 7330,
      txt: { id: "agent-1", name: "Agent 1", port: "7330" },
    });
    expect(registry.peers[0]).toMatchObject({
      id: "agent-1",
      serviceType: "mesh",
      host: "agent.local",
      port: 7330,
      lastSeen: 100,
    });
    now = 131;
    registry.prune();
    expect(registry.peers).toEqual([]);
    await handle.stop();
    expect(bonjour.destroyed).toBe(true);
    expect(bonjour.browsers.every((browser) => browser.stopped)).toBe(true);
    expect(SERVICE_TYPE_MESH).toBe("_pi-mesh._tcp");
    expect(SERVICE_TYPE_CONTROL).toBe("_pi-mesh-control._tcp");
  });

  it("refreshes a live peer on re-query and ages out a silent one", () => {
    // The regression: lastSeen used to be written only on the discovery
    // callback, and a responder does not re-announce an unchanged record, so a
    // blind TTL prune removed peers that were still running. Verified live
    // before this fix - a peer alive for the whole run vanished at ~30s.
    vi.useFakeTimers();
    try {
      let now = 0;
      const registry = new PeerRegistry({ ttlMs: 30, now: () => now });
      const bonjour = new FakeBonjour();
      const handle = browsePeers(registry, { bonjour, intervalMs: 10 });
      const service = {
        name: "Agent 1",
        host: "agent.local",
        port: 7330,
        txt: { id: "agent-1", name: "Agent 1", port: "7330" },
      };
      const newestMeshBrowser = (): ((service: unknown) => void) | undefined =>
        bonjour.finds.at(-2)?.onup;

      bonjour.finds[0]?.onup?.(service);
      expect(registry.peers).toHaveLength(1);

      // Three cycles: each re-query is answered, so the peer stays despite
      // having outlived its TTL in wall-clock terms.
      for (let cycle = 0; cycle < 3; cycle += 1) {
        now += 20;
        vi.advanceTimersByTime(10);
        const onup = newestMeshBrowser();
        onup?.(service);
      }
      expect(registry.peers).toHaveLength(1);

      // Now it goes silent: no further answers, so it ages out.
      now += 31;
      vi.advanceTimersByTime(10);
      expect(registry.peers).toEqual([]);

      return handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not browse in the public profile", () => {
    const bonjour = new FakeBonjour();
    const handle = browsePeers(new PeerRegistry(), {
      bonjour,
      profile: "public",
    });
    expect(bonjour.finds).toEqual([]);
    return handle.stop();
  });
});
