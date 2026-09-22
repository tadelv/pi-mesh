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
  includeSpawn = true,
): Promise<{ port: number; calls: unknown[]; stop: () => Promise<void> }> {
  const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-mesh-gate-"));
  const calls: unknown[] = [];
  const skills = new SkillRegistry();
  // Registered precisely because it is an execution skill: the gate can only
  // be exercised through a skill this agent actually serves.
  // Registered via registerExecution precisely because it is an execution
  // skill: `register` now refuses those, so an executing handler cannot be
  // served without meeting the gate.
  skills.registerExecution("session.steer", async (input) => {
    calls.push(input);
    return { accepted: true };
  });
  if (includeSpawn) {
    skills.registerExecution("process.spawn", async (input) => {
      calls.push(input);
      return { accepted: true };
    });
    skills.registerExecution("mesh.handoff", async (input) => {
      calls.push(input);
      return { accepted: true };
    });
  }
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
    // Both arguments are passed explicitly: defaulting to the real
    // process.env would make this depend on the ambient environment, and
    // PI_MESH_ALLOW_SPAWN is exactly the variable an operator may have set.
    for (const value of [undefined, "", "   ", ",", " , "]) {
      const policy = parseSpawnPolicy(value, "");
      expect(policy.enabled).toBe(false);
      expect(policy.allows(callerIdentity.peerId)).toBe(false);
      expect(policy.allows("")).toBe(false);
    }
  });

  it("allows any identified peer for the wildcard", () => {
    const policy = parseSpawnPolicy("*", "");
    expect(policy.enabled).toBe(true);
    expect(policy.allows(callerIdentity.peerId)).toBe(true);
    expect(policy.allows("00000000-0000-4000-8000-000000000000")).toBe(true);
    // An empty identity is never a peer, so it is never authorised.
    expect(policy.allows("")).toBe(false);
  });

  it("allows exactly the listed peer ids", () => {
    const policy = parseSpawnPolicy(
      ` ${callerIdentity.peerId} , 11111111-1111-4111-8111-111111111111 `,
      "",
    );
    expect(policy.enabled).toBe(true);
    expect(policy.allows(callerIdentity.peerId)).toBe(true);
    expect(policy.allows("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(policy.allows("44444444-4444-4444-8444-444444444444")).toBe(false);
  });

  it("ignores empty entries rather than widening the grant", () => {
    const policy = parseSpawnPolicy(`,${callerIdentity.peerId},,`, "");
    expect(policy.enabled).toBe(true);
    expect(policy.allows(callerIdentity.peerId)).toBe(true);
    expect(policy.allows("")).toBe(false);
    expect(policy.allows("44444444-4444-4444-8444-444444444444")).toBe(false);
  });

  it("treats a wildcard mixed with IDs as malformed, not as a wildcard", () => {
    // The operator who had "*" and appended a peer ID meant to narrow the
    // grant. Reading any "*" entry as a wildcard would widen it to every member
    // instead - the one direction a security control must never fail.
    for (const value of [
      `*,${callerIdentity.peerId}`,
      `${callerIdentity.peerId},*`,
      ` *, ${callerIdentity.peerId} `,
    ]) {
      const policy = parseSpawnPolicy(value, "");
      expect(policy.enabled).toBe(false);
      expect(policy.allows(callerIdentity.peerId)).toBe(false);
      expect(policy.allows("99999999-9999-4999-8999-999999999999")).toBe(false);
      expect(policy.warning).toBeDefined();
    }
  });

  it("rejects entries that cannot name a peer, rather than misreporting capability", () => {
    // A token that is not a peer ID can never match a real peer. Accepting it
    // would set `enabled` while allowing nobody, which would misreport this
    // machine's capability once M2-8 filters advertising on the gate.
    for (const value of ["true", "yes", "peer-1", "not-a-uuid"]) {
      const policy = parseSpawnPolicy(value, "");
      expect(policy.enabled).toBe(false);
      expect(policy.allows(value)).toBe(false);
      expect(policy.warning).toBeDefined();
    }
  });

  it("matches listed peer ids case-insensitively", () => {
    const policy = parseSpawnPolicy(callerIdentity.peerId.toUpperCase(), "");
    expect(policy.enabled).toBe(true);
    expect(policy.allows(callerIdentity.peerId)).toBe(true);
    expect(policy.allows(callerIdentity.peerId.toUpperCase())).toBe(true);
  });

  it("denies a value containing more than one wildcard", () => {
    for (const value of ["*,*", "*,,*", "* , *"]) {
      const policy = parseSpawnPolicy(value, "");
      expect(policy.enabled).toBe(false);
      expect(policy.allows(callerIdentity.peerId)).toBe(false);
      expect(policy.warning).toBeDefined();
    }
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
    const server = await executionServer(parseSpawnPolicy("*", ""));
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
      parseSpawnPolicy(callerIdentity.peerId, ""),
    );
    try {
      const response = await post(listed.port, sendMessage("session.steer"));
      expect(JSON.parse(response.body).error).toBeUndefined();
      expect(listed.calls).toHaveLength(1);
    } finally {
      await listed.stop();
    }
    const unlisted = await executionServer(
      parseSpawnPolicy("99999999-9999-4999-8999-999999999999", ""),
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
      for (const skill of EXECUTION_SKILLS) {
        const expected = -32102;
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
    //
    // The policy DENIES, which is what makes this discriminate: with the
    // served-check absent, the gate fires first and yields -32102, so a test
    // run with an allowing policy would pass either way and catch nothing.
    const server = await executionServer(
      parseSpawnPolicy(undefined, ""),
      false,
    );
    try {
      const response = await post(server.port, sendMessage("process.spawn"));
      expect(JSON.parse(response.body).error?.code).toBe(-32004);
    } finally {
      await server.stop();
    }
  });
});

describe("capability honesty and the gate", () => {
  it("does not list an execution skill the agent does not serve", () => {
    // A tripwire on the module constant, not a test of advertising: the card
    // and the mDNS caps value both derive from servedSkills(), so asserting
    // that they agree would compare a value to itself. M2-8 carries the real
    // assertion (the gate's effect on the advertised set).
    const served = servedSkills();
    for (const skill of EXECUTION_SKILLS) {
      expect(served).not.toContain(skill);
    }
  });

  it("refuses to register an executing skill without the gate, and only that", () => {
    // Both directions are startup errors, so the invariant is enforced by the
    // type-adjacent API rather than by memory: an executing skill cannot be
    // registered ungated, and a non-executing one cannot claim the gate.
    const skills = new SkillRegistry();
    expect(() => skills.register("session.steer", async () => ({}))).toThrow(
      /register it with registerExecution/,
    );
    // Deliberately ungated (ADR 0008 decision 5), so it is not an execution
    // skill and must not be registered as one.
    expect(() =>
      skills.registerExecution("process.stop", async () => ({})),
    ).toThrow(/must use register/);
    // And the sanctioned path actually serves the skill.
    skills.registerExecution("session.steer", async () => ({ accepted: true }));
    expect(skills.has("session.steer")).toBe(true);
    skills.register("session.list", async () => ({ sessions: [] }));
    expect(skills.has("session.list")).toBe(true);
  });
});
