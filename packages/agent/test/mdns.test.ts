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
    // exactOptionalPropertyTypes: an explicit undefined is not assignable to an
    // optional property, so only set the key when there is a handler.
    this.finds.push(
      onup === undefined
        ? { type: options.type }
        : { type: options.type, onup },
    );
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
          caps: "mesh.peers,session.list",
        },
      },
    ]);
    expect(Object.keys(bonjour.published[0]?.txt ?? {}).sort()).toEqual([
      "agent_version",
      "caps",
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
    expect(Object.keys(txt)).toHaveLength(5);
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

  it("dials a discovered service by address, not by its unresolvable SRV hostname", async () => {
    // A DNS-SD SRV host is relative to the `.local` domain, so bonjour reports
    // it as a bare label like "artemis", which does not resolve on its own.
    // The record also carries usable addresses, and preferring the hostname
    // meant every discovered peer was described correctly and then failed to
    // connect with ENOTFOUND - on the one path that matters, reaching an agent
    // on another machine. Every existing test used an already-dotted
    // "agent.local", which is why this survived from M0 through M1-11.
    const registry = new PeerRegistry();
    const bonjour = new FakeBonjour();
    const handle = browsePeers(registry, { bonjour });
    const up = bonjour.finds[0]?.onup;
    const base = {
      name: "B",
      port: 7330,
      txt: { id: "b", name: "B", port: "7330" },
    };

    // An address needs no name resolution, so it wins over the SRV hostname.
    up?.({
      ...base,
      host: "artemis",
      addresses: ["192.168.12.100", "fe80::1"],
    });
    expect(registry.get("mesh", "b")?.host).toBe("192.168.12.100");

    // With no address, a bare label is a `.local` name and must be completed.
    up?.({ ...base, host: "artemis", addresses: [] });
    expect(registry.get("mesh", "b")?.host).toBe("artemis.local");

    // IPv6-only answers must use the SRV hostname rather than an undialable
    // literal from the responder's UDP source.
    up?.({
      ...base,
      host: "artemis",
      addresses: ["fe80::1"],
      referer: { address: "fe80::1" },
    });
    expect(registry.get("mesh", "b")?.host).toBe("artemis.local");

    // IPv6 literals are never suffixed or selected as direct addresses.
    up?.({ ...base, host: "fe80::1", addresses: ["fe80::1"] });
    expect(registry.get("mesh", "b")?.host).toBe("fe80::1");

    // A fully-qualified SRV name can carry a trailing root label.
    up?.({ ...base, host: "artemis.", addresses: [] });
    expect(registry.get("mesh", "b")?.host).toBe("artemis.local");

    // An out-of-range IPv4 must not bypass hostname resolution.
    up?.({
      ...base,
      host: "artemis",
      addresses: ["999.999.999.999"],
    });
    expect(registry.get("mesh", "b")?.host).toBe("artemis.local");

    // An already-qualified name is left alone.
    up?.({ ...base, host: "agent.local", addresses: [] });
    expect(registry.get("mesh", "b")?.host).toBe("agent.local");

    // The responder's IPv4 address is safe to use as a fallback.
    up?.({
      ...base,
      addresses: [],
      referer: { address: "10.0.0.5" },
    });
    expect(registry.get("mesh", "b")?.host).toBe("10.0.0.5");

    await handle.stop();
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
      const newestMeshBrowser = ():
        ((service: BonjourDiscoveredService) => void) | undefined =>
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
