#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import { hostname } from "node:os";
import { isDirectInvocation } from "@pi-mesh/shared";
import {
  SERVICE_TYPE_CONTROL,
  type BonjourLike,
  publishControlPlane,
  type ControlPlaneService,
} from "./mdns.js";

export type StreamLike = Pick<NodeJS.WritableStream, "write">;

export interface CliIO {
  stdout: StreamLike;
  stderr: StreamLike;
  bonjour?: BonjourLike;
}

const usage =
  "Usage: pi-mesh-control-plane <publish|help>\n" +
  "\n" +
  "Commands:\n" +
  "  publish  Advertise the control plane over mDNS\n" +
  "  help     Show this usage information\n";
const DEFAULT_PORT = 7331;

function controlPlanePort(): number {
  const configured = Number(process.env.PI_MESH_PORT ?? DEFAULT_PORT);
  return Number.isInteger(configured) && configured > 0 && configured <= 65535
    ? configured
    : DEFAULT_PORT;
}

function controlPlaneService(port: number): ControlPlaneService {
  return {
    id: hostname(),
    name: process.env.PI_MESH_NAME ?? "pi-mesh-control-plane",
    version: "0.0.0",
    apiVersion: "1",
    port,
    fingerprint: process.env.PI_MESH_FINGERPRINT ?? "unpaired",
  };
}

export async function run(
  argv: string[],
  io: CliIO = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === "help") {
    io.stdout.write(usage);
    return 0;
  }
  if (command !== "publish") {
    io.stderr.write(usage);
    return 2;
  }

  const service = controlPlaneService(controlPlanePort());
  try {
    const options = io.bonjour === undefined ? undefined : { bonjour: io.bonjour };
    const handle = await publishControlPlane(service, options);
    io.stderr.write(
      `Advertised ${SERVICE_TYPE_CONTROL} service "${service.name}" on port ${service.port}\n`,
    );

    return await new Promise<number>((resolveExit) => {
      process.once("SIGINT", () => {
        void handle.stop().then(
          () => resolveExit(0),
          () => resolveExit(1),
        );
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`Failed to advertise control plane: ${message}\n`);
    return 1;
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  void run(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
