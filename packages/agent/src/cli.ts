#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import Bonjour from "bonjour-service";
import { isDirectInvocation, sleep } from "@pi-mesh/shared";
import {
  browsePeers,
  type BonjourLike,
  type NetworkProfile,
  publishAgent,
} from "./mdns.js";
import { PeerRegistry, type PeerRecord } from "./registry.js";
import { generateSwarmKey, loadSwarmKey } from "./swarm-key.js";
import { loadOrCreateIdentity, type PeerIdentity } from "./identity.js";
import { createAgentServer } from "./server.js";
import { servedSkills } from "./skills.js";

export type CliIO = {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
  bonjour?: BonjourLike;
  registry?: PeerRegistry;
  identity?: PeerIdentity;
  swarmKey?: Uint8Array;
};

const usage =
  "Usage: pi-mesh-agent keygen\n" +
  "Usage: pi-mesh-agent peers [--profile lan|public] [--watch] [--timeout seconds]\n" +
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
    return peers(
      parsed.profile,
      { watch: parsed.watch, timeoutMs: parsed.timeoutMs },
      io,
    );
  }
  if (parsed.command !== "start") {
    io.stderr.write(usage);
    return 2;
  }

  return start(parsed.profile, io);
}

/**
 * The registry is process-local, so a fresh invocation has nothing to print on
 * its own: it has to browse before it can report anything. Without this,
 * `pi-mesh-agent peers` printed an empty list unconditionally.
 */
async function peers(
  profile: NetworkProfile,
  options: { watch: boolean; timeoutMs: number },
  io: CliIO,
): Promise<number> {
  const registry = io.registry ?? new PeerRegistry();
  const bonjour =
    profile === "public" ? undefined : (io.bonjour ?? new Bonjour());
  const browser = browsePeers(registry, {
    profile,
    ...(bonjour === undefined ? {} : { bonjour }),
  });

  const emit = (): void => {
    registry.prune();
    io.stdout.write(`${JSON.stringify(registry.peers)}\n`);
  };

  try {
    if (!options.watch) {
      // Long enough for mDNS responses to arrive, per the M0-6 "within 5
      // seconds" criterion.
      await sleep(options.timeoutMs);
      emit();
      return 0;
    }

    emit();
    const timer = setInterval(emit, Math.max(options.timeoutMs, 250));
    await new Promise<void>((resolveExit) => {
      process.once("SIGINT", () => resolveExit());
    });
    clearInterval(timer);
    return 0;
  } finally {
    await browser.stop();
  }
}

async function start(profile: NetworkProfile, io: CliIO): Promise<number> {
  let swarmKey: Uint8Array | undefined;
  if (profile === "lan") {
    try {
      swarmKey = io.swarmKey ?? (await loadSwarmKey());
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
  let server: Awaited<ReturnType<typeof createAgentServer>> | undefined;
  let advertisement: Awaited<ReturnType<typeof publishAgent>> | undefined;
  let browser: ReturnType<typeof browsePeers> | undefined;
  try {
    // The listener and advertisement must use the same identity and port. A
    // peer learns both from mDNS and signs requests addressed to that identity.
    const identity = io.identity ?? (await loadOrCreateIdentity());
    if (swarmKey !== undefined) {
      server = createAgentServer({
        port: configuredPort(),
        swarmKey,
        identity,
        registry,
      });
      const listening = await server.start();
      advertisement = await publishAgent(
        {
          id: identity.peerId,
          name: process.env.PI_MESH_NAME ?? identity.name,
          version: process.env.PI_MESH_VERSION ?? "0.0.0",
          agentVersion: process.env.PI_MESH_AGENT_VERSION ?? "0.0.0",
          port: listening.port,
          fingerprint: process.env.PI_MESH_FINGERPRINT ?? "unpaired",
          capabilities: servedSkills(),
        },
        {
          profile,
          swarmKey,
          ...(bonjour === undefined ? {} : { bonjour }),
        },
      );
    }

    browser = browsePeers(registry, {
      profile,
      ...(bonjour === undefined ? {} : { bonjour }),
      onPeer: (peer: PeerRecord) =>
        io.stdout.write(`${JSON.stringify(peer)}\n`),
    });

    const cleanup = async (): Promise<void> => {
      const results = await Promise.allSettled([
        browser?.stop(),
        advertisement?.stop(),
        server?.stop(),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
    };

    return await new Promise<number>((resolveExit) => {
      process.once("SIGINT", () => {
        void cleanup().then(
          () => resolveExit(0),
          () => resolveExit(1),
        );
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`Failed to start agent: ${message}\n`);
    await Promise.allSettled([
      browser?.stop(),
      advertisement?.stop(),
      server?.stop(),
    ]);
    return 1;
  }
}

function configuredPort(): number {
  const configured = Number(process.env.PI_MESH_PORT ?? 7330);
  return Number.isInteger(configured) && configured > 0 && configured <= 65535
    ? configured
    : 7330;
}

function parseArguments(argv: string[]):
  | {
      command: string | undefined;
      profile: NetworkProfile;
      watch: boolean;
      timeoutMs: number;
    }
  | undefined {
  let profile: NetworkProfile = "lan";
  let watch = false;
  let timeoutMs = 5_000;
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
    } else if (argument === "--watch") {
      watch = true;
    } else if (argument === "--timeout") {
      const seconds = Number(argv[index + 1]);
      if (!Number.isFinite(seconds) || seconds < 0) {
        return undefined;
      }
      timeoutMs = seconds * 1_000;
      index += 1;
    } else if (argument !== undefined) {
      commands.push(argument);
    }
  }

  return commands.length === 1
    ? { command: commands[0], profile, watch, timeoutMs }
    : undefined;
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
