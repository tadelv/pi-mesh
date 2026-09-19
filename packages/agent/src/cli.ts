#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFile as execFileCallback } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
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
import {
  ClientProtocolError,
  PeerIdentityMismatchError,
  PeerUnreachableError,
  sendSkill,
  streamSkill,
} from "./client.js";
import { createAgentServer } from "./server.js";
import { servedSkills } from "./skills.js";
import { SessionStore } from "./sessions.js";
import { sessionStream } from "./stream.js";
import { PiMeshError, ErrorCode } from "@pi-mesh/shared";
import type { StreamResponse } from "@pi-mesh/protocol";

export type CliIO = {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
  bonjour?: BonjourLike;
  registry?: PeerRegistry;
  identity?: PeerIdentity;
  swarmKey?: Uint8Array;
  sessionsRoot?: string;
};

// Pi 0.85.1 is the oldest session format this milestone supports.
export const PI_SUPPORTED_FLOOR = "0.85.1";
const execFile = promisify(execFileCallback);

const usage =
  "Usage: pi-mesh-agent keygen\n" +
  "Usage: pi-mesh-agent peers [--profile lan|public] [--watch] [--timeout seconds]\n" +
  "Usage: pi-mesh-agent start [--profile lan|public]\n" +
  "Usage: pi-mesh-agent sessions [--peer id]\n" +
  "Usage: pi-mesh-agent stream <session> [--peer id]\n" +
  "Usage: pi-mesh-agent call <peer> <skill> [json]\n" +
  "Usage: pi-mesh-agent doctor\n";

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
  try {
    if (parsed.command === "start") return await start(parsed.profile, io);
    if (parsed.command === "sessions") {
      if (parsed.args.length > 0)
        throw new Error("sessions takes no arguments");
      return await sessions(parsed.peer, parsed.timeoutMs, io);
    }
    if (parsed.command === "stream") {
      if (parsed.args.length !== 1)
        throw new Error("stream requires a session id");
      return await stream(parsed.args[0]!, parsed.peer, parsed.timeoutMs, io);
    }
    if (parsed.command === "call") {
      if (parsed.args.length < 2 || parsed.args.length > 3) {
        throw new Error("call requires a peer, skill, and optional JSON input");
      }
      return await callSkill(
        parsed.args[0]!,
        parsed.args[1]!,
        parsed.args[2],
        parsed.timeoutMs,
        io,
      );
    }
    if (parsed.command === "doctor") {
      if (parsed.args.length > 0 || parsed.peer !== undefined) {
        throw new Error("doctor takes no arguments");
      }
      return await doctor(io);
    }
    io.stderr.write(usage);
    return 2;
  } catch (error) {
    io.stderr.write(`${errorMessage(error)}\n`);
    return errorExitCode(error);
  }
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

