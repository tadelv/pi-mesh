// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import {
  TYPESAFE_DEFAULT_MODEL,
  TYPESAFE_ENDPOINT,
  systemOne,
  type JevQuestion,
} from "../src/jev.js";

const questions: Record<string, JevQuestion> = {
  action: { type: "choice", instructions: "choose", criteria: { yes: "yes" } },
};
const validBody = {
  answers: {
    action: {
      type: "choice",
      choice: "yes",
      probabilities: { yes: 0.9 },
      confidence: 0.9,
    },
  },
};

describe("TypeSafe System One client", () => {
  it("forwards the state and questions with bearer auth and parses answers", async () => {
    const state = { text: "show machines" };
    const fetchStub = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(url).toBe(TYPESAFE_ENDPOINT);
        expect((init as RequestInit).headers).toMatchObject({
          Authorization: "Bearer secret-key",
        });
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({
          state,
          model: TYPESAFE_DEFAULT_MODEL,
          questions,
        });
        return new Response(JSON.stringify(validBody), { status: 200 });
      },
    );
    const result = await systemOne(state, questions, {
      apiKey: "secret-key",
      fetch: fetchStub as typeof fetch,
    });
    expect(fetchStub).toHaveBeenCalledOnce();
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe(TYPESAFE_ENDPOINT);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer secret-key",
    });
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({ state, model: TYPESAFE_DEFAULT_MODEL, questions });
    expect(result).toEqual(validBody.answers);
  });

  it.each([
    ["HTTP 500", async () => new Response("offline", { status: 500 })],
    ["missing answers", async () => new Response("{}", { status: 200 })],
    [
      "rejecting fetch",
      async () => {
        throw new Error("offline");
      },
    ],
  ])("returns undefined for %s", async (_label, response) => {
    const result = await systemOne({}, questions, {
      apiKey: "secret",
      fetch: (async () => response()) as typeof fetch,
    });
    expect(result).toBeUndefined();
  });
});
