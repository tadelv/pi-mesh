// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { createSkillRegistry, PeerRegistry } from "../src/index.js";

const remoteId = "11111111-1111-4111-8111-111111111111";

/** Invoke mesh.peers against a registry holding one remote peer's advertised caps. */
async function advertised(caps: string): Promise<string[]> {
  const registry = new PeerRegistry();
  registry.add({
    id: remoteId,
    name: "remote",
    serviceType: "mesh",
    host: "remote.local",
    port: 7330,
    txt: { id: remoteId, caps },
  });
  const skills = createSkillRegistry({ registry });
  const result = (await skills.invoke("mesh.peers", {})) as {
    peers: { id: string; skills: string[] }[];
  };
  const peer = result.peers.find((entry) => entry.id === remoteId);
  if (peer === undefined) throw new Error("mesh.peers dropped the remote peer");
  return peer.skills;
}

describe("mesh.peers capability summaries", () => {
  it("keeps the gated skills a gate-open remote peer advertises", async () => {
    // The bug was filtering a remote advertisement through this machine's
    // ungated SERVED_SKILLS list, which silently deleted exactly the
    // capabilities a caller routes on (issue #3).
    await expect(
      advertised(
        "mesh.peers,session.list,process.list,process.spawn,session.steer,mesh.handoff",
      ),
    ).resolves.toEqual([
      "mesh.peers",
      "session.list",
      "process.list",
      "process.spawn",
      "session.steer",
      "mesh.handoff",
    ]);
  });

  it("reports what the peer advertised, not what this machine allows", async () => {
    // A gate-closed peer never advertises the gated skills, so they are absent
    // here - and an unknown name stays rejected until the protocol knows it.
    await expect(
      advertised("mesh.peers,session.list,not.a.skill"),
    ).resolves.toEqual(["mesh.peers", "session.list"]);
  });
});
