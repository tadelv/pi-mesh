// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  run,
  ControlStore,
  SERVICE_TYPE_CONTROL,
  type BonjourLike,
  type CliIO,
} from "../src/index.js";

function captured(bonjour?: BonjourLike) {
  let stdout = "";
  let stderr = "";
  const io: CliIO = {
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    },
    ...(bonjour === undefined ? {} : { bonjour }),
  };
  return { io, read: () => ({ stdout, stderr }) };
}

describe("control-plane CLI", () => {
  it.each([[[]], [["help"]]])("prints usage for %j", async (argv) => {
    const output = captured();

    await expect(run(argv, output.io)).resolves.toBe(0);
    expect(output.read().stdout).toMatch(
      /Usage: pi-mesh-control-plane <serve\|publish\|token\|help>/,
    );
    expect(output.read().stderr).toBe("");
  });

  it("rejects unknown commands with usage on stderr", async () => {
    const output = captured();

    await expect(run(["bogus"], output.io)).resolves.toBe(2);
    expect(output.read().stdout).toBe("");
    expect(output.read().stderr).toMatch(
      /Usage: pi-mesh-control-plane <serve\|publish\|token\|help>/,
    );
  });

  it("serves and stops injected resources on SIGINT", async () => {
    let stoppedServer = false;
    let stoppedBonjour = false;
    const store = new ControlStore(":memory:");
    const output = captured({
      publish() {
        return undefined;
      },
      destroy() {
        stoppedBonjour = true;
      },
    });
    output.io.store = store;
    output.io.server = {
      async start() {
        return { address: "127.0.0.1", port: 7445 };
      },
      async stop() {
        stoppedServer = true;
      },
      dashboardUrl() {
        // Faithful to the real contract (ADR 0014): the URL carries no token.
        return "http://127.0.0.1:7445/";
      },
    };
    try {
      const result = run(["serve"], output.io);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(output.read().stderr).toContain("http://127.0.0.1:7445/");
      // `serve` does not print the token: reading it is an explicit act.
      expect(output.read().stderr).not.toContain(store.dashboardToken());
      expect(output.read().stderr).toMatch(/Pairing token: [A-Za-z0-9+/]+=*/);
      process.emit("SIGINT");
      await expect(result).resolves.toBe(0);
      expect(stoppedServer).toBe(true);
      expect(stoppedBonjour).toBe(true);
    } finally {
      store.close();
    }
  });

  it("prints the dashboard token on request, and only on request", async () => {
    const store = new ControlStore(":memory:");
    try {
      const direct = captured();
      direct.io.store = store;
      await expect(run(["token"], direct.io)).resolves.toBe(0);
      expect(direct.read().stdout).toBe(`${store.dashboardToken()}\n`);

      const asked = captured({
        publish: () => undefined,
        destroy: () => undefined,
      });
      asked.io.store = store;
      asked.io.server = {
        async start() {
          return { address: "127.0.0.1", port: 7445 };
        },
        async stop() {
          return undefined;
        },
        dashboardUrl() {
          return "http://127.0.0.1:7445/";
        },
      };
      const served = run(["serve", "--print-token"], asked.io);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(asked.read().stderr).toContain(
        `Dashboard token: ${store.dashboardToken()}`,
      );
      process.emit("SIGINT");
      await expect(served).resolves.toBe(0);
    } finally {
      store.close();
    }
  });

  it("publishes through an injected bonjour instance until SIGINT", async () => {
    const published: Array<{ type: string; name: string; port: number }> = [];
    let destroyed = false;
    const bonjour: BonjourLike = {
      publish(options) {
        published.push({
          type: options.type,
          name: options.name,
          port: options.port,
        });
        return undefined;
      },
      destroy() {
        destroyed = true;
      },
    };
    const output = captured(bonjour);
    const previousPort = process.env.PI_MESH_PORT;
    process.env.PI_MESH_PORT = "7444";

    try {
      const result = run(["publish"], output.io);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(published).toHaveLength(1);
      expect(published[0]?.type).toBe("pi-mesh-control");
      expect(`_${published[0]?.type}._tcp`).toBe(SERVICE_TYPE_CONTROL);
      expect(published[0]?.port).toBe(7444);
      process.emit("SIGINT");
      await expect(result).resolves.toBe(0);
      expect(destroyed).toBe(true);
      expect(output.read().stderr).toMatch(/Advertised/);
    } finally {
      if (previousPort === undefined) delete process.env.PI_MESH_PORT;
      else process.env.PI_MESH_PORT = previousPort;
    }
  });
});
