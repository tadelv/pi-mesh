// SPDX-License-Identifier: GPL-3.0-or-later

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode, PiMeshError } from "@pi-mesh/shared";
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

describe("pairing a running agent", () => {
  it("activates the new credential without a restart", async () => {
    // The README order, which the existing tests do not follow: the agent is
    // started FIRST, then `pair` runs in a separate process and only writes the
    // file. Before the reload path existed the running server kept verifying
    // against the list it read at startup and answered 401 forever (issue #2).
    const directory = await mkdtemp(join(tmpdir(), "pi-mesh-reload-"));
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
    const credentialBytes = randomBytes(32);
    const controlIdentity = { peerId: randomUUID(), name: "control" };
    const asControl = {
      swarmKey: credentialBytes,
      identity: controlIdentity,
    };
    try {
      // Positive control: before the file exists this exact request is refused
      // BY AUTHENTICATION, not by a transport fault - the test names the clause
      // it depends on, so it cannot pass because the agent was unreachable.
      await expect(
        sendSkill(peer, "session.list", {}, asControl),
      ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });

      // What `pi-mesh-agent pair <token>` does in its own process.
      await saveControlCredential(
        {
          controlId: controlIdentity.peerId,
          credential: credentialBytes.toString("base64"),
          pairedAt: new Date().toISOString(),
        },
        { path: credentialsPath },
      );

      // No restart, same request, now authenticated.
      await expect(
        sendSkill(peer, "session.list", {}, asControl),
      ).resolves.toEqual({ sessions: [] });
    } finally {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("still refuses a control credential that was never paired", async () => {
    // The reload must not become "accept anyone who signs after we re-read the
    // file": a different key, with the file present, is still refused.
    const directory = await mkdtemp(join(tmpdir(), "pi-mesh-reload-"));
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
    const paired = randomBytes(32);
    const controlIdentity = { peerId: randomUUID(), name: "control" };
    try {
      await saveControlCredential(
        {
          controlId: controlIdentity.peerId,
          credential: paired.toString("base64"),
          pairedAt: new Date().toISOString(),
        },
        { path: credentialsPath },
      );
      await expect(
        sendSkill(
          peer,
          "session.list",
          {},
          {
            swarmKey: randomBytes(32),
            identity: controlIdentity,
          },
        ),
      ).rejects.toBeInstanceOf(PiMeshError);
    } finally {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
