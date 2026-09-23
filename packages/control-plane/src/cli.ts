#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { isDirectInvocation } from "@pi-mesh/shared";
import {
  SERVICE_TYPE_CONTROL,
  type BonjourLike,
  publishControlPlane,
  type ControlPlaneService,
} from "./mdns.js";
import { ControlStore } from "./db.js";
import { PairingService } from "./pairing.js";
import { createControlServer, type ControlServer } from "./server.js";

export type StreamLike = Pick<NodeJS.WritableStream, "write">;
export interface CliIO {
  stdout: StreamLike;
  stderr: StreamLike;
  bonjour?: BonjourLike;
  store?: ControlStore;
  server?: Pick<ControlServer, "start" | "stop" | "dashboardUrl">;
}
const usage =
  "Usage: pi-mesh-control-plane <serve|publish|token|help>\n" +
  "\nCommands:\n  serve    Run the dashboard and advertise the control plane\n  publish  Advertise the control plane over mDNS\n  token    Print the dashboard token (for pasting into the dashboard)\n  help     Show this usage information\n" +
  "\nserve flags:\n  --print-token                Also print the dashboard token to stderr\n  --allow-insecure-execution   Serve execution over plaintext, non-loopback HTTP\n";
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
  if (command === "serve") return serve(io, argv.slice(1));
  if (command === "token") return printToken(io);
  if (command !== "publish") {
    io.stderr.write(usage);
    return 2;
  }

  const service = controlPlaneService(controlPlanePort());
  try {
    const options =
      io.bonjour === undefined ? undefined : { bonjour: io.bonjour };
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

async function printToken(io: CliIO): Promise<number> {
  const database =
    process.env.PI_MESH_DB ?? join(homedir(), ".pi-mesh", "control.db");
  const store = io.store ?? new ControlStore(database);
  try {
    io.stdout.write(`${store.dashboardToken()}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`Failed to read the dashboard token: ${message}\n`);
    return 1;
  } finally {
    if (io.store === undefined) store.close();
  }
}

async function serve(io: CliIO, flags: string[]): Promise<number> {
  const allowInsecure =
    flags.includes("--allow-insecure-execution") ||
    process.env.PI_MESH_ALLOW_INSECURE_EXECUTION === "1";
  let ownedStore: ControlStore | undefined;
  let server:
    Pick<ControlServer, "start" | "stop" | "dashboardUrl"> | undefined;
  let advertisement:
    Awaited<ReturnType<typeof publishControlPlane>> | undefined;
  try {
    const database =
      process.env.PI_MESH_DB ?? join(homedir(), ".pi-mesh", "control.db");
    const store = io.store ?? (ownedStore = new ControlStore(database));
    const controlName = store.controlName(
      process.env.PI_MESH_NAME ?? hostname(),
    );
    const pairing = new PairingService({
      controlId: store.controlId(),
      controlName,
    });
    server =
      io.server ??
      createControlServer({
        store,
        pairing,
        allowInsecureExecution: allowInsecure,
      });
    const listening = await server.start();
    advertisement = await publishControlPlane(
      {
        id: store.controlId(),
        name: controlName,
        version: "0.0.0",
        apiVersion: "1",
        port: listening.port,
      },
      io.bonjour === undefined ? undefined : { bonjour: io.bonjour },
    );
    const issued = pairing.issue();
    // The URL deliberately carries no token (ADR 0014). Reading it is an
    // explicit act, so it cannot land in a log line by accident.
    io.stderr.write(`Dashboard: ${server.dashboardUrl()}\n`);
    if (flags.includes("--print-token")) {
      io.stderr.write(`Dashboard token: ${store.dashboardToken()}\n`);
    }
    if (allowInsecure) {
      io.stderr.write(
        "WARNING: --allow-insecure-execution is on. A captured dashboard request can spawn on any opted-in agent.\n",
      );
    }
    io.stderr.write(`Pairing token: ${issued.token}\n`);
    return await new Promise<number>((resolveExit) => {
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        void Promise.all([server!.stop(), advertisement!.stop()]).then(
          () => resolveExit(0),
          () => resolveExit(1),
        );
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`Failed to serve control plane: ${message}\n`);
    return 1;
  } finally {
    ownedStore?.close();
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  void run(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
