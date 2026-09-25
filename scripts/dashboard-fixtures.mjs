// SPDX-License-Identifier: GPL-3.0-or-later
//
// Fixtures for scripts/dashboard-dev.mjs. These are Pi session-file entries, not
// protocol Events: dashboard-dev writes each session to a JSONL file and points
// a real HttpAgentServer at it, so the list, the read, the capability card and
// the jobs mirror all travel the real wire. That is deliberate - a stub that
// answers any request shape would hide a wire-format bug forever (AGENTS.md).
//
// Entry payloads sit at the top level of a line (Pi's own shape); the agent
// wraps each into an Event on read. Timestamps are relative to now so the
// dashboard's "N minutes ago" column reads sensibly.

export const controlId = "33333333-3333-4333-8333-333333333333";
export const credential = Buffer.alloc(32, 7).toString("base64");
export const swarmKey = Buffer.from("pi-mesh dashboard dev fixture swarm key");

// What a mock agent's running job reports for get_available_models. session.models
// and session.set_model both read the catalog through the job when a job_id is
// given (which the dashboard always does), so this single list is what the
// picker shows and what set_model validates against.
export const models = [
  { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5", provider: "anthropic", name: "Claude Haiku 4.5" },
  { id: "gpt-5.1-codex", provider: "openai", name: "GPT-5.1 Codex" },
];

const DASHBOARD = "9c1e7d4a-2b3f-4c8e-9a10-5d6e7f8a9b0c";
const FLAKE = "3b7d9e11-6a24-4f0b-8c3d-2e5f109a7b44";
const NIGHTLY = "c4a1f0e2-88b7-4d19-a6f3-77e2c0b4d9a1";

export function createFixtures(now = Date.now()) {
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

  return {
    controlId,
    credential,
    swarmKey,
    agents: [
      {
        peerId: "agent-mac-studio",
        name: "Mac Studio",
        // One running job, linked to the dashboard session, so the jobs mirror
        // is populated and the selected session is prompt-eligible.
        job: {
          project: "/Users/vid/development/repos/pi-mesh",
          cwd: "/Users/vid/development/repos/pi-mesh",
          name: "Dashboard design pass",
          pid: 4721,
          sessionId: DASHBOARD,
        },
        sessions: [
          {
            id: DASHBOARD,
            project: "/Users/vid/development/repos/pi-mesh",
            name: "Dashboard design pass",
            started_at: at(150),
            entries: [
              {
                type: "session_info",
                id: "d-1",
                parentId: null,
                timestamp: at(150),
                name: "Dashboard design pass",
                cwd: "/Users/vid/development/repos/pi-mesh",
              },
              {
                type: "message",
                id: "d-2",
                parentId: "d-1",
                timestamp: at(148),
                message: {
                  role: "user",
                  content:
                    "The dashboard works but it is not a design anyone would use. Look at the session list and the transcript and tell me what is wrong.",
                },
              },
              {
                type: "message",
                id: "d-3",
                parentId: "d-2",
                timestamp: at(146),
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "thinking",
                      thinking:
                        "Density is fine; hierarchy is not. Every sidebar row is name+project at the same weight, and every transcript entry wears an identical grey meta line, so nothing tells the eye where it is.",
                    },
                    {
                      type: "text",
                      text: "Two things, both about hierarchy. The sidebar renders name and project as one undifferentiated line, and every transcript entry has the same meta treatment - so the eye has nothing to anchor on. Let me read the renderer before changing it.",
                    },
                  ],
                },
              },
              {
                type: "message",
                id: "d-4",
                parentId: "d-3",
                timestamp: at(145),
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: "Reading the entry renderer first.",
                    },
                    {
                      type: "toolCall",
                      name: "read",
                      arguments: {
                        path: "packages/control-plane/src/dashboard.html",
                        offset: 340,
                        limit: 60,
                      },
                    },
                  ],
                },
              },
              {
                type: "message",
                id: "d-5",
                parentId: "d-4",
                timestamp: at(144),
                message: {
                  role: "toolResult",
                  name: "read",
                  isError: false,
                  content:
                    "function renderEntry(event, parent) {\n  const data = parseEntry(event);\n  const type = String(data.type || event.type || 'entry');\n  ...",
                },
              },
              {
                type: "model_change",
                id: "d-6",
                parentId: "d-5",
                timestamp: at(143),
                provider: "anthropic",
                modelId: "claude-sonnet-4-5",
              },
              {
                type: "message",
                id: "d-7",
                parentId: "d-6",
                timestamp: at(142),
                message: {
                  role: "toolResult",
                  name: "lint",
                  isError: true,
                  content:
                    "packages/control-plane/src/dashboard.html\n  1:1  error  Missing SPDX licence header",
                },
              },
              {
                type: "message",
                id: "d-8",
                parentId: "d-7",
                timestamp: at(3),
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: "The lint failure is a missing licence header, not a design issue. Fixed; the markup carries SPDX like the rest of the sources.",
                    },
                    { type: "image", mimeType: "image/png" },
                  ],
                },
              },
              {
                type: "message",
                id: "d-9",
                parentId: "d-8",
                timestamp: at(2),
                message: { role: "user", content: "Ship it." },
              },
            ],
          },
          {
            id: FLAKE,
            project: "/Users/vid/development/repos/reaprime",
            name: "MMR transport flake",
            started_at: at(1500),
            entries: [
              {
                type: "session_info",
                id: "f-1",
                parentId: null,
                timestamp: at(1500),
                name: "MMR transport flake",
                cwd: "/Users/vid/development/repos/reaprime",
              },
              {
                type: "message",
                id: "f-2",
                parentId: "f-1",
                timestamp: at(1490),
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: "Reproduced once in 400 runs. Parking until the flake is worth a bisect.",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      {
        peerId: "agent-pi-5",
        name: "raspberry-pi-5",
        // No job: the agent is reachable and its sessions list, but its jobs
        // mirror is empty, so the selected session shows the "no running job"
        // prompt state rather than an eligible one.
        sessions: [
          {
            id: NIGHTLY,
            project: "/srv/pi/streamline-bridge",
            name: "Nightly CI triage",
            started_at: at(400),
            entries: [
              {
                type: "session_info",
                id: "n-1",
                parentId: null,
                timestamp: at(400),
                name: "Nightly CI triage",
                cwd: "/srv/pi/streamline-bridge",
              },
              {
                type: "message",
                id: "n-2",
                parentId: "n-1",
                timestamp: at(390),
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: "Three failing jobs overnight; two are the known flake. Triaging the third.",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      {
        // Paired in the store, no server behind it: the capability-unknown
        // state, which is what every control disabled for want of evidence
        // looks like.
        peerId: "agent-offline-laptop",
        name: "offline-laptop",
        unreachable: true,
        sessions: [],
      },
    ],
  };
}
