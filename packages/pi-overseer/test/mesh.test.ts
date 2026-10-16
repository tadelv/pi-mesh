// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Mesh tool tests (M8-2). The client is injected as a stub object, so no
 * test touches the network: every clause below names the mesh behaviour it
 * protects, and each has a positive control elsewhere in this file proving
 * the stub can succeed (a refusal-only stub would pass trivially).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  executeMeshAction,
  type MeshActionParams,
  type MeshCredentials,
  type MeshDeps,
} from "../mesh.js";

const CREDS: MeshCredentials = {
  identity: { peerId: "local-peer-id", name: "local" },
  swarmKey: new Uint8Array(32).fill(7),
};

const REMOTE_B = {
  id: "peer-b-id",
  name: "b",
  host: "192.168.1.20",
  port: 7330,
};
const REMOTE_C = {
  id: "peer-c-id",
  name: "c",
  host: "192.168.1.21",
  port: 7330,
};

interface SentCall {
  peerId: string;
  skill: string;
  input: unknown;
}

function refusalError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function handoffTask(handles: {
  taskId: string;
  sessionId: string;
  jobId: string;
}) {
  return {
    id: "task-1",
    status: {
      state: "TASK_STATE_WORKING",
      message: {
        messageId: "m-1",
        role: "ROLE_AGENT",
        parts: [
          {
            data: {
              result: {
                task_id: handles.taskId,
                session_id: handles.sessionId,
                job_id: handles.jobId,
              },
            },
          },
        ],
      },
    },
  };
}

/**
 * A stub transport: `peers` answers the fleet, every other skill delegates
 * to `onSkill` (which may throw a coded refusal like a real peer). All
 * sends are recorded so a test can assert nothing was constructed.
 */
function makeDeps(
  options: {
    credentials?: MeshCredentials | "unavailable";
    peers?: (typeof REMOTE_B)[];
    onSkill?: (call: SentCall) => unknown;
  } = {},
): { deps: MeshDeps; sent: SentCall[] } {
  const sent: SentCall[] = [];
  const peers = options.peers ?? [REMOTE_B, REMOTE_C];
  const deps: MeshDeps = {
    loadCredentials: vi.fn(async () => {
      if (options.credentials === "unavailable")
        throw new Error("no swarm key at ~/.pi-mesh/swarm.key");
      return options.credentials ?? CREDS;
    }),
    localPort: () => 7330,
    sendSkill: vi.fn(async (peer, skill, input) => {
      sent.push({ peerId: peer.id, skill, input });
      if (skill === "mesh.peers") return { peers };
      if (options.onSkill === undefined)
        throw new Error(`unexpected skill call: ${skill}`);
      return options.onSkill({ peerId: peer.id, skill, input });
    }),
  };
  return { deps, sent };
}

