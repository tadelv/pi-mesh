// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import {
  MAX_INTENT_SESSIONS,
  routeIntent,
  type IntentContext,
} from "../src/intent.js";
import type { JevQuestion } from "../src/jev.js";

const context: IntentContext = {
  devices: [{ id: "real-agent", name: "Work Mac" }],
  sessions: [
    {
      agent_id: "real-agent",
      session_id: "real-session",
      name: "Review",
      project: "/repo",
    },
  ],
};
function fetchAnswers(
  answers: Record<string, unknown> | undefined,
): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, JevQuestion>;
    };
    if (answers === undefined) return new Response("{}", { status: 200 });
    for (const [key, question] of Object.entries(body.questions)) {
      const answer = answers[key];
      if (answer === undefined)
        throw new Error(`Missing fixture answer ${key}`);
      if ((answer as { type: string }).type !== question.type)
        throw new Error(`Wrong fixture answer type ${key}`);
    }
    return new Response(JSON.stringify({ answers }), { status: 200 });
  }) as typeof fetch;
}
const choice = (
  choice: string,
  confidence: number,
  probabilities = { [choice]: confidence },
) => ({ type: "choice", choice, confidence, probabilities });
const baseAnswers = {
  action: choice("show_sessions", 0.9),
  names_device: { type: "noul", noul: 0.9 },
  device: choice("real-agent", 0.8),
  names_session: { type: "noul", noul: 0.9 },
  session: choice("0", 0.8),
};

