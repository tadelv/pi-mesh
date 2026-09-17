// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile } from "node:fs/promises";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  retries?: number;
  delayMs?: number;
  backoff?: number;
  signal?: AbortSignal;
  onError?: (err: unknown, attempt: number) => void;
}

/** NaN/Infinity would make the retry bound unsatisfiable and loop forever. */
function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

export async function retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const retries = Math.max(0, Math.floor(finiteOr(options?.retries, 3)));
  const delayMs = Math.max(0, finiteOr(options?.delayMs, 100));
  const backoff = Math.max(0, finiteOr(options?.backoff, 2));

  let attempt = 1;
  while (true) {
    if (options?.signal?.aborted) {
      throw options.signal.reason;
    }

    try {
      return await fn();
    } catch (error) {
      options?.onError?.(error, attempt);
      if (attempt > retries || options?.signal?.aborted) {
        if (options?.signal?.aborted) {
          throw options.signal.reason;
        }
        throw error;
      }
      await sleep(delayMs * backoff ** (attempt - 1));
      attempt += 1;
    }
  }
}

/** Reads UTF-8 JSON, preserving filesystem errors and throwing SyntaxError for invalid JSON. */
export async function readJsonFile<T = unknown>(path: string): Promise<T> {
  const contents = await readFile(path, "utf8");
  return JSON.parse(contents) as T;
}
