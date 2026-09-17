#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import Bonjour from "bonjour-service";
import { hostname } from "node:os";
import { isDirectInvocation } from "@pi-mesh/shared";
import {
  browsePeers,
  type BonjourLike,
  type NetworkProfile,
  publishAgent,
} from "./mdns.js";
import { PeerRegistry, type PeerRecord } from "./registry.js";
import { generateSwarmKey, loadSwarmKey } from "./swarm-key.js";

export type CliIO = {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
  bonjour?: BonjourLike;
  registry?: PeerRegistry;
};

const usage =
  "Usage: pi-mesh-agent keygen\n" +
  "Usage: pi-mesh-agent peers [--profile lan|public]\n" +
  "Usage: pi-mesh-agent start [--profile lan|public]\n";

export async function run(
  argv: string[],
  io: CliIO = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const parsed = parseArguments(argv);
  if (parsed === undefined) {
    io.stderr.write(usage);
    return 2;
  }

  if (parsed.command === "keygen") {
    io.stdout.write(`${generateSwarmKey()}\n`);
    return 0;
  }
  if (parsed.command === "peers") {
    const registry = io.registry ?? new PeerRegistry();
    registry.prune();
    io.stdout.write(`${JSON.stringify(registry.peers)}\n`);
    return 0;
  }
  if (parsed.command !== "start") {
    io.stderr.write(usage);
    return 2;
  }

  return start(parsed.profile, io);
}

async function start(profile: NetworkProfile, io: CliIO): Promise<number> {
  let swarmKey: Uint8Array | undefined;
  if (profile === "lan") {
    try {
      swarmKey = await loadSwarmKey();
    } catch (error) {
      if (!isMissingFileError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        io.stderr.write(`Failed to load swarm key: ${message}\n`);
        return 1;
      }
    }
  }

  const registry = io.registry ?? new PeerRegistry();
  const bonjour =
    profile === "public" ? undefined : (io.bonjour ?? new Bonjour());
  try {
    await publishAgent(
      {
        id: process.env.PI_MESH_ID ?? hostname(),
        name: process.env.PI_MESH_NAME ?? hostname(),
        version: process.env.PI_MESH_VERSION ?? "0.0.0",
        agentVersion: process.env.PI_MESH_AGENT_VERSION ?? "0.0.0",
        port: configuredPort(),
        fingerprint: process.env.PI_MESH_FINGERPRINT ?? "unpaired",
        capabilities: [],
      },
      {
        profile,
        ...(swarmKey === undefined ? {} : { swarmKey }),
        ...(bonjour === undefined ? {} : { bonjour }),
      },
    );

    const browser = browsePeers(registry, {
      profile,
      ...(bonjour === undefined ? {} : { bonjour }),
      onPeer: (peer: PeerRecord) =>
        io.stdout.write(`${JSON.stringify(peer)}\n`),
    });

    return await new Promise<number>((resolveExit) => {
      process.once("SIGINT", () => {
        void browser.stop().then(
          () => resolveExit(0),
          () => resolveExit(1),
        );
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`Failed to start agent: ${message}\n`);
    return 1;
  }
}

function configuredPort(): number {
  const configured = Number(process.env.PI_MESH_PORT ?? 7330);
  return Number.isInteger(configured) && configured > 0 && configured <= 65535
    ? configured
    : 7330;
}

function parseArguments(
  argv: string[],
): { command: string | undefined; profile: NetworkProfile } | undefined {
  let profile: NetworkProfile = "lan";
  const commands: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") {
      const value = argv[index + 1];
      if (value !== "lan" && value !== "public") {
        return undefined;
      }
      profile = value;
      index += 1;
    } else if (argument !== undefined) {
      commands.push(argument);
    }
  }
  return commands.length === 1 ? { command: commands[0], profile } : undefined;
}

function isMissingFileError(error: unknown): boolean {
  if (error instanceof Error && "cause" in error) {
    return isMissingFileError(error.cause);
  }
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT";
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  void run(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
