// SPDX-License-Identifier: GPL-3.0-or-later

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@pi-mesh/shared";
import {
  createAgentServer,
  saveControlCredential,
  sendSkill,
  type PeerRecord,
} from "../src/index.js";

const agentIdentity = {
  peerId: "22222222-2222-4222-8222-222222222222",
  name: "agent",
};
const swarmKey = Buffer.from("pi-mesh-vector-key-0123456789abc");
const unauthorized = { code: ErrorCode.Unauthorized };

/**
 * Give the credentials file a distinctly newer mtime after a write. Without it
 * the test would depend on filesystem timestamp granularity: two writes in the
 * same millisecond are indistinguishable to an mtime-based reload.
 */
let ticks = 0;
async function bumpMtime(path: string): Promise<void> {
  const later = new Date(Date.now() + 5_000 * ++ticks);
  await utimes(path, later, later);
}

/** A running agent whose control-credentials file the test writes underneath it. */
async function running(label: string) {
  const directory = await mkdtemp(join(tmpdir(), `pi-mesh-${label}-`));
  const credentialsPath = join(directory, "control-credentials.json");
  const server = createAgentServer({
    port: 0,
    swarmKey,
    identity: agentIdentity,
    sessionsRoot: join(directory, "sessions"),
    controlCredentialsPath: credentialsPath,
  });
  const address = await server.start();
  const peer: PeerRecord = {
    id: agentIdentity.peerId,
    name: agentIdentity.name,
    serviceType: "mesh",
    host: "127.0.0.1",
    port: address.port,
    txt: { id: agentIdentity.peerId },
    lastSeen: Date.now(),
  };
  const controlIdentity = { peerId: randomUUID(), name: "control" };
  const request = (secret: Uint8Array) =>
    sendSkill(
      peer,
      "session.list",
      {},
      { swarmKey: secret, identity: controlIdentity },
    );
  return {
    peer,
    controlIdentity,
    request,
    /** What `pi-mesh-agent pair <token>` does, in its own process. */
    async pair(secret: Uint8Array) {
      await saveControlCredential(
        {
          controlId: controlIdentity.peerId,
          credential: Buffer.from(secret).toString("base64"),
          pairedAt: new Date().toISOString(),
        },
        { path: credentialsPath },
      );
      await bumpMtime(credentialsPath);
    },
    /** Remove every entry. saveControlCredential only adds or replaces by id. */
    async clear() {
      await writeFile(
        credentialsPath,
        `${JSON.stringify({ credentials: [] })}\n`,
        { mode: 0o600 },
      );
      await bumpMtime(credentialsPath);
    },
    async stop() {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("pairing a running agent", () => {
  it("activates the new credential without a restart", async () => {
    // The README order, which the existing tests do not follow: the agent is
    // started FIRST, then `pair` runs in a separate process and only writes the
    // file. Before the reload path existed the running server kept verifying
    // against the list it read at startup and answered 401 forever (issue #2).
    const agent = await running("reload");
    const secret = randomBytes(32);
    try {
      // Positive control: before the file exists this exact request is refused
      // BY AUTHENTICATION, not by a transport fault, so the test cannot pass
      // because the agent was unreachable.
      await expect(agent.request(secret)).rejects.toMatchObject(unauthorized);

      await agent.pair(secret);
      await expect(agent.request(secret)).resolves.toEqual({ sessions: [] });
    } finally {
      await agent.stop();
    }
  });

  it("stops accepting a credential removed from the file", async () => {
    // A cached entry still verifies, so the retry-after-failure path can never
    // notice a revocation - it only runs when verification fails. This is the
    // clause that makes deleting the entry take effect without a restart.
    const agent = await running("revoke");
    const secret = randomBytes(32);
    try {
      await agent.pair(secret);
      await expect(agent.request(secret)).resolves.toEqual({ sessions: [] });

      await agent.clear();
      await expect(agent.request(secret)).rejects.toMatchObject(unauthorized);
    } finally {
      await agent.stop();
    }
  });

  it("uses a rotated credential and retires the old one", async () => {
    const agent = await running("rotate");
    const original = randomBytes(32);
    const rotated = randomBytes(32);
    try {
      await agent.pair(original);
      await expect(agent.request(original)).resolves.toEqual({ sessions: [] });

      await agent.pair(rotated);
      await expect(agent.request(rotated)).resolves.toEqual({ sessions: [] });
      await expect(agent.request(original)).rejects.toMatchObject(unauthorized);
    } finally {
      await agent.stop();
    }
  });

  it("does not fall back to swarm authentication for a paired control id", async () => {
    // Signing with a random key would fail under either signer, which proves
    // nothing. Signing with the REAL swarm key while claiming the paired
    // control id is the discriminator: a fallback from the known control id to
    // swarm auth would make this succeed.
    const agent = await running("fallback");
    const secret = randomBytes(32);
    try {
      await agent.pair(secret);
      // Positive control: the paired key works, so the refusal below is about
      // which key was used and not about a malformed request.
      await expect(agent.request(secret)).resolves.toEqual({ sessions: [] });

      await expect(
        sendSkill(
          agent.peer,
          "session.list",
          {},
          {
            swarmKey,
            identity: agent.controlIdentity,
          },
        ),
      ).rejects.toMatchObject(unauthorized);
    } finally {
      await agent.stop();
    }
  });
});
