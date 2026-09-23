// SPDX-License-Identifier: GPL-3.0-or-later

import {
  mkdir,
  readFile,
  rename,
  chmod,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ControlCredential {
  controlId: string;
  credential: string;
  pairedAt: string;
}

/**
 * The credentials file the agent reads when no explicit path is given. Exported
 * because the running server has to stat the same file to notice a pairing that
 * happened in another process (issue #2).
 */
export function defaultControlCredentialsPath(path?: string): string {
  return path ?? join(homedir(), ".pi-mesh", "control-credentials.json");
}

export async function loadControlCredentials(
  options: { path?: string } = {},
): Promise<ControlCredential[]> {
  const path = defaultControlCredentialsPath(options.path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Array.isArray((value as { credentials?: unknown }).credentials)
    )
      throw new Error("credentials must be an array");
    return (value as { credentials: unknown[] }).credentials.map(parseEntry);
  } catch (error) {
    throw new Error(
      `Malformed control credentials at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function saveControlCredential(
  entry: ControlCredential,
  options: { path?: string } = {},
): Promise<void> {
  parseEntry(entry);
  const path = defaultControlCredentialsPath(options.path);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const credentials = await loadControlCredentials({ path });
  const next = credentials.filter((item) => item.controlId !== entry.controlId);
  next.push(entry);
  const temporary = join(
    directory,
    `.control-credentials.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ credentials: next }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await removeTemporary(temporary);
  }
}

export function controlCredentialBytes(entry: ControlCredential): Uint8Array {
  const decoded = Buffer.from(entry.credential, "base64");
  if (
    decoded.byteLength === 0 ||
    decoded.toString("base64") !== entry.credential
  )
    throw new Error("Malformed control credential base64");
  return decoded;
}

function parseEntry(value: unknown): ControlCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("credential entry must be an object");
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.controlId !== "string" ||
    !entry.controlId ||
    typeof entry.credential !== "string" ||
    typeof entry.pairedAt !== "string" ||
    !Number.isFinite(Date.parse(entry.pairedAt))
  )
    throw new Error(
      "credential entry requires controlId, base64 credential, and pairedAt",
    );
  const decoded = Buffer.from(entry.credential, "base64");
  if (
    decoded.byteLength === 0 ||
    decoded.toString("base64") !== entry.credential
  )
    throw new Error("credential must be canonical base64");
  return {
    controlId: entry.controlId,
    credential: entry.credential,
    pairedAt: entry.pairedAt,
  };
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