describe("intent routing", () => {
  it("uses a named device's real id for show_sessions", async () => {
    const result = await routeIntent("show sessions on Work Mac", context, {
      apiKey: "key",
      fetch: fetchAnswers(baseAnswers),
    });
    expect(result).toEqual({
      action: "show_sessions",
      confidence: 0.9,
      arguments: { agent_id: "real-agent" },
    });
  });

  it("returns none when action confidence is below the floor", async () => {
    const answers = { ...baseAnswers, action: choice("show_sessions", 0.59) };
    await expect(
      routeIntent("show sessions", context, {
        apiKey: "key",
        fetch: fetchAnswers(answers),
      }),
    ).resolves.toEqual({ action: "none", confidence: 0.59, arguments: {} });
  });

  it("maps open_session selection to the real context ids", async () => {
    const answers = { ...baseAnswers, action: choice("open_session", 0.9) };
    await expect(
      routeIntent("open Review", context, {
        apiKey: "key",
        fetch: fetchAnswers(answers),
      }),
    ).resolves.toEqual({
      action: "open_session",
      confidence: 0.9,
      arguments: { agent_id: "real-agent", session_id: "real-session" },
    });
  });

  it("refuses to guess a session below its naming floor", async () => {
    const answers = {
      ...baseAnswers,
      action: choice("open_session", 0.9),
      names_session: { type: "noul", noul: 0.49 },
    };
    await expect(
      routeIntent("open something", context, {
        apiKey: "key",
        fetch: fetchAnswers(answers),
      }),
    ).resolves.toEqual({ action: "none", confidence: 0.9, arguments: {} });
  });

  it("returns none when a device is named but cannot be resolved", async () => {
    const answers = {
      ...baseAnswers,
      action: choice("show_sessions", 0.9),
      // A device is confidently named, but the choice names no known machine.
      device: choice("some-other-id", 0.8),
    };
    // Falling back to an unfiltered list would be a guess at which machine the
    // operator meant, which ADR 0012 forbids.
    await expect(
      routeIntent("show sessions on the other box", context, {
        apiKey: "key",
        fetch: fetchAnswers(answers),
      }),
    ).resolves.toEqual({ action: "none", confidence: 0.9, arguments: {} });
  });

  it("does not read an empty session choice as index zero", async () => {
    const answers = {
      ...baseAnswers,
      action: choice("open_session", 0.9),
      session: choice("", 0.8),
    };
    // Number("") is 0, so a naive parse would open the first session.
    await expect(
      routeIntent("open it", context, {
        apiKey: "key",
        fetch: fetchAnswers(answers),
      }),
    ).resolves.toEqual({ action: "none", confidence: 0.9, arguments: {} });
  });

  it("never sends more Choice options than TypeSafe accepts", async () => {
    // The real fleet had 435 sessions; a Choice with 300 options is HTTP 400
    // from TypeSafe, so the whole route answered 503 until this cap existed.
    const many: IntentContext = {
      devices: [{ id: "real-agent", name: "Work Mac" }],
      sessions: Array.from({ length: 300 }, (_, i) => ({
        agent_id: "real-agent",
        session_id: `s${i}`,
        name: `S${i}`,
        project: "/repo",
      })),
    };
    const captured = new Map<string, JevQuestion>();
    let capturedState: { sessions?: unknown[] } | undefined;
    const answers = {
      ...baseAnswers,
      action: choice("open_session", 0.9),
      session: choice("49", 0.8),
    };
    const fetchStub = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        state: { sessions?: unknown[] };
        questions: Record<string, JevQuestion>;
      };
      capturedState = body.state;
      for (const [key, question] of Object.entries(body.questions))
        captured.set(key, question);
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as typeof fetch;
    const result = await routeIntent("open the newest one", many, {
      apiKey: "key",
      fetch: fetchStub,
    });
    // Asserted outside the stub: an assertion thrown inside it is swallowed by
    // systemOne's catch and could never fail the test.
    const sessionQuestion = captured.get("session");
    expect(sessionQuestion?.type).toBe("choice");
    const criteria =
      sessionQuestion?.type === "choice" ? sessionQuestion.criteria : {};
    expect(Object.keys(criteria)).toHaveLength(MAX_INTENT_SESSIONS);
    expect(Object.keys(criteria).length).toBeLessThanOrEqual(255);
    // The state must be trimmed too: sending all 300 sessions blew TypeSafe's
    // token budget (400 max_tokens_exceeded) even after the option cap.
    expect(capturedState?.sessions).toHaveLength(MAX_INTENT_SESSIONS);
    expect(result).toEqual({
      action: "open_session",
      confidence: 0.9,
      arguments: { agent_id: "real-agent", session_id: "s49" },
    });
  });

  it("refuses a session index beyond the candidate cap", async () => {
    const many: IntentContext = {
      devices: [{ id: "real-agent", name: "Work Mac" }],
      sessions: Array.from({ length: 300 }, (_, i) => ({
        agent_id: "real-agent",
        session_id: `s${i}`,
        name: `S${i}`,
        project: "/repo",
      })),
    };
    const answers = {
      ...baseAnswers,
      action: choice("open_session", 0.9),
      session: choice("299", 0.8),
    };
    await expect(
      routeIntent("open the oldest", many, {
        apiKey: "key",
        fetch: fetchAnswers(answers),
      }),
    ).resolves.toEqual({ action: "none", confidence: 0.9, arguments: {} });
  });

  it("asks the action question with no candidates and propagates unavailable", async () => {
    let captured: string[] = [];
    const fetchStub = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          questions: Record<string, unknown>;
        };
        captured = Object.keys(body.questions);
        return new Response("{}", { status: 200 });
      },
    );
    expect(
      await routeIntent(
        "help",
        { devices: [], sessions: [] },
        {
          apiKey: "key",
          fetch: fetchStub as typeof fetch,
        },
      ),
    ).toBeUndefined();
    expect(fetchStub).toHaveBeenCalledOnce();
    // Asserted after the call: an assertion inside the fetch stub is swallowed
    // by systemOne's catch, so it could never fail the test.
    expect(captured).toEqual(["action"]);
    await expect(
      routeIntent(
        "help",
        { devices: [], sessions: [] },
        {
          apiKey: "key",
          fetch: fetchAnswers(undefined),
        },
      ),
    ).resolves.toBeUndefined();
  });
});
