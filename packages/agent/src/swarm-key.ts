// SPDX-License-Identifier: GPL-3.0-or-later

import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ErrorCode, PiMeshError } from "@pi-mesh/shared";

const SWARM_KEY_BYTES = 32;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalidKey(message: string, cause?: unknown): PiMeshError {
  return cause === undefined
    ? new PiMeshError(ErrorCode.Unauthorized, message)
    : new PiMeshError(ErrorCode.Unauthorized, message, { cause });
}

export function generateSwarmKey(): string {
  return randomBytes(SWARM_KEY_BYTES).toString("base64");
}

export function decodeSwarmKey(encoded: string): Uint8Array {
  if (!BASE64_PATTERN.test(encoded)) {
    throw invalidKey("Swarm key must be valid base64");
  }

  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw invalidKey("Swarm key must be valid base64");
  }
  if (decoded.length !== SWARM_KEY_BYTES) {
    throw invalidKey(
      `Swarm key must decode to exactly 32 bytes (got ${decoded.length})`,
    );
  }

  return new Uint8Array(decoded);
}

export async function loadSwarmKey(path?: string): Promise<Uint8Array> {
  const keyPath = path ?? join(homedir(), ".pi-mesh", "swarm.key");

  // Check permissions before reading the secret: a malformed 0644 file should
  // report the permission problem, not a length problem.
  let fileMode: number;
  try {
    fileMode = (await stat(keyPath)).mode;
  } catch (error) {
    throw invalidKey(
      `Unable to read swarm key at ${keyPath}: ${errorMessage(error)}`,
      error,
    );
  }

  // POSIX only: pi-mesh does not currently support Windows, where stat()
  // reports synthetic modes and every key would be rejected here.
  if ((fileMode & 0o077) !== 0) {
    const mode = (fileMode & 0o777).toString(8).padStart(4, "0");
    throw invalidKey(
      `Swarm key at ${keyPath} has insecure permissions: mode ${mode}, expected 0600`,
    );
  }

  let encoded: string;
  try {
    encoded = await readFile(keyPath, "utf8");
  } catch (error) {
    throw invalidKey(
      `Unable to read swarm key at ${keyPath}: ${errorMessage(error)}`,
      error,
    );
  }

  try {
    return decodeSwarmKey(encoded.trim());
  } catch (error) {
    if (error instanceof PiMeshError) {
      throw invalidKey(
        `Invalid swarm key at ${keyPath}: ${error.message}`,
        error,
      );
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