async function sessions(
  peerId: string | undefined,
  timeoutMs: number,
  io: CliIO,
): Promise<number> {
  if (peerId === undefined) {
    const store = new SessionStore({
      ...(io.sessionsRoot === undefined
        ? {}
        : { sessionsRoot: io.sessionsRoot }),
      onError: (error) =>
        io.stderr.write(`Session parse warning: ${error.message}\n`),
    });
    io.stdout.write(`${JSON.stringify({ sessions: await store.list() })}\n`);
    return 0;
  }
  const peer = await discover(peerId, timeoutMs, io);
  if (peer === undefined) return 1;
  const result = await sendSkill(
    peer,
    "session.list",
    {},
    await clientOptions(io),
  );
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function callSkill(
  peerId: string,
  skill: string,
  encodedInput: string | undefined,
  timeoutMs: number,
  io: CliIO,
): Promise<number> {
  let input: unknown = {};
  if (encodedInput !== undefined) {
    try {
      input = JSON.parse(encodedInput) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const peer = await discover(peerId, timeoutMs, io);
  if (peer === undefined) return 1;
  const result = await sendSkill(peer, skill, input, await clientOptions(io));
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function stream(
  sessionId: string,
  peerId: string | undefined,
  timeoutMs: number,
  io: CliIO,
): Promise<number> {
  const abort = new AbortController();
  let stopLocal: (() => void) | undefined;
  const onSignal = (): void => {
    abort.abort();
    stopLocal?.();
  };
  process.once("SIGINT", onSignal);
  try {
    if (peerId === undefined) {
      const iterator = sessionStream(
        { id: sessionId },
        io.sessionsRoot === undefined ? {} : { sessionsRoot: io.sessionsRoot },
      );
      stopLocal = () => {
        void iterator.stop();
      };
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done || abort.signal.aborted) return 0;
          writeSse(io, { message: localStreamMessage(next.value.data) });
        }
      } finally {
        await iterator.stop();
      }
    }

    const peer = await discover(peerId, timeoutMs, io, abort.signal);
    if (peer === undefined) return 1;
    const events = streamSkill(
      peer,
      "session.stream",
      { id: sessionId },
      await clientOptions(io),
      abort.signal,
    );
    for await (const event of events) {
      if (abort.signal.aborted) return 0;
      writeSse(io, event);
    }
    return 0;
  } finally {
    process.removeListener("SIGINT", onSignal);
  }
}

function localStreamMessage(value: unknown): StreamResponse["message"] {
  return {
    messageId: randomUUID(),
    role: "ROLE_AGENT",
    parts: [{ data: { result: value } }],
  };
}

function writeSse(io: CliIO, value: unknown): void {
  io.stdout.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function discover(
  peerId: string,
  timeoutMs: number,
  io: CliIO,
  signal?: AbortSignal,
): Promise<PeerRecord | undefined> {
  const registry = io.registry ?? new PeerRegistry();
  const bonjour = io.bonjour ?? new Bonjour();
  const browser = browsePeers(registry, { bonjour });
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      registry.prune();
      if (signal?.aborted) return undefined;
      const peer = registry.get("mesh", peerId);
      if (peer !== undefined) return peer;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        io.stderr.write(
          `Peer ${peerId} was not found through mDNS discovery\n`,
        );
        return undefined;
      }
      await Promise.race([
        sleep(Math.min(100, remaining)),
        new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    }
  } finally {
    await browser.stop();
  }
}

async function clientOptions(io: CliIO): Promise<{
  identity: PeerIdentity;
  swarmKey: Uint8Array;
}> {
  return {
    identity: io.identity ?? (await loadOrCreateIdentity()),
    swarmKey: io.swarmKey ?? (await loadSwarmKey()),
  };
}

async function doctor(io: CliIO): Promise<number> {
  const identity = io.identity ?? (await loadOrCreateIdentity());
  const swarmKeyPresent =
    io.swarmKey !== undefined ||
    (await filePresent(join(homedir(), ".pi-mesh", "swarm.key")));
  io.stdout.write(
    `${JSON.stringify({
      peerId: identity.peerId,
      name: identity.name,
      swarmKeyPresent,
      port: configuredPort(),
      servedSkills: servedSkills(),
      piVersionFloor: PI_SUPPORTED_FLOOR,
      piVersion: await detectedPiVersion(),
    })}\n`,
  );
  return 0;
}

async function filePresent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function detectedPiVersion(): Promise<string | null> {
  try {
    const result = await execFile("pi", ["--version"], {
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    });
    const match = `${result.stdout}\n${result.stderr}`.match(
      /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/,
    );
    return match?.[0] ?? null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof PeerUnreachableError) {
    return `Transport error: ${error.message}`;
  }
  if (error instanceof PeerIdentityMismatchError) {
    return `Authentication error: ${error.message}`;
  }
  if (error instanceof PiMeshError) {
    return error.code === ErrorCode.Unauthorized
      ? `Authentication error (${error.code}): ${error.message}`
      : `Application error (${error.code}): ${error.message}`;
  }
  if (error instanceof ClientProtocolError) {
    return `Protocol error: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function errorExitCode(error: unknown): number {
  if (error instanceof PeerUnreachableError) return 10;
  if (
    error instanceof PeerIdentityMismatchError ||
    (error instanceof PiMeshError && error.code === ErrorCode.Unauthorized)
  ) {
    return 11;
  }
  if (error instanceof PiMeshError) return 12;
  if (error instanceof ClientProtocolError) return 13;
  return 1;
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
      args: string[];
      peer: string | undefined;
      profile: NetworkProfile;
      watch: boolean;
      timeoutMs: number;
    }
  | undefined {
  let profile: NetworkProfile = "lan";
  let watch = false;
  let timeoutMs = 5_000;
  let peer: string | undefined;
  const commands: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") {
      const value = argv[index + 1];
      if (value !== "lan" && value !== "public") return undefined;
      profile = value;
      index += 1;
    } else if (argument === "--watch") {
      watch = true;
    } else if (argument === "--timeout") {
      const seconds = Number(argv[index + 1]);
      if (!Number.isFinite(seconds) || seconds < 0) return undefined;
      timeoutMs = seconds * 1_000;
      index += 1;
    } else if (argument === "--peer") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return undefined;
      peer = value;
      index += 1;
    } else if (argument !== undefined && !argument.startsWith("--")) {
      commands.push(argument);
    } else {
      return undefined;
    }
  }

  return commands.length > 0
    ? {
        command: commands[0],
        args: commands.slice(1),
        peer,
        profile,
        watch,
        timeoutMs,
      }
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

/**
 * Exit quietly when the consumer of stdout goes away.
 *
 * `pi-mesh-agent stream | head` is the ordinary way to use a stream, and it
 * closes the pipe early. Without this, the next write raised an unhandled
 * 'error' event: a stack trace on stderr and exit 1, for a command that did
 * exactly what was asked. Every other Unix tool exits silently here.
 */
function exitQuietlyOnEpipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  exitQuietlyOnEpipe(process.stdout);
  exitQuietlyOnEpipe(process.stderr);
  void run(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
