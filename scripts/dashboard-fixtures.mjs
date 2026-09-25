// SPDX-License-Identifier: GPL-3.0-or-later
//
// Fixtures for scripts/dashboard-dev.mjs. Shapes match the control-plane store,
// not the wire: sessions are SessionSummary, events are protocol Events
// (entryId/data), which upsertEvents serialises to the CachedEvent the
// dashboard reads back. Between them they exercise every primitive in
// DESIGN.md: session rows, user/assistant/tool/thinking entries, a failed tool
// result, session_info, model_change, an image part, and a job per agent.

const mac = "agent-mac-studio";
const pi = "agent-pi-5";
const credential = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

export const agents = [
  {
    peer_id: mac,
    name: "Mac Studio",
    host: "127.0.0.1",
    port: 7330,
    credential,
    paired_at: "2025-09-20T09:04:00.000Z",
  },
  {
    peer_id: pi,
    name: "raspberry-pi-5",
    host: "192.168.1.42",
    port: 7330,
    credential,
    paired_at: "2025-09-21T11:32:00.000Z",
  },
];

/** Session ids, referenced by jobs and events below. */
export const sessionIds = {
  dashboard: "9c1e7d4a-2b3f-4c8e-9a10-5d6e7f8a9b0c",
  flake: "3b7d9e11-6a24-4f0b-8c3d-2e5f109a7b44",
  nightly: "c4a1f0e2-88b7-4d19-a6f3-77e2c0b4d9a1",
};

export const sessions = [
  {
    agent_id: mac,
    synced_at: "2025-09-25T15:40:00.000Z",
    sessions: [
      {
        id: sessionIds.dashboard,
        project: "/Users/vid/development/repos/pi-mesh",
        name: "Dashboard design pass",
        started_at: "2025-09-25T13:02:00.000Z",
        updated_at: "2025-09-25T15:38:00.000Z",
      },
      {
        id: sessionIds.flake,
        project: "/Users/vid/development/repos/reaprime",
        name: "MMR transport flake",
        started_at: "2025-09-24T08:15:00.000Z",
        updated_at: "2025-09-24T09:51:00.000Z",
      },
    ],
  },
  {
    agent_id: pi,
    synced_at: "2025-09-25T15:40:00.000Z",
    sessions: [
      {
        id: sessionIds.nightly,
        project: "/srv/pi/streamline-bridge",
        name: "Nightly CI triage",
        started_at: "2025-09-25T02:00:00.000Z",
        updated_at: "2025-09-25T02:12:00.000Z",
      },
    ],
  },
];

export const jobs = [
  {
    agent_id: mac,
    job_id: "job-9f31c2",
    session_id: sessionIds.dashboard,
    pid: 4721,
    project: "/Users/vid/development/repos/pi-mesh",
    created_at: "2025-09-25T13:02:00.000Z",
    state: "running",
  },
  {
    agent_id: pi,
    job_id: "job-4a02be",
    session_id: sessionIds.nightly,
    pid: null,
    project: "/srv/pi/streamline-bridge",
    created_at: "2025-09-25T02:00:00.000Z",
    state: "stopped",
  },
];

const t = (minute) =>
  `2025-09-25T15:${String(minute).padStart(2, "0")}:00.000Z`;

export const events = [
  {
    agent_id: mac,
    session_id: sessionIds.dashboard,
    events: [
      {
        entryId: "e-1",
        type: "session_info",
        timestamp: t(2),
        data: {
          name: "Dashboard design pass",
          cwd: "/Users/vid/development/repos/pi-mesh",
        },
      },
      {
        entryId: "e-2",
        type: "message",
        timestamp: t(3),
        data: {
          message: {
            role: "user",
            content:
              "The dashboard works but it is not a design anyone would use. Look at the session list and the transcript and tell me what is wrong.",
          },
        },
      },
      {
        entryId: "e-3",
        type: "message",
        timestamp: t(4),
        data: {
          message: {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking:
                  "Density is fine; hierarchy is not. Every sidebar row is name+project in the same weight, and every transcript entry wears an identical grey meta line, so nothing tells you where you are.",
              },
              {
                type: "text",
                text: "Two things, both about hierarchy. The sidebar renders name and project as one undifferentiated line, and every transcript entry has the same meta treatment — so the eye has nothing to anchor on. Let me read the renderer before changing it.",
              },
            ],
          },
        },
      },
      {
        entryId: "e-4",
        type: "tool_call",
        timestamp: t(5),
        data: {
          name: "read",
          arguments: {
            path: "packages/control-plane/src/dashboard.ts",
            offset: 340,
            limit: 60,
          },
        },
      },
      {
        entryId: "e-5",
        type: "message",
        timestamp: t(6),
        data: {
          message: {
            role: "toolResult",
            name: "read",
            content:
              "function renderEntry(event, parent) {\n  const data = parseEntry(event);\n  const type = String(data.type || event.type || 'entry');\n  ...",
            isError: false,
          },
        },
      },
      {
        entryId: "e-6",
        type: "model_change",
        timestamp: t(7),
        data: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      },
      {
        entryId: "e-7",
        type: "message",
        timestamp: t(8),
        data: {
          message: {
            role: "toolResult",
            name: "lint",
            content:
              "packages/control-plane/src/dashboard.html\n  1:1  error  Missing SPDX header",
            isError: true,
          },
        },
      },
      {
        entryId: "e-8",
        type: "message",
        timestamp: t(9),
        data: {
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "The lint failure is a missing licence header, not a design issue. Fixed; the markup file carries SPDX like the rest of the sources.",
              },
              { type: "image", mimeType: "image/png" },
            ],
          },
        },
      },
      {
        entryId: "e-9",
        type: "message",
        timestamp: t(10),
        data: { message: { role: "user", content: "Ship it." } },
      },
    ],
  },
  {
    agent_id: pi,
    session_id: sessionIds.nightly,
    events: [
      {
        entryId: "n-1",
        type: "session_info",
        timestamp: t(5),
        data: { name: "Nightly CI triage", cwd: "/srv/pi/streamline-bridge" },
      },
      {
        entryId: "n-2",
        type: "message",
        timestamp: t(6),
        data: {
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
      },
    ],
  },
];
