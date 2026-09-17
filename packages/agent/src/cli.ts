#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import { isDirectInvocation } from "@pi-mesh/shared";
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

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  void run(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
