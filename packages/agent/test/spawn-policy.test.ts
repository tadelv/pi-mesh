// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAgentServer,
  EXECUTION_SKILLS,
  parseSpawnPolicy,
  servedSkills,
  signedHeaders,
  SkillRegistry,
  type SpawnPolicy,
} from "../src/index.js";

const testIdentity = {
  peerId: "22222222-2222-4222-8222-222222222222",
  name: "test",
};
const testKey = Buffer.from("pi-mesh-vector-key-0123456789abc");
const callerIdentity = {
  peerId: "33333333-3333-4333-8333-333333333333",
  name: "caller",
};

type HttpResult = {
  status: number;
  body: string;
};

function post(port: number, body: unknown): Promise<HttpResult> {
  const text = JSON.stringify(body);
  const headers = signedHeaders(testKey, callerIdentity, {
    method: "POST",
    path: "/",
    body: text,
    recipientPeerId: testIdentity.peerId,
  });
  return new Promise((resolve, reject) => {
    const client = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(text),
          "A2A-Version": "1.0",
          ...headers,
        },
      },
      (response) => {
        let received = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (received += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: received }),
        );
      },
    );
    client.on("error", reject);
    client.end(text);
  });
}

function sendMessage(skill: string, input: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        messageId: "message-1",
        role: "ROLE_USER",
        parts: [{ data: { skill, input } }],
      },
    },
  };
}

/** A server whose registry serves `session.steer`, an execution skill. */
async function executionServer(
  policy: SpawnPolicy,
): Promise<{ port: number; calls: unknown[]; stop: () => Promise<void> }> {
  const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-mesh-gate-"));
  const calls: unknown[] = [];
  const skills = new SkillRegistry();
  // Registered precisely because it is an execution skill: the gate can only
  // be exercised through a skill this agent actually serves.
  skills.register("session.steer", async (input) => {
    calls.push(input);
    return { accepted: true };
  });
  const server = createAgentServer({
    host: "127.0.0.1",
    port: 0,
    swarmKey: testKey,
    identity: testIdentity,
    sessionsRoot,
    skillRegistry: skills,
    spawnPolicy: policy,
  });
  const listening = await server.start();
  return { port: listening.port, calls, stop: () => server.stop() };
}

