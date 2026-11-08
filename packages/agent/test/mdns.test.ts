// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import {
  browsePeers,
  PeerRegistry,
  publishAgent,
  SERVICE_TYPE_CONTROL,
  SERVICE_TYPE_MESH,
  buildAgentTxtRecord,
} from "../src/index.js";
import { joinTxtValue } from "@pi-mesh/protocol";
import type {
  BonjourLike,
  BonjourPublishOptions,
  MdnsQuestion,
  MdnsResponder,
  MdnsResponse,
  MdnsResponseHandler,
  MdnsSocketLike,
} from "../src/index.js";

class FakeBonjour implements BonjourLike {
  published: BonjourPublishOptions[] = [];
  destroyed = false;

  publish(options: BonjourPublishOptions): void {
    this.published.push(options);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

/**
 * A multicast-dns socket stand-in: records every query and replays canned
 * response packets on demand, so the browser is driven without a socket.
 */
class FakeMdnsSocket implements MdnsSocketLike {
  queries: MdnsQuestion[][] = [];
  destroyed = false;
  private handlers: MdnsResponseHandler[] = [];

  constructor(private readonly onQuery?: (socket: FakeMdnsSocket) => void) {}

  query(questions: readonly MdnsQuestion[]): void {
    this.queries.push([...questions]);
    this.onQuery?.(this);
  }

  on(event: "response", handler: MdnsResponseHandler): void {
    if (event === "response") {
      this.handlers.push(handler);
    }
  }

  destroy(): void {
    this.destroyed = true;
  }

  respond(response: MdnsResponse, rinfo: MdnsResponder = {}): void {
    for (const handler of [...this.handlers]) {
      handler(response, rinfo);
    }
  }
}

interface DnsRecord {
  name: string;
  type: string;
  ttl: number;
  data: unknown;
}

const ptr = (service: string, instance: string, ttl = 120): DnsRecord => ({
  name: `${service}.local`,
  type: "PTR",
  ttl,
  data: `${instance}.${service}.local`,
});

const srv = (
  service: string,
  instance: string,
  target: string,
  port: number,
  ttl = 120,
): DnsRecord => ({
  name: `${instance}.${service}.local`,
  type: "SRV",
  ttl,
  data: { port, target },
});

const txt = (
  service: string,
  instance: string,
  entries: string[],
  ttl = 120,
): DnsRecord => ({
  name: `${instance}.${service}.local`,
  type: "TXT",
  ttl,
  data: entries.map((entry) => Buffer.from(entry)),
});

const a = (target: string, address: string, ttl = 120): DnsRecord => ({
  name: target,
  type: "A",
  ttl,
  data: address,
});

const aaaa = (target: string, address: string, ttl = 120): DnsRecord => ({
  name: target,
  type: "AAAA",
  ttl,
  data: address,
});

const descriptor = {
  id: "agent-1",
  name: "Agent 1",
  version: "1.0.0",
  agentVersion: "0.0.0",
  port: 7330,
  capabilities: ["mesh.peers", "session.list"],
};

describe("agent mDNS", () => {
  it("no TXT value exceeds one mDNS string, and the caps rejoin exactly", () => {
    // An mDNS TXT string is length-prefixed with one byte, so 255 bytes is the
    // hard ceiling. At 20 capabilities the joined list was 269 bytes and macOS's
    // mDNSResponder dropped every response from the machine while the agent was
    // still running and logging a completed announce. Nothing asserted the
    // ceiling, so nothing failed.
    const capabilities = Array.from({ length: 40 }, (_, index) => `skill.number.${index}`);
    const descriptorWith = { ...descriptor, capabilities };
    const txt = buildAgentTxtRecord(descriptorWith);
    for (const [key, value] of Object.entries(txt)) {
      expect(
        Buffer.byteLength(value, "utf8"),
        `TXT key ${key} must fit one mDNS string`,
      ).toBeLessThanOrEqual(255);
    }
    expect(Object.keys(txt).filter((key) => key.startsWith("caps")).length).toBeGreaterThan(1);
    expect(joinTxtValue(txt, "caps")).toBe(capabilities.join(","));
  });

  it("reports the announce, so a mute advertiser is not invisible", async () => {
    // artemis answered no mDNS query for 53 hours while its agent ran and served
    // HTTP, and nothing in the log said so: publish() was called and its result
    // was dropped. The announce event is the one fact that separates "this
    // machine is announcing" from "this machine is silent".
    const lines: string[] = [];
    let announce: (() => void) | undefined;
    const bonjour: BonjourLike = {
      publish: () => ({
        on: (event: "up" | "down", listener: () => void) => {
          if (event === "up") announce = listener;
        },
      }),
      destroy: () => {},
    };

    await publishAgent(descriptor, {
      bonjour,
      swarmKey: new Uint8Array(32),
      log: (line) => lines.push(line),
    });
    expect(lines[0]).toContain("mdns: published");
    expect(lines[0]).toContain("caps=2");
    expect(
      lines.some((line) => line.includes("announced")),
      "nothing claims an announce before the probe completes",
    ).toBe(false);

    expect(announce).toBeTypeOf("function");
    announce?.();
    expect(
      lines.some((line) => line.includes("mdns: announced Agent 1")),
      "the probe completing is reported",
    ).toBe(true);
  });

  it("says so when the library gives no way to observe the announce", async () => {
    const lines: string[] = [];
    const bonjour = new FakeBonjour();
    await publishAgent(descriptor, {
      bonjour,
      swarmKey: new Uint8Array(32),
      log: (line) => lines.push(line),
    });
    expect(
      lines.some((line) => line.includes("cannot be observed")),
      "a library without an event handle is reported, not assumed fine",
    ).toBe(true);
  });

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

  it("queries both service types on the wire and records two peers", async () => {
    // One packet carries PTR+SRV+TXT+A for a mesh instance and a control
    // instance. The TXT `port` deliberately disagrees with the SRV port, so
    // this clause names the SRV as the port's source: resolving the port
    // from anywhere else must fail this test.
    let now = 100;
    const registry = new PeerRegistry({ ttlMs: 30, now: () => now });
    const mdns = new FakeMdnsSocket();
    const seen: string[] = [];
    const lines: string[] = [];
    const handle = browsePeers(registry, {
      createMdns: () => mdns,
      log: (line) => lines.push(line),
      onPeer: (peer) => seen.push(`${peer.serviceType}:${peer.id}`),
    });

    expect(mdns.queries).toEqual([
      [
        { name: "_pi-mesh._tcp.local", type: "PTR" },
        { name: "_pi-mesh-control._tcp.local", type: "PTR" },
      ],
    ]);
    mdns.respond(
      {
        answers: [
          ptr("_pi-mesh._tcp", "agent-1"),
          srv("_pi-mesh._tcp", "agent-1", "agent-1.local", 7330),
          txt("_pi-mesh._tcp", "agent-1", [
            "id=agent-1",
            "name=Agent 1",
            "port=9999",
            "caps=mesh.peers",
          ]),
          a("agent-1.local", "192.168.12.101"),
          ptr("_pi-mesh-control._tcp", "ctrl-1"),
          srv("_pi-mesh-control._tcp", "ctrl-1", "ctrl-1.local", 8443),
          txt("_pi-mesh-control._tcp", "ctrl-1", [
            "id=ctrl-1",
            "name=Control 1",
          ]),
          a("ctrl-1.local", "192.168.12.102"),
        ],
      },
      { address: "192.168.12.100" },
    );

    expect(registry.get("mesh", "agent-1")).toMatchObject({
      id: "agent-1",
      name: "Agent 1",
      serviceType: "mesh",
      host: "192.168.12.101",
      port: 7330,
      txt: {
        id: "agent-1",
        name: "Agent 1",
        port: "9999",
        caps: "mesh.peers",
      },
      lastSeen: 100,
    });
    expect(registry.get("control", "ctrl-1")).toMatchObject({
      id: "ctrl-1",
      name: "Control 1",
      serviceType: "control",
      host: "192.168.12.102",
      port: 8443,
    });
    expect(seen.sort()).toEqual(["control:ctrl-1", "mesh:agent-1"]);
    expect(
      lines.some((line) =>
        line.includes(
          "mdns: saw _pi-mesh._tcp name=Agent 1 host=192.168.12.101 port=7330 addresses=192.168.12.101",
        ),
      ),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes(
          "mdns: saw _pi-mesh-control._tcp name=Control 1 host=192.168.12.102 port=8443",
        ),
      ),
    ).toBe(true);
    now = 131;
    registry.prune();
    expect(registry.peers).toEqual([]);
    await handle.stop();
    expect(mdns.destroyed).toBe(true);
    expect(SERVICE_TYPE_MESH).toBe("_pi-mesh._tcp");
    expect(SERVICE_TYPE_CONTROL).toBe("_pi-mesh-control._tcp");
  });

  it("assembles pieces arriving in separate packets, in any order, and emits once", async () => {
    // The pieces of one instance arrive SRV-first, then TXT+A, then PTR last
    // across three packets. Nothing is emitted until the PTR completes the
    // set, and the re-answered PTR after that is a quiet liveness refresh.
    const registry = new PeerRegistry();
    const mdns = new FakeMdnsSocket();
    let emissions = 0;
    const handle = browsePeers(registry, {
      createMdns: () => mdns,
      onPeer: () => {
        emissions += 1;
      },
    });
    const service = "_pi-mesh._tcp";

    mdns.respond({ answers: [srv(service, "b", "b.local", 7331)] });
    expect(registry.peers).toEqual([]);
    mdns.respond({
      answers: [
        txt(service, "b", ["id=b", "name=B"]),
        a("b.local", "192.168.12.103"),
      ],
    });
    expect(registry.peers).toEqual([]);
    mdns.respond({ answers: [ptr(service, "b")] });
    expect(registry.get("mesh", "b")).toMatchObject({
      host: "192.168.12.103",
      port: 7331,
    });
    expect(emissions).toBe(1);

    mdns.respond({ answers: [ptr(service, "b")] });
    expect(emissions).toBe(1);
    await handle.stop();
  });

  it("emits nothing without an SRV, and names the reason when TXT lacks id", async () => {
    // An instance with TXT but no SRV has no target and no port, so it is
    // not a peer. An instance whose TXT lacks `id` is skipped with a logged
    // reason - never emitted as an unnamed peer whose TXT could then be
    // mistaken for identity (ADR 0007).
    const registry = new PeerRegistry();
    const mdns = new FakeMdnsSocket();
    const lines: string[] = [];
    let emissions = 0;
    const handle = browsePeers(registry, {
      createMdns: () => mdns,
      log: (line) => lines.push(line),
      onPeer: () => {
        emissions += 1;
      },
    });
    const service = "_pi-mesh._tcp";

    mdns.respond({
      answers: [
        ptr(service, "nosrv"),
        txt(service, "nosrv", ["id=nosrv", "name=No SRV"]),
      ],
    });
    expect(registry.peers).toEqual([]);
    expect(emissions).toBe(0);

    mdns.respond({
      answers: [
        ptr(service, "noid"),
        srv(service, "noid", "noid.local", 7332),
        txt(service, "noid", ["name=No Id"]),
        a("noid.local", "192.168.12.104"),
      ],
    });
    expect(registry.get("mesh", "noid")).toBeUndefined();
    expect(registry.peers).toEqual([]);
    expect(emissions).toBe(0);
    expect(
      lines.some((line) => line.includes("noid") && line.includes("no id")),
      `expected a logged reason naming the missing id, saw: ${lines.join("\n")}`,
    ).toBe(true);
    await handle.stop();
  });

  it("removes a previously emitted peer on a TTL-0 goodbye", async () => {
    // Withdrawing an advertisement must disappear from the registry now, not
    // only when the TTL prune happens to age it out. Dropping the removal
    // must fail this clause.
    const registry = new PeerRegistry();
    const mdns = new FakeMdnsSocket();
    const lines: string[] = [];
    const handle = browsePeers(registry, {
      createMdns: () => mdns,
      log: (line) => lines.push(line),
    });
    const service = "_pi-mesh._tcp";
    const full = [
      ptr(service, "gone"),
      srv(service, "gone", "gone.local", 7333),
      txt(service, "gone", ["id=gone", "name=Gone"]),
      a("gone.local", "192.168.12.105"),
    ];
    mdns.respond({ answers: full });
    expect(registry.get("mesh", "gone")).toBeDefined();

    mdns.respond({ answers: [ptr(service, "gone", 0)] });
    expect(registry.get("mesh", "gone")).toBeUndefined();
    expect(registry.peers).toEqual([]);
    expect(
      lines.some((line) => line.includes("goodbye")),
      `expected a logged goodbye, saw: ${lines.join("\n")}`,
    ).toBe(true);
    await handle.stop();
  });

  it("skips an AAAA-only instance with a reason instead of guessing a host", async () => {
    // The SRV target has an AAAA record and the responder speaks IPv6, so
    // there is no IPv4 host to dial. Emitting the peer with the AAAA literal
    // or the hostname would certify an address this record cannot carry.
    const registry = new PeerRegistry();
    const mdns = new FakeMdnsSocket();
    const lines: string[] = [];
    let emissions = 0;
    const handle = browsePeers(registry, {
      createMdns: () => mdns,
      log: (line) => lines.push(line),
      onPeer: () => {
        emissions += 1;
      },
    });
    const service = "_pi-mesh._tcp";
    mdns.respond(
      {
        answers: [
          ptr(service, "v6"),
          srv(service, "v6", "v6.local", 7334),
          txt(service, "v6", ["id=v6", "name=V6"]),
          aaaa("v6.local", "fe80::1"),
        ],
      },
      { address: "fe80::2" },
    );
    expect(registry.peers).toEqual([]);
    expect(emissions).toBe(0);
    expect(
      lines.some((line) => line.includes("v6") && line.includes("AAAA")),
      `expected a logged AAAA-only reason, saw: ${lines.join("\n")}`,
    ).toBe(true);
    await handle.stop();
  });

  it("prefers the SRV target's A record and otherwise dials the responder", async () => {
    // An address needs no name resolution, so the A record wins. With no A
    // record the responder's address - the one observed source - is the
    // host. An AAAA record is never selected, even when it is the only
    // address record and the responder answers over IPv4.
    const registry = new PeerRegistry();
    const mdns = new FakeMdnsSocket();
    const handle = browsePeers(registry, { createMdns: () => mdns });
    const service = "_pi-mesh._tcp";
    const announce = (
      instance: string,
      target: string,
      extra: DnsRecord[],
      responder: string,
    ): void => {
      mdns.respond(
        {
          answers: [
            ptr(service, instance),
            srv(service, instance, target, 7330),
            txt(service, instance, [`id=${instance}`, `name=${instance}`]),
            ...extra,
          ],
        },
        { address: responder },
      );
    };

    announce("a", "a.local", [a("a.local", "192.168.12.100")], "10.0.0.9");
    expect(registry.get("mesh", "a")?.host).toBe("192.168.12.100");

    announce("b", "b.local", [], "10.0.0.9");
    expect(registry.get("mesh", "b")?.host).toBe("10.0.0.9");

    announce("c", "c.local", [aaaa("c.local", "fe80::1")], "10.0.0.10");
    expect(registry.get("mesh", "c")?.host).toBe("10.0.0.10");

    await handle.stop();
  });

  it("stop() ends the query interval and destroys the socket", () => {
    // Fake timers own the interval: after stop() no further query may go
    // out, however far the clock advances.
    vi.useFakeTimers();
    try {
      const mdns = new FakeMdnsSocket();
      const handle = browsePeers(new PeerRegistry(), {
        createMdns: () => mdns,
        intervalMs: 1_000,
      });
      expect(mdns.queries).toHaveLength(1);
      vi.advanceTimersByTime(5_000);
      expect(mdns.queries).toHaveLength(6);
      const stopped = handle.stop();
      expect(mdns.destroyed).toBe(true);
      vi.advanceTimersByTime(5_000);
      expect(mdns.queries).toHaveLength(6);
      return stopped;
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes a live peer on re-query and ages out a silent one", () => {
    // The regression: lastSeen used to be written only on the discovery
    // callback, and a responder does not re-announce an unchanged record, so a
    // blind TTL prune removed peers that were still running. Verified live
    // before this fix - a peer alive for the whole run vanished at ~30s.
    // Here the re-query itself is the liveness signal: every interval emits
    // a query, and only an answered one refreshes.
    vi.useFakeTimers();
    try {
      let now = 0;
      const registry = new PeerRegistry({ ttlMs: 30, now: () => now });
      const service = "_pi-mesh._tcp";
      let answering = true;
      const mdns = new FakeMdnsSocket((socket) => {
        if (answering) {
          socket.respond({
            answers: [
              ptr(service, "agent-1"),
              srv(service, "agent-1", "agent-1.local", 7330),
              txt(service, "agent-1", ["id=agent-1", "name=Agent 1"]),
              a("agent-1.local", "192.168.12.101"),
            ],
          });
        }
      });
      const handle = browsePeers(registry, {
        createMdns: () => mdns,
        intervalMs: 10,
      });
      expect(registry.peers).toHaveLength(1);
      const queryCount = mdns.queries.length;
      expect(queryCount).toBeGreaterThan(0);

      // Three cycles: each re-query is answered, so the peer stays despite
      // having outlived its TTL in wall-clock terms.
      for (let cycle = 0; cycle < 3; cycle += 1) {
        now += 20;
        vi.advanceTimersByTime(10);
      }
      expect(registry.peers).toHaveLength(1);
      expect(mdns.queries.length).toBeGreaterThan(queryCount);

      // Now it goes silent: queries still go out, but no answer refreshes
      // lastSeen, so it ages out.
      answering = false;
      now += 31;
      vi.advanceTimersByTime(10);
      expect(registry.peers).toEqual([]);

      return handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("issues no query at all in the public profile", async () => {
    let factories = 0;
    const handle = browsePeers(new PeerRegistry(), {
      createMdns: () => {
        factories += 1;
        return new FakeMdnsSocket();
      },
      profile: "public",
    });
    expect(factories).toBe(0);
    await handle.stop();
  });
});
