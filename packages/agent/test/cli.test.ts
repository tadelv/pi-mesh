// SPDX-License-Identifier: GPL-3.0-or-later

import { chmod, mkdtemp, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  createAgentServer,
  PeerRegistry,
  servedSkills,
  signedHeaders,
  type BonjourLike,
} from "../src/index.js";

class PeerBonjour implements BonjourLike {
  destroyed = false;

  constructor(
    private readonly peer: {
      id: string;
      port: number;
    },
  ) {}

  publish(): void {}

  find(
    options: { type: string },
    onup?: (service: {
      host: string;
      port: number;
      txt: Record<string, string>;
    }) => void,
  ): { stop(): void } {
    if (options.type === "pi-mesh") {
      onup?.({
        host: "127.0.0.1",
        port: this.peer.port,
        txt: { id: this.peer.id, name: "peer-b", port: String(this.peer.port) },
      });
    }
    return { stop: () => undefined };
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class FakeBonjour implements BonjourLike {
  readonly published: { txt: Record<string, string>; port: number }[] = [];
  destroyed = false;

  publish(options: { txt: Record<string, string>; port: number }): void {
    this.published.push(options);
  }

  find(): { stop(): void } {
    return { stop: () => undefined };
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function output() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
          return true;
        },
      },
    },
    read: () => ({ stdout, stderr }),
  };
}

