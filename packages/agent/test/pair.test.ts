// SPDX-License-Identifier: GPL-3.0-or-later

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPairingToken,
  decodePairingToken,
  pairTokenId,
  pairingProof,
} from "@pi-mesh/protocol";
import { pair } from "../src/pair.js";
import type { CliIO } from "../src/cli.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function fixture(mode: "good" | "bad-hmac" | "verify-failure") {
  const token = createPairingToken();
  const key = decodePairingToken(token)!;
  const controlId = "control-id";
  let expectedTranscript:
    | {
        clientPeerId: string;
        clientNonce: string;
        serverPeerId: string;
        serverNonce: string;
      }
    | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
      string,
      string
    >;
    response.setHeader("content-type", "application/json");
    if (request.url === "/pair/hello") {
      // The handle must name the token actually passed on the command line;
      // the stub refuses anything else, so a client that stopped sending it
      // (or sent another token's handle) fails here rather than passing green.
      if (body.token_id !== pairTokenId(key)) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "bad token handle" }));
        return;
      }
      const transcript = {
        clientPeerId: body.agent_id!,
        clientNonce: body.nonce!,
        serverPeerId: controlId,
        serverNonce: "server-nonce",
      };
      expectedTranscript = transcript;
      response.end(
        JSON.stringify({
          control_id: controlId,
          nonce: "server-nonce",
          hmac:
            mode === "bad-hmac"
              ? "invalid"
              : pairingProof(key, transcript, "hello"),
        }),
      );
    } else {
      const expectedHmac =
        expectedTranscript === undefined
          ? undefined
          : pairingProof(key, expectedTranscript, "verify");
      if (
        body.agent_id !== expectedTranscript?.clientPeerId ||
        body.nonce !== expectedTranscript?.serverNonce ||
        body.hmac !== expectedHmac
      ) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "invalid proof" }));
        return;
      }
      if (mode === "verify-failure") {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "invalid proof" }));
      } else response.end(JSON.stringify({ ok: true }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing test server address");
  const directory = await mkdtemp(join(tmpdir(), "pi-mesh-pair-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIO = {
    stdout: {
      write: (text) => {
        stdout.push(
          typeof text === "string" ? text : Buffer.from(text).toString(),
        );
        return true;
      },
    },
    stderr: {
      write: (text) => {
        stderr.push(
          typeof text === "string" ? text : Buffer.from(text).toString(),
        );
        return true;
      },
    },
    identity: { peerId: "agent-id", name: "agent" },
    controlCredentialsPath: join(directory, "credentials.json"),
  };
  return {
    token,
    io,
    stdout,
    stderr,
    path: io.controlCredentialsPath!,
    host: `127.0.0.1:${address.port}`,
  };
}

describe("pair command", () => {
  it("pairs against an HTTP control plane and stores its credential", async () => {
    const state = await fixture("good");
    expect(
      await pair([state.token, "--control-host", state.host], state.io),
    ).toBe(0);
    expect(state.stdout.join("")).toContain('"control_id":"control-id"');
    expect(
      JSON.parse(await readFile(state.path, "utf8")).credentials[0].controlId,
    ).toBe("control-id");
  });
  it("does not write when the hello proof is wrong", async () => {
    const state = await fixture("bad-hmac");
    expect(
      await pair([state.token, "--control-host", state.host], state.io),
    ).toBe(1);
    expect(state.stderr.join("")).toContain(
      "control plane did not prove the token",
    );
    await expect(readFile(state.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("does not write when verify is rejected", async () => {
    const state = await fixture("verify-failure");
    expect(
      await pair([state.token, "--control-host", state.host], state.io),
    ).toBe(1);
    await expect(readFile(state.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
