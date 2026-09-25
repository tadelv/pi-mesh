// SPDX-License-Identifier: GPL-3.0-or-later
//
// Dashboard design loop: no mDNS, no pairing, no pi-mesh-agent.
//
//   pnpm -r build      # once: builds the store + server this imports
//   pnpm dashboard:dev
//
// Markup is read from src/dashboard.html on every request, so editing the page
// is a browser refresh with no rebuild. Data comes from
// scripts/dashboard-fixtures.mjs through an in-memory store. No agent is
// present, so transcripts render from the cache (the dashboard's normal
// "could not be verified" path) and execution controls stay disabled: this
// serves the reading surface, not the control path.

import { readFileSync } from "node:fs";
import { agents, events, jobs, sessions } from "./dashboard-fixtures.mjs";

let controlPlane;
try {
  controlPlane = await import("../packages/control-plane/dist/index.js");
} catch (error) {
  process.stderr.write(
    `Could not load @pi-mesh/control-plane. Build it first:\n  pnpm -r build\n\n${error}\n`,
  );
  process.exit(1);
}
const { ControlStore, createControlServer } = controlPlane;

const htmlPath = new URL(
  "../packages/control-plane/src/dashboard.html",
  import.meta.url,
);
const token = "dev";

const store = new ControlStore(":memory:");
store.setMeta("dashboard_token", token);
store.controlName("Dashboard Dev (fixtures)");
for (const agent of agents) store.upsertAgent(agent);
for (const group of sessions)
  store.upsertSessions(group.agent_id, group.sessions, group.synced_at);
for (const job of jobs) store.upsertJob(job);
for (const group of events)
  store.upsertEvents(group.agent_id, group.session_id, group.events);

const server = createControlServer({
  store,
  host: "127.0.0.1",
  port: Number(process.env.PI_MESH_PORT ?? 7331),
  dashboardHtml: () => readFileSync(htmlPath, "utf8"),
});

const { port } = await server.start();
process.stderr.write(`Dashboard (fixtures):  http://127.0.0.1:${port}\n`);
process.stderr.write(`Dashboard token:       ${token}\n`);
process.stderr.write(
  "Editing:               packages/control-plane/src/dashboard.html (refresh, no rebuild)\n",
);
process.stderr.write("Press Ctrl-C to stop.\n");

const stop = () => {
  void server.stop().then(
    () => {
      store.close();
      process.exit(0);
    },
    () => process.exit(1),
  );
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