describe("mesh handoff validation", () => {
  it("handoff without a target peer refuses and names the reason; nothing is sent", async () => {
    const { deps, sent } = makeDeps();
    const result = await executeMeshAction(
      { action: "handoff", task: "do x", project: "/tmp/proj" },
      deps,
    );
    expect(result.details.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/peer/);
    expect(sent).toHaveLength(0);
  });

  it("handoff without a task refuses before any request", async () => {
    const { deps, sent } = makeDeps();
    const result = await executeMeshAction(
      { action: "handoff", peer: REMOTE_B.id, project: "/tmp/proj" },
      deps,
    );
    expect(result.details.ok).toBe(false);
    expect(result.content[0]!.text).toMatch(/task/);
    expect(sent).toHaveLength(0);
  });

  it("steer without a message refuses before any request", async () => {
    const { deps, sent } = makeDeps();
    const result = await executeMeshAction(
      { action: "steer", peer: REMOTE_B.id, job: "job-1" },
      deps,
    );
    expect(result.details.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("mesh peer refusals are results, not exceptions", () => {
  it("a peer's -32102 refusal surfaces as a stated refusal carrying that code, not a throw and not a success", async () => {
    const { deps, sent } = makeDeps({
      onSkill: () => {
        throw refusalError(-32102, "execution is disabled on this machine");
      },
    });
    let result;
    try {
      result = await executeMeshAction(
        {
          action: "handoff",
          peer: REMOTE_B.id,
          task: "do x",
          project: "/tmp/proj",
        },
        deps,
      );
    } catch {
      expect.unreachable("a peer refusal must not throw");
    }
    expect(result.details.ok).toBe(false);
    expect(result.details).toMatchObject({ refused: true, code: -32102 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("-32102");
    expect(result.content[0]!.text).toMatch(/disabled/);
    // The handoff was attempted (peers lookup, then the refused handoff) and
    // the refusal names the peer that issued it.
    expect(sent.map((call) => call.skill)).toEqual([
      "mesh.peers",
      "mesh.handoff",
    ]);
    expect(result.details.peer).toBe(REMOTE_B.id);
  });

  it("a -32102 steer refusal carries the code with the job handle", async () => {
    const { deps } = makeDeps({
      onSkill: () => {
        throw refusalError(-32102, "execution is disabled on this machine");
      },
    });
    const result = await executeMeshAction(
      {
        action: "steer",
        peer: REMOTE_B.id,
        job: "job-1",
        message: "keep going",
      },
      deps,
    );
    expect(result.details).toMatchObject({
      ok: false,
      refused: true,
      code: -32102,
      jobId: "job-1",
    });
    expect(result.content[0]!.text).toContain("-32102");
  });
});

describe("mesh without a credential", () => {
  const cases: { name: string; params: MeshActionParams }[] = [
    { name: "peers", params: { action: "peers" } },
    {
      name: "handoff",
      params: {
        action: "handoff",
        peer: REMOTE_B.id,
        task: "do x",
        project: "/tmp/proj",
      },
    },
    {
      name: "follow",
      params: { action: "follow", peer: REMOTE_B.id, session: "session-1" },
    },
    {
      name: "steer",
      params: {
        action: "steer",
        peer: REMOTE_B.id,
        job: "job-1",
        message: "keep going",
      },
    },
    {
      name: "stop",
      params: { action: "stop", peer: REMOTE_B.id, job: "job-1" },
    },
  ];

  it.each(cases)(
    "refuses every action before any request when no credential can be loaded ($name)",
    async ({ params }) => {
      const { deps, sent } = makeDeps({ credentials: "unavailable" });
      const result = await executeMeshAction(params, deps);
      expect(result.details).toMatchObject({ ok: false, unavailable: true });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/no pi-mesh agent credential/);
      expect(sent).toHaveLength(0);
    },
  );
});

describe("mesh positive controls", () => {
  it("peers lists the fleet the local agent reports", async () => {
    const { deps, sent } = makeDeps();
    const result = await executeMeshAction({ action: "peers" }, deps);
    expect(result.details).toMatchObject({ action: "peers", ok: true });
    expect(result.content[0]!.text).toContain(REMOTE_B.id);
    expect(result.content[0]!.text).toContain(REMOTE_C.id);
    expect(sent.map((call) => call.skill)).toEqual(["mesh.peers"]);
    expect(sent[0]!.peerId).toBe(CREDS.identity.peerId);
  });

  it("handoff returns the task, session and job ids", async () => {
    const { deps, sent } = makeDeps({
      onSkill: () =>
        handoffTask({ taskId: "task-9", sessionId: "sess-9", jobId: "job-9" }),
    });
    const result = await executeMeshAction(
      {
        action: "handoff",
        peer: REMOTE_B.id,
        task: "do x",
        project: "/tmp/proj",
      },
      deps,
    );
    expect(result.details).toMatchObject({
      ok: true,
      peer: REMOTE_B.id,
      taskId: "task-9",
      sessionId: "sess-9",
      jobId: "job-9",
    });
    expect(result.content[0]!.text).toContain("task-9");
    const handoff = sent.find((call) => call.skill === "mesh.handoff")!;
    expect(handoff.peerId).toBe(REMOTE_B.id);
    expect(handoff.input).toMatchObject({ task: "do x", project: "/tmp/proj" });
  });

  it("a handoff addressed at loopback says the work started on this machine, not remotely", async () => {
    const loopback = {
      id: "peer-loop",
      name: "loop",
      host: "127.0.0.1",
      port: 7330,
    };
    const { deps } = makeDeps({
      peers: [loopback],
      onSkill: () =>
        handoffTask({ taskId: "task-1", sessionId: "sess-1", jobId: "job-1" }),
    });
    const result = await executeMeshAction(
      {
        action: "handoff",
        peer: loopback.id,
        task: "do x",
        project: "/tmp/proj",
      },
      deps,
    );
    expect(result.details).toMatchObject({ ok: true, loopback: true });
    expect(result.content[0]!.text).toMatch(/this machine, not.*remote/);
    expect(result.content[0]!.text).not.toMatch(/remote peer$/);
  });

  it("follow reports how many entries the peer returned", async () => {
    const { deps } = makeDeps({
      onSkill: (call) => {
        expect(call.skill).toBe("session.read");
        return {
          entries: [{ entryId: "e1" }, { entryId: "e2" }, { entryId: "e3" }],
        };
      },
    });
    const result = await executeMeshAction(
      { action: "follow", peer: REMOTE_B.id, session: "sess-9" },
      deps,
    );
    expect(result.details).toMatchObject({
      ok: true,
      sessionId: "sess-9",
      entries: 3,
    });
    expect(result.content[0]!.text).toMatch(/3 entries/);
  });

  it("stop reports the state the peer returned", async () => {
    const { deps } = makeDeps({
      onSkill: (call) => {
        expect(call.skill).toBe("process.stop");
        return { job_id: "job-9", state: "stopping", pid: 123 };
      },
    });
    const result = await executeMeshAction(
      { action: "stop", peer: REMOTE_B.id, job: "job-9" },
      deps,
    );
    expect(result.details).toMatchObject({
      ok: true,
      jobId: "job-9",
      state: "stopping",
    });
  });
});

describe("mesh adds no surface", () => {
  it("serves no route and opens no listener", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const packageDir = dirname(here);
    const sources = readdirSync(packageDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({
        name,
        text: readFileSync(join(packageDir, name), "utf8"),
      }));
    expect(sources.map((source) => source.name)).toContain("mesh.ts");
    // Any HTTP server factory or bound port here would be a new route or
    // listener, which ADR 0021 forbids the tool. Add one and this fails by name.
    const forbidden = [
      "createServer",
      "createAgentServer",
      "node:http",
      "node:net",
      ".listen(",
    ];
    for (const source of sources) {
      for (const marker of forbidden) {
        expect(
          source.text,
          `${source.name} must not contain ${marker}`,
        ).not.toContain(marker);
      }
    }
  });
});
