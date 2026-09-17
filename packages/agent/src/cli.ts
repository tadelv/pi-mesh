#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateSwarmKey } from "./swarm-key.js";

export type CliIO = {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
};

const usage = "Usage: pi-mesh-agent keygen\n";

export async function run(
  argv: string[],
  io: CliIO = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  if (argv[0] === "keygen") {
    io.stdout.write(`${generateSwarmKey()}\n`);
    return 0;
  }

  io.stderr.write(usage);
  return 2;
}

/**
 * True when this module was invoked as the process entry point.
 *
 * Both sides go through realpath: npm and pnpm install `bin` entries as
 * symlinks, so import.meta.url is the real file while argv[1] is the link.
 * Comparing with resolve() alone silently skips the whole CLI there.
 */
export function isDirectInvocation(
  metaUrl: string,
  entryPath: string | undefined,
): boolean {
  if (entryPath === undefined) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entryPath);
  } catch {
    return false;
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  void run(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