describe("spawn policy parsing", () => {
  it("denies everything when unset, empty, or only separators", () => {
    for (const value of [undefined, "", "   ", ",", " , "]) {
      const policy = parseSpawnPolicy(value);
      expect(policy.enabled).toBe(false);
      expect(policy.allows(callerIdentity.peerId)).toBe(false);
      expect(policy.allows("")).toBe(false);
    }
  });

  it("allows any identified peer for the wildcard", () => {
    const policy = parseSpawnPolicy("*");
    expect(policy.enabled).toBe(true);
    expect(policy.allows(callerIdentity.peerId)).toBe(true);
    expect(policy.allows("00000000-0000-4000-8000-000000000000")).toBe(true);
    // An empty identity is never a peer, so it is never authorised.
    expect(policy.allows("")).toBe(false);
  });

  it("allows exactly the listed peer ids", () => {
    const policy = parseSpawnPolicy(
      ` ${callerIdentity.peerId} , 11111111-1111-4111-8111-111111111111 `,
    );
    expect(policy.enabled).toBe(true);
    expect(policy.allows(callerIdentity.peerId)).toBe(true);
    expect(policy.allows("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(policy.allows("44444444-4444-4444-8444-444444444444")).toBe(false);
  });

  it("ignores empty entries rather than widening the grant", () => {
    const policy = parseSpawnPolicy(`,${callerIdentity.peerId},,`);
    expect(policy.enabled).toBe(true);
    expect(policy.allows(callerIdentity.peerId)).toBe(true);
    expect(policy.allows("")).toBe(false);
    expect(policy.allows("44444444-4444-4444-8444-444444444444")).toBe(false);
  });

  it("reads the environment when no explicit value is given", () => {
    expect(parseSpawnPolicy(undefined, "*").enabled).toBe(true);
    expect(parseSpawnPolicy(undefined, undefined).enabled).toBe(false);
    expect(parseSpawnPolicy(undefined, "").enabled).toBe(false);
    // An explicit value wins over the environment.
    expect(parseSpawnPolicy("", "*").enabled).toBe(false);
  });
});

describe("the execution gate", () => {
  it("refuses a served execution skill when nothing is opted in", async () => {
    const server = await executionServer(
      parseSpawnPolicy(undefined, undefined),
    );
    try {
      const response = await post(server.port, sendMessage("session.steer"));
      const body = JSON.parse(response.body) as {
        error?: {
          code: number;
          message: string;
          data?: { details?: { reason?: string }[] };
        };
      };
      expect(body.error?.code).toBe(-32102);
      // A2A's ErrorInfo, which is what a peer routes on.
      expect(body.error?.data?.details?.[0]?.reason).toBe(
        "PI_MESH_SPAWN_DENIED",
      );
      expect(body.error?.message).toContain("PI_MESH_ALLOW_SPAWN");
      // The proof that the gate ran before any side effect: the handler is the
      // only thing that could have done work, and it was never entered.
      expect(server.calls).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  it("serves the same skill once the machine opts in", async () => {
    const server = await executionServer(parseSpawnPolicy("*"));
    try {
      const response = await post(server.port, sendMessage("session.steer"));
      const body = JSON.parse(response.body) as {
        result?: unknown;
        error?: unknown;
      };
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();
      expect(server.calls).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("admits a listed peer and refuses an unlisted one", async () => {
    // The list narrows which of your own agents may execute. It is not an
    // authorisation boundary against a malicious member, who can claim any
    // peer id (ADR 0007): only the machine-wide opt-in is.
    const listed = await executionServer(
      parseSpawnPolicy(callerIdentity.peerId),
    );
    try {
      const response = await post(listed.port, sendMessage("session.steer"));
      expect(JSON.parse(response.body).error).toBeUndefined();
      expect(listed.calls).toHaveLength(1);
    } finally {
      await listed.stop();
    }
    const unlisted = await executionServer(
      parseSpawnPolicy("99999999-9999-4999-8999-999999999999"),
    );
    try {
      const response = await post(unlisted.port, sendMessage("session.steer"));
      expect(JSON.parse(response.body).error?.code).toBe(-32102);
      expect(unlisted.calls).toHaveLength(0);
    } finally {
      await unlisted.stop();
    }
  });

  it("gates every execution skill on every dispatch path", async () => {
    // message/send and message/stream are separate routes. A gate present in
    // only one of them is a bypass waiting for the day a gated skill becomes
    // streamable, so this iterates the list rather than naming one skill.
    const server = await executionServer(
      parseSpawnPolicy(undefined, undefined),
    );
    try {
      // The code must be asserted per path, not as a set of acceptable codes:
      // an assertion that accepts either code passes even when a path has no
      // gate at all, which is exactly the bypass this test exists to catch.
      const servedExecutionSkill = "session.steer";
      for (const skill of EXECUTION_SKILLS) {
        const expected = skill === servedExecutionSkill ? -32102 : -32004;
        for (const method of ["message/send", "message/stream"]) {
          const request = sendMessage(skill);
          request.method = method;
          const response = await post(server.port, request);
          const code = JSON.parse(response.body).error?.code;
          expect(`${method} ${skill}: ${String(code)}`).toBe(
            `${method} ${skill}: ${expected}`,
          );
        }
      }
      expect(server.calls).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  it("does not gate a read skill", async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-mesh-gate-read-"));
    const directory = join(sessionsRoot, "--read--");
    await mkdir(directory);
    const id = "123e4567-e89b-42d3-a456-426614174099";
    await writeFile(
      join(directory, `${id}.jsonl`),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: "/read",
      })}\n`,
    );
    const server = createAgentServer({
      host: "127.0.0.1",
      port: 0,
      swarmKey: testKey,
      identity: testIdentity,
      sessionsRoot,
      // Gate fully closed: reading must still work, because membership grants
      // reading (ADR 0008 decision 1).
      spawnPolicy: parseSpawnPolicy(undefined, undefined),
    });
    const listening = await server.start();
    try {
      const response = await post(listening.port, sendMessage("session.list"));
      const body = JSON.parse(response.body) as {
        result?: unknown;
        error?: unknown;
      };
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();
    } finally {
      await server.stop();
    }
  });

  it("still reports an unserved execution skill as unsupported, not denied", async () => {
    // -32102 says "this agent does it, but not for you"; -32004 says "this
    // agent does not do it at all". Reporting a spawn denial for a skill that
    // was never implemented would be a lie, and a peer routes on the code.
    const server = await executionServer(parseSpawnPolicy("*"));
    try {
      const response = await post(server.port, sendMessage("process.spawn"));
      expect(JSON.parse(response.body).error?.code).toBe(-32004);
    } finally {
      await server.stop();
    }
  });
});

describe("capability honesty and the gate", () => {
  it("does not advertise an execution skill the agent does not serve", () => {
    // Until the execution skills are implemented they are absent from the
    // served set, so the card and the mDNS caps value cannot over-advertise
    // them no matter how the gate is set. M2-8 makes the gate itself filter
    // this list; this asserts the invariant that already holds.
    const served = servedSkills();
    for (const skill of ["process.spawn", "session.steer"]) {
      expect(served).not.toContain(skill);
    }
  });
});
