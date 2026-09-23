// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createNonce,
  decodePairingToken,
  deriveControlCredential,
  pairTokenId,
  pairingProof,
  verifyPairingProof,
} from "@pi-mesh/protocol";
import Bonjour from "bonjour-service";
import { sleep } from "@pi-mesh/shared";
import type { CliIO } from "./cli.js";
import { browsePeers } from "./mdns.js";
import { PeerRegistry } from "./registry.js";
import { loadOrCreateIdentity } from "./identity.js";
import { saveControlCredential } from "./control-credentials.js";

export async function pair(argv: string[], io: CliIO): Promise<number> {
  const token = decodePairingToken(argv[0] ?? "");
  if (argv.length === 0 || token === undefined) {
    io.stderr.write("pair requires a valid 32-byte base64 pairing token\n");
    return 2;
  }
  let controlHost: string | undefined;
  let timeoutMs = 5_000;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--control-host") controlHost = argv[++index];
    else if (argument === "--timeout") {
      const seconds = Number(argv[++index]);
      if (!Number.isFinite(seconds) || seconds < 0) {
        io.stderr.write("Invalid --timeout value\n");
        return 2;
      }
      timeoutMs = seconds * 1_000;
    } else {
      io.stderr.write(`Unknown pair option: ${argument}\n`);
      return 2;
    }
  }
  try {
    const target =
      controlHost === undefined
        ? await discoverControl(timeoutMs, io)
        : parseControlAddress(controlHost);
    const urlHost = target.host.includes(":")
      ? `[${target.host}]`
      : target.host;
    const identity = io.identity ?? (await loadOrCreateIdentity());
    const clientNonce = createNonce();
    const fetcher = io.fetch ?? globalThis.fetch;
    const hello = await fetcher(`http://${urlHost}:${target.port}/pair/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: identity.peerId,
        agent_name: identity.name,
        nonce: clientNonce,
        // Where the control plane should call this agent once paired. The
        // listener port is configuration, not something pairing can discover
        // over an ephemeral HTTP connection, so it travels explicitly.
        agent_port: io.agentPort ?? configuredAgentPort(),
        // A handle for the token, never the token. Lets the control plane find
        // the right pending token without the secret crossing the wire.
        token_id: pairTokenId(token),
      }),
    });
    if (!hello.ok) throw new Error(`/pair/hello returned HTTP ${hello.status}`);
    const response: unknown = await hello.json();
    if (
      !isObject(response) ||
      typeof response.control_id !== "string" ||
      typeof response.nonce !== "string" ||
      typeof response.hmac !== "string"
    )
      throw new Error("Malformed /pair/hello response");
    const transcript = {
      clientPeerId: identity.peerId,
      clientNonce,
      serverPeerId: response.control_id,
      serverNonce: response.nonce,
    };
    if (!verifyPairingProof(token, response.hmac, transcript, "hello"))
      throw new Error("control plane did not prove the token");
    const credential = deriveControlCredential(token, transcript);
    const verify = await fetcher(
      `http://${urlHost}:${target.port}/pair/verify`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: identity.peerId,
          nonce: response.nonce,
          hmac: pairingProof(token, transcript, "verify"),
        }),
      },
    );
    if (!verify.ok)
      throw new Error(`/pair/verify returned HTTP ${verify.status}`);
    const verified: unknown = await verify.json();
    if (!isObject(verified) || verified.ok !== true)
      throw new Error("Malformed /pair/verify response");
    const pairedAt = new Date().toISOString();
    await saveControlCredential(
      { controlId: response.control_id, credential, pairedAt },
      io.controlCredentialsPath === undefined
        ? {}
        : { path: io.controlCredentialsPath },
    );
    io.stdout.write(
      `${JSON.stringify({ control_id: response.control_id, paired_at: pairedAt })}\n`,
    );
    io.stderr.write(`Paired with control plane ${response.control_id}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function discoverControl(
  timeoutMs: number,
  io: CliIO,
): Promise<{ host: string; port: number }> {
  const registry = new PeerRegistry();
  const browser = browsePeers(registry, {
    bonjour: io.bonjour ?? new Bonjour(),
  });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      registry.prune();
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    registry.prune();
    const controls = registry.peers.filter(
      (peer) => peer.serviceType === "control",
    );
    if (controls.length !== 1)
      throw new Error(
        `Expected exactly one control plane, found ${controls.length}`,
      );
    return { host: controls[0]!.host, port: controls[0]!.port };
  } finally {
    await browser.stop();
  }
}

function configuredAgentPort(): number {
  const configured = Number(process.env.PI_MESH_PORT ?? 7330);
  return Number.isInteger(configured) && configured > 0 && configured <= 65535
    ? configured
    : 7330;
}

function parseControlAddress(value: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Invalid control address: ${value}`);
  return { host, port };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
