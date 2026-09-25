// SPDX-License-Identifier: GPL-3.0-or-later
//
// Dashboard design loop: no mDNS, no pairing, no real Pi, no pi-mesh-agent CLI.
//
//   pnpm -r build
//   pnpm dashboard:dev
//
// Two kinds of thing run here:
//   - real HttpAgentServers from @pi-mesh/agent, over fixture session files and
//     a fake job handle, so capabilities, sessions, jobs and reads travel the
//     real wire and the controls are genuinely enabled;
//   - one paired-but-unreachable agent, for the capability-unknown states.
// The markup is read from src/dashboard.html on every request, so editing the
// page is a browser refresh with no rebuild.

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtures, models } from "./dashboard-fixtures.mjs";

async function load(specifier, label) {
  try {
    return await import(specifier);
  } catch (error) {
    process.stderr.write(
      `Could not load ${label}. Build the workspace first:\n  pnpm -r build\n\n${error}\n`,
    );
    process.exit(1);
  }
}

const { ControlStore, createControlServer } = await load(
  "../packages/control-plane/dist/index.js",
  "@pi-mesh/control-plane",
);
const { JobManager, createAgentServer, parseSpawnPolicy, sessionDirectory } =
  await load("../packages/agent/dist/index.js", "@pi-mesh/agent");

const token = "dev";
const { controlId, credential, swarmKey, agents } = createFixtures();
const htmlPath = new URL(
  "../packages/control-plane/src/dashboard.html",
  import.meta.url,
);

// --- fixture working directory ------------------------------------------
const workDir = mkdtempSync(join(tmpdir(), "pi-mesh-dashboard-dev-"));
const sessionsRoot = join(workDir, "sessions");
mkdirSync(sessionsRoot, { recursive: true });

// One root per agent. A shared root would make every agent list every other
// agent's sessions, which is not a state a real machine can be in.
const agentRoot = (peerId) => join(sessionsRoot, peerId);

function writeSession(session, root) {
  const directory = sessionDirectory(session.project, root);
  mkdirSync(directory, { recursive: true });
  const header = {
    type: "session",
    version: 3,
    id: session.id,
    timestamp: session.started_at,
    cwd: session.project,
  };
  const lines = [header, ...session.entries].map((line) =>
    JSON.stringify(line),
  );
  writeFileSync(
    join(directory, `${session.id}.jsonl`),
    `${lines.join("\n")}\n`,
  );
}

for (const agent of agents)
  for (const session of agent.sessions)
    writeSession(session, agentRoot(agent.peerId));

// --- agents -------------------------------------------------------------
const store = new ControlStore(":memory:");
store.setMeta("control_id", controlId);
store.setMeta("dashboard_token", token);
store.controlName("Dashboard Dev (fixtures)");

const agentServers = [];
for (const fixture of agents) {
  if (fixture.unreachable) {
    store.upsertAgent({
      peer_id: fixture.peerId,
      name: fixture.name,
      host: "127.0.0.1",
      port: 1,
      credential,
      paired_at: "dev",
    });
    continue;
  }
  let spawned = 0;
  const jobs = new JobManager({
    spawnJob: (_spec, report) => {
      spawned += 1;
      // The pre-seeded job links to a fixture session so the prompt path
      // engages; a job started from the dashboard gets a fresh session, like
      // real Pi, rather than a second job on the same one.
      const sessionId =
        spawned === 1 && fixture.job ? fixture.job.sessionId : randomUUID();
      // A handle that never exits on its own.
      queueMicrotask(() => report.session(sessionId));
      return {
        pid: fixture.job?.pid ?? 4242,
        argv: [],
        stdioClosed: false,
        ready: Promise.resolve(),
        command: async (command) => {
          // Session model control reads the catalog through the job when a
          // job_id is given, which the dashboard always does. Answering here is
          // what makes the model picker and set_model work without a real Pi.
          if (command.type === "get_available_models")
            return { success: true, data: { models } };
          if (command.type === "set_model")
            return {
              success: true,
              data: { provider: command.provider, modelId: command.modelId },
            };
          return { success: true };
        },
        close: async () => report.exited({ code: 0, signal: null }),
      };
    },
  });
  // The spawner above is the only path start() takes; it cannot block here.
  if (fixture.job)
    jobs.start({
      peerId: controlId,
      project: fixture.job.project,
      cwd: fixture.job.cwd,
      name: fixture.job.name,
    });
  const server = createAgentServer({
    jobs,
    sessionsRoot: agentRoot(fixture.peerId),
    host: "127.0.0.1",
    port: 0,
    swarmKey,
    identity: { peerId: fixture.peerId, name: fixture.name },
    controlCredentials: [{ controlId, credential, pairedAt: "dev" }],
    spawnPolicy: parseSpawnPolicy("*", ""),
  });
  const address = await server.start();
  agentServers.push({ server, jobs });
  store.upsertAgent({
    peer_id: fixture.peerId,
    name: fixture.name,
    host: "127.0.0.1",
    port: address.port,
    credential,
    paired_at: "dev",
  });
}

const control = createControlServer({
  store,
  host: "127.0.0.1",
  port: Number(process.env.PI_MESH_PORT ?? 7331),
  dashboardHtml: () => readFileSync(htmlPath, "utf8"),
});
const address = await control.start();

// Sync once so the page is populated on first load rather than after a click.
const origin = `http://127.0.0.1:${address.port}`;
try {
  const sync = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: { "X-Pi-Mesh-Ui": token },
  });
  if (!sync.ok)
    process.stderr.write(`Initial sync failed: HTTP ${sync.status}\n`);
} catch (error) {
  process.stderr.write(`Initial sync failed: ${String(error)}\n`);
}

const online = agents
  .filter((agent) => !agent.unreachable)
  .map((agent) => agent.name)
  .join(", ");
process.stderr.write(`Dashboard (fixtures):  ${origin}\n`);
process.stderr.write(`Dashboard token:       ${token}\n`);
process.stderr.write(
  `Agents:                ${online} + offline-laptop (unreachable)\n`,
);
process.stderr.write(
  "Editing:               packages/control-plane/src/dashboard.html (refresh, no rebuild)\n",
);
process.stderr.write("Press Ctrl-C to stop.\n");

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void (async () => {
    await control.stop();
    for (const { server, jobs } of agentServers) {
      await server.stop();
      await jobs.shutdown();
    }
    store.close();
    rmSync(workDir, { recursive: true, force: true });
    process.exit(0);
  })();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
