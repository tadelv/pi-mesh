// SPDX-License-Identifier: GPL-3.0-or-later

import { chmod, mkdtemp, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  createAgentServer,
  PeerRegistry,
  servedSkills,
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
