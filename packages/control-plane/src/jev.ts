// SPDX-License-Identifier: GPL-3.0-or-later

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

export type JevQuestion =
  | { type: "noul"; instructions: unknown; criteria?: Record<string, unknown> }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] };
export type JevAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | { type: "score"; score: number; confidence: number };
export interface JevOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

function validAnswer(
  value: unknown,
  question: JevQuestion,
): value is JevAnswer {
  if (value === null || typeof value !== "object") return false;
  const answer = value as Record<string, unknown>;
  if (answer.type !== question.type) return false;
  if (question.type === "noul")
    return typeof answer.noul === "number" && Number.isFinite(answer.noul);
  if (question.type === "choice") {
    if (
      typeof answer.choice !== "string" ||
      typeof answer.confidence !== "number" ||
      !Number.isFinite(answer.confidence) ||
      answer.probabilities === null ||
      typeof answer.probabilities !== "object" ||
      Array.isArray(answer.probabilities)
    )
      return false;
    return Object.values(answer.probabilities).every(
      (probability) =>
        typeof probability === "number" && Number.isFinite(probability),
    );
  }
  return (
    typeof answer.score === "number" &&
    Number.isFinite(answer.score) &&
    typeof answer.confidence === "number" &&
    Number.isFinite(answer.confidence)
  );
}

export async function systemOne(
  state: unknown,
  questions: Record<string, JevQuestion>,
  options: JevOptions,
): Promise<Record<string, JevAnswer> | undefined> {
  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      TYPESAFE_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state,
          model: options.model ?? TYPESAFE_DEFAULT_MODEL,
          questions,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      },
    );
    if (response.status !== 200) return undefined;
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object") return undefined;
    const answers = (body as { answers?: unknown }).answers;
    if (
      answers === null ||
      typeof answers !== "object" ||
      Array.isArray(answers)
    )
      return undefined;
    const record = answers as Record<string, unknown>;
    if (
      !Object.entries(questions).every(([key, question]) =>
        validAnswer(record[key], question),
      )
    )
      return undefined;
    return record as Record<string, JevAnswer>;
  } catch {
    return undefined;
  }
}
