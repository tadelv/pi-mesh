// SPDX-License-Identifier: GPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export type PeerIdentity = {
  peerId: string;
  name: string;
};

const pending = new Map<string, Promise<PeerIdentity>>();

export function loadOrCreateIdentity(
  options: {
    path?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<PeerIdentity> {
  const path = options.path ?? join(homedir(), ".pi-mesh", "credentials.json");
  const existing = pending.get(path);
  if (existing !== undefined) return existing;
  const result = loadOrCreate(path, options.env ?? process.env);
  pending.set(path, result);
  void result.finally(() => pending.delete(path)).catch(() => undefined);
  return result;
}

async function loadOrCreate(
  path: string,
  env: NodeJS.ProcessEnv,
): Promise<PeerIdentity> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  let peerId: string;
  try {
    const text = await readFile(path, "utf8");
    peerId = parsePeerId(text, path);
    await chmod(path, 0o600);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    peerId = randomUUID();
    const temporary = join(
      directory,
      `.credentials.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, `${JSON.stringify({ peerId })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await removeIfPresent(temporary);
    }
  }

  return { peerId, name: env.PI_MESH_NAME ?? hostname() };
}

function parsePeerId(text: string, path: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { peerId?: unknown }).peerId !== "string" ||
      !isUuid((value as { peerId: string }).peerId)
    ) {
      throw new Error("credentials must contain a UUID peerId");
    }
    return (value as { peerId: string }).peerId;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed identity credentials at ${path}: ${reason}`, {
      cause: error,
    });
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}
