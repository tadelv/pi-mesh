#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { randomUUID } from "node:crypto";
import Bonjour from "bonjour-service";
import { configuredMeshPort, isDirectInvocation, sleep } from "@pi-mesh/shared";
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
  resolvePeerByAddress,
  sendSkill,
  streamSkill,
} from "./client.js";
import { createAgentServer } from "./server.js";
import { servedSkills } from "./skills.js";
import { parseSpawnPolicy, type SpawnPolicy } from "./spawn-policy.js";
import { SessionStore } from "./sessions.js";
import { sessionStream } from "./stream.js";
import { JobManager } from "./jobs.js";
import {
  createPiSpawner,
  resolvePiBinary,
  resolveWorkspaceRoot,
} from "./spawner.js";
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
  /** Injected so a test can exercise a rejected policy without the environment. */
  spawnPolicy?: SpawnPolicy;
};

// Pi 0.85.1 is the oldest session format this milestone supports.
export const PI_SUPPORTED_FLOOR = "0.85.1";
const usage =
  "Usage: pi-mesh-agent keygen\n" +
  "Usage: pi-mesh-agent peers [--profile lan|public] [--watch] [--timeout seconds]\n" +
  "Usage: pi-mesh-agent start [--profile lan|public]\n" +
  "Usage: pi-mesh-agent sessions [--peer id | --peer-host host[:port]] [--timeout seconds]\n" +
  "Usage: pi-mesh-agent stream <session> [--peer id | --peer-host host[:port]] [--timeout seconds]\n" +
  "Usage: pi-mesh-agent call <peer> <skill> [json] [--timeout seconds]\n" +
  "       pi-mesh-agent call <skill> [json] --peer-host host[:port]\n" +
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
    if (parsed.args.length > 0) {
      io.stderr.write("keygen takes no arguments\n");
      return 2;
    }
    io.stdout.write(`${generateSwarmKey()}\n`);
    return 0;
  }
  if (parsed.command === "peers") {
    if (parsed.args.length > 0) {
      io.stderr.write("peers takes no arguments\n");
      return 2;
    }
    return peers(
      parsed.profile,
      { watch: parsed.watch, timeoutMs: parsed.timeoutMs },
      io,
    );
  }
  try {
    if (
      parsed.profile === "public" &&
      ["start", "sessions", "stream", "call", "doctor"].includes(
        parsed.command ?? "",
      )
    ) {
      throw new CliUsageError(
        `The public profile cannot use ${parsed.command}; trusted control-plane discovery is not available yet`,
      );
    }
    if (parsed.command === "start") {
      if (parsed.args.length > 0)
        throw new CliUsageError("start takes no arguments");
      return await start(parsed.profile, io);
    }
    if (parsed.command === "sessions") {
      if (parsed.args.length > 0)
        throw new CliUsageError("sessions takes no arguments");
      return await sessions(parsed.peer, parsed.peerHost, parsed.timeoutMs, io);
    }
    if (parsed.command === "stream") {
      if (parsed.args.length !== 1)
        throw new CliUsageError("stream requires a session id");
      return await stream(
        parsed.args[0]!,
        parsed.peer,
        parsed.peerHost,
        parsed.timeoutMs,
        io,
      );
    }
    if (parsed.command === "call") {
      const target = callTarget(parsed);
      return await callSkill(
        target.peerId,
        target.peerHost,
        target.args[0]!,
        target.args[1],
        parsed.timeoutMs,
        io,
      );
    }
    if (parsed.command === "doctor") {
      if (parsed.args.length > 0 || parsed.peer !== undefined) {
        throw new CliUsageError("doctor takes no arguments");
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
  let jobs: JobManager | undefined;
  try {
    // The listener and advertisement must use the same identity and port. A
    // peer learns both from mDNS and signs requests addressed to that identity.
    const identity = io.identity ?? (await loadOrCreateIdentity());
    const spawnPolicy = parseSpawnPolicy();
    let workspaceRoot: string | undefined;
    if (spawnPolicy.enabled) {
      workspaceRoot = resolveWorkspaceRoot();
      jobs = new JobManager({
        spawnJob: createPiSpawner({
          workspaceRoot,
          piBinary: resolvePiBinary(),
          ...(io.sessionsRoot === undefined
            ? {}
            : { sessionsRoot: io.sessionsRoot }),
        }),
      });
    }
    if (swarmKey !== undefined) {
      server = createAgentServer({
        port: configuredPort(),
        swarmKey,
        identity,
        registry,
        ...(jobs === undefined ? {} : { jobs }),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      });
      const listening = await server.start();
      advertisement = await publishAgent(
        {
          id: identity.peerId,
          name: process.env.PI_MESH_NAME ?? identity.name,
          version: process.env.PI_MESH_VERSION ?? "0.0.0",
          agentVersion: process.env.PI_MESH_AGENT_VERSION ?? "0.0.0",
          port: listening.port,
          capabilities: servedSkills(spawnPolicy.enabled),
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
        jobs?.shutdown(),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
    };

    return await new Promise<number>((resolveExit) => {
      let cleaned = false;
      const onSignal = (): void => {
        if (cleaned) return;
        cleaned = true;
        void cleanup().then(
          () => resolveExit(0),
          () => resolveExit(1),
        );
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
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
  peerHost: string | undefined,
  timeoutMs: number,
  io: CliIO,
): Promise<number> {
  if (peerId === undefined && peerHost === undefined) {
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
  const peer = await resolveRemote(peerId, peerHost, timeoutMs, io);
  if (peer === undefined) return 1;
  const result = await sendSkill(
    peer,
    "session.list",
    {},
    await clientOptions(io, timeoutMs),
  );
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function callSkill(
  peerId: string | undefined,
  peerHost: string | undefined,
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
      throw new CliUsageError(
        `Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const peer = await resolveRemote(peerId, peerHost, timeoutMs, io);
  if (peer === undefined) return 1;
  const result = await sendSkill(
    peer,
    skill,
    input,
    await clientOptions(io, timeoutMs),
  );
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function stream(
  sessionId: string,
  peerId: string | undefined,
  peerHost: string | undefined,
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
    if (peerId === undefined && peerHost === undefined) {
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

    const peer = await resolveRemote(
      peerId,
      peerHost,
      timeoutMs,
      io,
      abort.signal,
    );
    if (peer === undefined) return 1;
    const events = streamSkill(
      peer,
      "session.stream",
      { id: sessionId },
      await clientOptions(io, timeoutMs),
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

/**
 * Resolve the peer a command should talk to.
 *
 * `--peer` discovers over mDNS. `--peer-host` dials an address directly and
 * learns the peer's id from the authenticated handshake, which is the only
 * way to reach a peer on a network that blocks multicast. Returning undefined
 * means the caller asked for no peer at all, which for `sessions` and `stream`
 * means "read this machine's own sessions".
 */
async function resolveRemote(
  peerId: string | undefined,
  peerHost: string | undefined,
  timeoutMs: number,
  io: CliIO,
  signal?: AbortSignal,
): Promise<PeerRecord | undefined> {
  if (peerHost !== undefined) {
    const { host, port } = parsePeerAddress(peerHost);
    return await resolvePeerByAddress(
      host,
      port,
      await clientOptions(io, timeoutMs),
    );
  }
  if (peerId === undefined) return undefined;
  return await discover(peerId, timeoutMs, io, signal);
}

/**
 * Accept `host`, `host:port` or `[v6]:port`. A bare IPv6 literal has more than
 * one colon and no brackets, so it cannot be confused with a port.
 */
function parsePeerAddress(value: string): { host: string; port: number } {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  const colons = value.split(":").length - 1;
  let host = value;
  let portText: string | undefined;
  if (bracketed !== null) {
    host = bracketed[1]!;
    portText = bracketed[2];
  } else if (colons === 1) {
    const parts = value.split(":");
    host = parts[0]!;
    portText = parts[1];
  }
  const port = portText === undefined ? configuredPort() : Number(portText);
  if (
    host.length === 0 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new CliUsageError(`Invalid peer address: ${value}`);
  }
  return { host, port };
}

/**
 * `call` takes the peer as a positional, so with `--peer-host` the positionals
 * shift left and the first one is the skill instead.
 */
function callTarget(parsed: {
  args: string[];
  peer: string | undefined;
  peerHost: string | undefined;
}): {
  peerId: string | undefined;
  peerHost: string | undefined;
  args: string[];
} {
  if (parsed.peerHost !== undefined) {
    if (parsed.peer !== undefined) {
      throw new CliUsageError("call takes either --peer or --peer-host");
    }
    if (parsed.args.length < 1 || parsed.args.length > 2) {
      throw new CliUsageError(
        "call with --peer-host requires a skill and optional JSON input",
      );
    }
    return {
      peerId: undefined,
      peerHost: parsed.peerHost,
      args: parsed.args,
    };
  }
  if (parsed.args.length < 2 || parsed.args.length > 3) {
    throw new CliUsageError(
      "call requires a peer, skill, and optional JSON input",
    );
  }
  return {
    peerId: parsed.args[0],
    peerHost: undefined,
    args: parsed.args.slice(1),
  };
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
  let onAbort: (() => void) | undefined;
  const abortPromise =
    signal === undefined
      ? undefined
      : new Promise<void>((resolve) => {
          const abort = (): void => resolve();
          onAbort = abort;
          signal.addEventListener("abort", abort, { once: true });
        });
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
      await Promise.race(
        abortPromise === undefined
          ? [sleep(Math.min(100, remaining))]
          : [sleep(Math.min(100, remaining)), abortPromise],
      );
    }
  } finally {
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
    await browser.stop();
  }
}

async function clientOptions(
  io: CliIO,
  timeoutMs: number,
): Promise<{
  identity: PeerIdentity;
  swarmKey: Uint8Array;
  timeoutMs: number;
}> {
  return {
    identity: io.identity ?? (await loadOrCreateIdentity()),
    swarmKey: io.swarmKey ?? (await loadSwarmKey()),
    timeoutMs,
  };
}

async function doctor(io: CliIO): Promise<number> {
  const spawnPolicy = io.spawnPolicy ?? parseSpawnPolicy();
  let identity: PeerIdentity | undefined;
  let credentialsError: string | undefined;
  if (io.identity !== undefined) {
    identity = io.identity;
  } else {
    try {
      identity = await readIdentity();
    } catch (error) {
      credentialsError = errorMessage(error);
    }
  }

  let swarmKeyPresent = io.swarmKey?.byteLength === 32;
  let swarmKeyError: string | undefined;
  if (io.swarmKey !== undefined && !swarmKeyPresent) {
    swarmKeyError = "Swarm key must be exactly 32 bytes";
  } else if (!swarmKeyPresent && io.swarmKey === undefined) {
    try {
      await loadSwarmKey();
      swarmKeyPresent = true;
    } catch (error) {
      if (!isMissingFileError(error)) {
        swarmKeyError = errorMessage(error);
      }
    }
  }
  const spawnOptedIn =
    process.env.PI_MESH_ALLOW_SPAWN !== undefined || spawnPolicy.enabled;
  let piBinary: string | undefined;
  let workspaceRoot: string | undefined;
  let spawnResolutionError: string | undefined;
  if (spawnOptedIn) {
    try {
      piBinary = resolvePiBinary();
      workspaceRoot = resolveWorkspaceRoot();
    } catch (error) {
      spawnResolutionError = errorMessage(error);
    }
  }
  const failed =
    credentialsError !== undefined ||
    swarmKeyError !== undefined ||
    spawnResolutionError !== undefined ||
    // A rejected policy is a configuration failure: it denies every peer while
    // looking like a first run, so it should not report success.
    spawnPolicy.warning !== undefined;
  io.stdout.write(
    `${JSON.stringify({
      peerId: identity?.peerId ?? null,
      name: identity?.name ?? process.env.PI_MESH_NAME ?? hostname(),
      swarmKeyPresent,
      ...(credentialsError === undefined ? {} : { credentialsError }),
      ...(swarmKeyError === undefined ? {} : { swarmKeyError }),
      configuredPort: configuredPort(),
      servedSkills: servedSkills(),
      piBinary: piBinary ?? null,
      workspaceRoot: workspaceRoot ?? null,
      ...(spawnResolutionError === undefined ? {} : { spawnResolutionError }),
      // Reported here because a rejected policy denies everything, and doctor
      // is the command an operator runs when nothing works. Without this, a
      // fail-closed configuration is indistinguishable from a broken agent.
      spawnPolicy: {
        enabled: spawnPolicy.enabled,
        ...(spawnPolicy.warning === undefined
          ? {}
          : { warning: spawnPolicy.warning }),
      },
      piVersionFloor: PI_SUPPORTED_FLOOR,
      piVersion: await detectedPiVersion(),
    })}\n`,
  );
  return failed ? 1 : 0;
}

async function readIdentity(): Promise<PeerIdentity | undefined> {
  const path = join(homedir(), ".pi-mesh", "credentials.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }

  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { peerId?: unknown }).peerId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        (value as { peerId: string }).peerId,
      )
    ) {
      throw new Error("credentials must contain a UUID peerId");
    }
    return {
      peerId: (value as { peerId: string }).peerId,
      name: process.env.PI_MESH_NAME ?? hostname(),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed identity credentials at ${path}: ${reason}`, {
      cause: error,
    });
  }
}

async function detectedPiVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const childRef: { child?: ReturnType<typeof execFileCallback> } = {};
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      childRef.child?.stdout?.destroy();
      childRef.child?.stderr?.destroy();
      childRef.child?.kill();
      resolve(null);
    }, 2_500);
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    childRef.child = execFileCallback(
      "pi",
      ["--version"],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          finish(null);
          return;
        }
        const match = `${stdout}\n${stderr}`.match(
          /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/,
        );
        finish(match?.[0] ?? null);
      },
    );
  });
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
  if (error instanceof CliUsageError) return 2;
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
  return configuredMeshPort();
}

function parseArguments(argv: string[]):
  | {
      command: string | undefined;
      args: string[];
      peer: string | undefined;
      peerHost: string | undefined;
      profile: NetworkProfile;
      watch: boolean;
      timeoutMs: number;
    }
  | undefined {
  let profile: NetworkProfile = "lan";
  let watch = false;
  let timeoutMs = 5_000;
  let peer: string | undefined;
  let peerHost: string | undefined;
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
    } else if (argument === "--peer-host") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return undefined;
      peerHost = value;
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
        peerHost,
        profile,
        watch,
        timeoutMs,
      }
    : undefined;
}

class CliUsageError extends Error {}

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
  void run(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