describe("agent CLI", () => {
  it("prints one 32-byte base64 key for keygen", async () => {
    const captured = output();

    await expect(run(["keygen"], captured.io)).resolves.toBe(0);

    const { stdout, stderr } = captured.read();
    expect(stdout).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
    expect(Buffer.from(stdout.trim(), "base64")).toHaveLength(32);
    expect(stderr).toBe("");
  });

  it.each([[[]], [["bogus"]], [["--profile", "bogus", "peers"]]])(
    "rejects an unknown or missing command or profile",
    async (argv) => {
      const captured = output();

      await expect(run(argv, captured.io)).resolves.toBe(2);

      const { stdout, stderr } = captured.read();
      expect(stdout).toBe("");
      expect(stderr).toMatch(/Usage: pi-mesh-agent keygen\n/);
    },
  );

  it("prints the browsed peer registry as JSON on stdout only", async () => {
    const captured = output();
    const registry = new PeerRegistry();
    registry.add({
      id: "peer-b",
      name: "Peer B",
      serviceType: "mesh",
      host: "peer-b.local",
      port: 7330,
      txt: { id: "peer-b" },
    });

    await expect(
      run(["peers", "--timeout", "0"], { ...captured.io, registry }),
    ).resolves.toBe(0);

    const { stdout, stderr } = captured.read();
    expect(JSON.parse(stdout)).toHaveLength(1);
    expect(JSON.parse(stdout)[0]).toMatchObject({ id: "peer-b" });
    expect(stderr).toBe("");
  });

  it("prints an empty registry when nothing is discovered", async () => {
    const captured = output();

    await expect(
      run(["peers", "--timeout", "0", "--profile", "public"], captured.io),
    ).resolves.toBe(0);

    const { stdout } = captured.read();
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it("rejects public-profile commands without trusted control-plane discovery", async () => {
    for (const argv of [
      ["start", "--profile", "public"],
      ["sessions", "--profile", "public"],
      ["stream", "session", "--profile", "public"],
      ["call", "peer", "skill", "--profile", "public"],
      ["doctor", "--profile", "public"],
    ]) {
      const captured = output();
      await expect(run(argv, captured.io)).resolves.toBe(2);
      expect(captured.read().stderr).toMatch(/public profile/);
    }
  });

  it("reports malformed credentials as a doctor failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-mesh-doctor-bad-home-"));
    await mkdir(join(home, ".pi-mesh"));
    await writeFile(join(home, ".pi-mesh", "credentials.json"), "not json");
    const captured = output();
    const oldHome = process.env.HOME;
    const oldPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = "";
    try {
      await expect(run(["doctor"], captured.io)).resolves.toBe(1);
      const report = JSON.parse(captured.read().stdout) as Record<
        string,
        unknown
      >;
      expect(report.peerId).toBeNull();
      expect(report.credentialsError).toMatch(/Malformed identity credentials/);
      expect(captured.read().stderr).toBe("");
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("reports the environment as the doctor execution source", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-mesh-doctor-policy-home-"));
    const oldHome = process.env.HOME;
    const oldPath = process.env.PATH;
    const oldGate = process.env.PI_MESH_ALLOW_SPAWN;
    const oldBinary = process.env.PI_MESH_PI_BINARY;
    process.env.HOME = home;
    process.env.PATH = "";
    process.env.PI_MESH_ALLOW_SPAWN = "*";
    process.env.PI_MESH_PI_BINARY = fileURLToPath(
      new URL("./fixtures/pi-binary", import.meta.url),
    );
    try {
      const captured = output();
      await expect(run(["doctor"], captured.io)).resolves.toBe(0);
      const report = JSON.parse(captured.read().stdout) as {
        spawnPolicy: { enabled: boolean; source: string };
      };
      expect(report.spawnPolicy).toEqual({
        enabled: true,
        source: "environment",
      });
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldGate === undefined) delete process.env.PI_MESH_ALLOW_SPAWN;
      else process.env.PI_MESH_ALLOW_SPAWN = oldGate;
      if (oldBinary === undefined) delete process.env.PI_MESH_PI_BINARY;
      else process.env.PI_MESH_PI_BINARY = oldBinary;
    }
  });

  it("reports an unusable swarm key as a doctor failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-mesh-doctor-bad-key-"));
    const directory = join(home, ".pi-mesh");
    await mkdir(directory);
    await writeFile(join(directory, "swarm.key"), "not base64");
    await chmod(join(directory, "swarm.key"), 0o600);
    const captured = output();
    const oldHome = process.env.HOME;
    const oldPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = "";
    try {
      await expect(run(["doctor"], captured.io)).resolves.toBe(1);
      const report = JSON.parse(captured.read().stdout) as Record<
        string,
        unknown
      >;
      expect(report.swarmKeyPresent).toBe(false);
      expect(report.swarmKeyError).toMatch(/Invalid swarm key/);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it.each([["keygen"], ["start"], ["peers"]])(
    "rejects extra positionals for %s",
    async (command) => {
      const captured = output();
      await expect(run([command, "junk"], captured.io)).resolves.toBe(2);
    },
  );

  it("uses the usage exit code for command argument errors", async () => {
    const captured = output();

    await expect(run(["sessions", "unexpected"], captured.io)).resolves.toBe(2);
    expect(captured.read().stderr).toContain("sessions takes no arguments");
  });

  it("refuses a directly dialed peer that cannot prove swarm membership", async () => {
    // Dialing an address skips mDNS, so the peer's claimed id is the only
    // identity on offer. It is accepted only because the handshake challenge
    // is HMAC'd over a transcript naming that id. A peer holding a different
    // swarm key cannot produce such a challenge, so it must be refused rather
    // than trusted - this is what stops --peer-host being a downgrade.
    const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-mesh-cli-direct-"));
    const server = createAgentServer({
      host: "127.0.0.1",
      port: 0,
      swarmKey: Buffer.alloc(32, 9),
      identity: {
        peerId: "44444444-4444-4444-8444-444444444444",
        name: "impostor",
      },
      sessionsRoot,
    });
    const listening = await server.start();
    const captured = output();
    try {
      await expect(
        run(
          [
            "sessions",
            "--peer-host",
            `127.0.0.1:${listening.port}`,
            "--timeout",
            "1",
          ],
          {
            ...captured.io,
            identity: {
              peerId: "33333333-3333-4333-8333-333333333333",
              name: "peer-a",
            },
            swarmKey: Buffer.alloc(32, 3),
          },
        ),
      ).resolves.toBe(11);
      expect(captured.read().stderr).toContain(
        "Handshake challenge authentication failed",
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects malformed --peer-host values", async () => {
    const captured = output();
    for (const address of ["host:0", "host:70000", ":7330", "host:"]) {
      await expect(
        run(["sessions", "--peer-host", address], captured.io),
      ).resolves.toBe(2);
    }
  });

  it("rejects supplying both --peer and --peer-host to call", async () => {
    const captured = output();
    await expect(
      run(
        [
          "call",
          "11111111-1111-4111-8111-111111111111",
          "session.list",
          "--peer-host",
          "127.0.0.1:7330",
        ],
        captured.io,
      ),
    ).resolves.toBe(2);
  });

  it("contacts the requested real peer with pure JSON and SSE stdout", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-mesh-cli-home-"));
    const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-mesh-cli-sessions-"));
    const directory = join(sessionsRoot, "--peer-b--");
    await mkdir(directory);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    await writeFile(
      join(directory, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: "/peer-b",
      })}\n${JSON.stringify({
        type: "message",
        id: "only-peer-b",
        parentId: null,
        timestamp: "2025-01-01T00:00:01.000Z",
        text: "only peer B can produce this",
      })}\n`,
    );
    const swarmKey = Buffer.alloc(32, 3);
    const peerIdentity = {
      peerId: "22222222-2222-4222-8222-222222222222",
      name: "peer-b",
    };
    const server = createAgentServer({
      host: "127.0.0.1",
      port: 0,
      swarmKey,
      identity: peerIdentity,
      sessionsRoot,
    });
    const listening = await server.start();
    const captured = output();
    const io = {
      ...captured.io,
      bonjour: new PeerBonjour({
        id: peerIdentity.peerId,
        port: listening.port,
      }),
      identity: {
        peerId: "33333333-3333-4333-8333-333333333333",
        name: "peer-a",
      },
      swarmKey,
      sessionsRoot: home,
    };
    try {
      await expect(
        run(["sessions", "--peer", peerIdentity.peerId, "--timeout", "1"], io),
      ).resolves.toBe(0);
      const listed = JSON.parse(captured.read().stdout) as {
        sessions: { project: string }[];
      };
      expect(listed.sessions[0]?.project).toBe("/peer-b");
      expect(captured.read().stderr).toBe("");

      // Direct dialing: the peer id is learned from the authenticated
      // handshake rather than from mDNS, so it works where multicast is
      // blocked. It must return the same data for the same server.
      const direct = output();
      await expect(
        run(
          [
            "sessions",
            "--peer-host",
            `127.0.0.1:${listening.port}`,
            "--timeout",
            "1",
          ],
          { ...io, ...direct.io },
        ),
      ).resolves.toBe(0);
      expect(JSON.parse(direct.read().stdout).sessions[0].project).toBe(
        "/peer-b",
      );
      expect(direct.read().stderr).toBe("");

      // With --peer-host the positionals shift: the first is the skill, since
      // the peer id is no longer something the caller has to know.
      const directCall = output();
      await expect(
        run(
          [
            "call",
            "session.list",
            "--peer-host",
            `127.0.0.1:${listening.port}`,
            "--timeout",
            "1",
          ],
          { ...io, ...directCall.io },
        ),
      ).resolves.toBe(0);
      expect(JSON.parse(directCall.read().stdout).sessions[0].project).toBe(
        "/peer-b",
      );

      captured.read();
      const callOutput = output();
      await expect(
        run(
          [
            "call",
            peerIdentity.peerId,
            "session.read",
            JSON.stringify({ id: sessionId }),
            "--timeout",
            "1",
          ],
          { ...io, ...callOutput.io },
        ),
      ).resolves.toBe(0);
      expect(JSON.parse(callOutput.read().stdout).entries[0].data.text).toBe(
        "only peer B can produce this",
      );
      expect(callOutput.read().stdout).not.toMatch(/peer-a|log|progress/i);

      const streamOutput = output();
      const streamRun = run(
        ["stream", sessionId, "--peer", peerIdentity.peerId, "--timeout", "1"],
        { ...io, ...streamOutput.io },
      );
      setTimeout(() => process.emit("SIGINT"), 50);
      await expect(streamRun).resolves.toBe(0);
      const streamText = streamOutput.read().stdout;
      expect(streamText).toContain('"only-peer-b"');
      for (const record of streamText.trim().split("\n\n")) {
        expect(record.startsWith("data: ")).toBe(true);
        expect(() => JSON.parse(record.slice("data: ".length))).not.toThrow();
      }
      expect(streamOutput.read().stderr).toBe("");
    } finally {
      await server.stop();
    }
  });

  it("reports doctor data without Pi or credential filesystem access", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-mesh-doctor-home-"));
    const captured = output();
    const oldHome = process.env.HOME;
    const oldPath = process.env.PATH;
    const oldPort = process.env.PI_MESH_PORT;
    process.env.HOME = home;
    process.env.PATH = "";
    process.env.PI_MESH_PORT = " ";
    try {
      await expect(run(["doctor"], captured.io)).resolves.toBe(0);
      const report = JSON.parse(captured.read().stdout) as Record<
        string,
        unknown
      >;
      expect(report).toMatchObject({
        peerId: null,
        swarmKeyPresent: false,
        configuredPort: 7330,
        piVersionFloor: "0.85.1",
        piVersion: null,
      });
      expect(captured.read().stderr).toBe("");
      await expect(readdir(home)).resolves.toEqual([]);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldPort === undefined) delete process.env.PI_MESH_PORT;
      else process.env.PI_MESH_PORT = oldPort;
    }
  });

  it("uses the CLI flag before the environment fallback for the execution gate", async () => {
    const oldGate = process.env.PI_MESH_ALLOW_SPAWN;
    const oldBinary = process.env.PI_MESH_PI_BINARY;
    const oldPort = process.env.PI_MESH_PORT;
    const key = Buffer.alloc(32, 7);
    const identity = {
      peerId: "22222222-2222-4222-8222-222222222222",
      name: "agent",
    };
    const caller = {
      peerId: "33333333-3333-4333-8333-333333333333",
      name: "caller",
    };
    const piBinary = fileURLToPath(
      new URL("./fixtures/pi-binary", import.meta.url),
    );
    const requestSkill = async (port: number): Promise<number> => {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            messageId: "message-1",
            role: "ROLE_USER",
            parts: [
              {
                data: {
                  skill: "session.steer",
                  input: { job_id: "missing", message: "hello" },
                },
              },
            ],
          },
        },
      });
      const headers = signedHeaders(key, caller, {
        method: "POST",
        path: "/",
        body,
        recipientPeerId: identity.peerId,
      });
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "A2A-Version": "1.0", ...headers },
        body,
      });
      const value = (await response.json()) as {
        error?: { code?: number };
      };
      return value.error?.code ?? 0;
    };
    const waitForPublish = async (bonjour: FakeBonjour): Promise<number> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const port = bonjour.published[0]?.port;
        if (port !== undefined) return port;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("agent did not publish");
    };
    process.env.PI_MESH_ALLOW_SPAWN = "99999999-9999-4999-8999-999999999999";
    process.env.PI_MESH_PI_BINARY = piBinary;
    process.env.PI_MESH_PORT = "47932";
    try {
      const deniedBonjour = new FakeBonjour();
      const denied = run(["start"], {
        ...output().io,
        bonjour: deniedBonjour,
        identity,
        swarmKey: key,
      });
      const deniedPort = await waitForPublish(deniedBonjour);
      await expect(requestSkill(deniedPort)).resolves.toBe(-32102);
      process.emit("SIGINT");
      await expect(denied).resolves.toBe(0);

      process.env.PI_MESH_PORT = "47933";
      const allowedBonjour = new FakeBonjour();
      const allowed = run(["start", "--allow-execution"], {
        ...output().io,
        bonjour: allowedBonjour,
        identity,
        swarmKey: key,
      });
      const allowedPort = await waitForPublish(allowedBonjour);
      // The environment names a different peer, but the CLI flag is wildcard
      // and therefore wins. An unknown job proves the gate opened before the
      // job lookup without attempting to execute the placeholder binary.
      await expect(requestSkill(allowedPort)).resolves.toBe(-32103);
      process.emit("SIGINT");
      await expect(allowed).resolves.toBe(0);
    } finally {
      if (oldGate === undefined) delete process.env.PI_MESH_ALLOW_SPAWN;
      else process.env.PI_MESH_ALLOW_SPAWN = oldGate;
      if (oldBinary === undefined) delete process.env.PI_MESH_PI_BINARY;
      else process.env.PI_MESH_PI_BINARY = oldBinary;
      if (oldPort === undefined) delete process.env.PI_MESH_PORT;
      else process.env.PI_MESH_PORT = oldPort;
    }
  });

  it("starts the listener and advertises exactly its served skills", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-mesh-cli-"));
    const bonjour = new FakeBonjour();
    const captured = output();
    const oldHome = process.env.HOME;
    const oldPort = process.env.PI_MESH_PORT;
    process.env.HOME = home;
    process.env.PI_MESH_PORT = "47931";
    try {
      const running = run(["start"], {
        ...captured.io,
        bonjour,
        identity: {
          peerId: "22222222-2222-4222-8222-222222222222",
          name: "agent",
        },
        swarmKey: Buffer.alloc(32, 7),
      });
      for (
        let attempt = 0;
        attempt < 100 && bonjour.published.length === 0;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(bonjour.published).toHaveLength(1);
      const capabilities = bonjour.published[0]?.txt.caps?.split(",").sort();
      expect(capabilities).toEqual([...servedSkills()].sort());
      const cardResponse = await fetch(
        "http://127.0.0.1:47931/.well-known/agent-card.json",
      );
      const card = (await cardResponse.json()) as {
        skills: { id: string }[];
      };
      expect(capabilities).toEqual(card.skills.map((skill) => skill.id).sort());
      process.emit("SIGINT");
      await expect(running).resolves.toBe(0);
      expect(bonjour.destroyed).toBe(true);
      await expect(readdir(home)).resolves.toEqual([]);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldPort === undefined) delete process.env.PI_MESH_PORT;
      else process.env.PI_MESH_PORT = oldPort;
    }
  });
});
