// SPDX-License-Identifier: GPL-3.0-or-later

import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonlDecoder, decodeJsonl } from "../src/jsonl.js";

async function readlineRecords(input: string): Promise<string[]> {
  const records: string[] = [];
  const lines = createInterface({ input: Readable.from([input]) });
  for await (const line of lines) records.push(line);
  return records;
}

describe("JSONL decoder", () => {
  it("splits records incrementally and strips CR from CRLF", () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push('{"one":1}\r\n{"two":"par')).toEqual(['{"one":1}']);
    expect(decoder.push('t"}\r\n{"three":3}')).toEqual(['{"two":"part"}']);
    expect(decoder.pending).toBe('{"three":3}');
    expect(decoder.finish()).toEqual([]);
  });

  it("does not emit an unterminated record", () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push('{"partial":true}')).toEqual([]);
    expect(decoder.push("\n")).toEqual(['{"partial":true}']);
  });

  it("keeps U+2028 inside one JSON record while readline incorrectly splits it", async () => {
    const input = `${JSON.stringify({ text: "left\u2028right" })}\n`;
    expect(decodeJsonl(input)).toEqual([
      JSON.stringify({ text: "left\u2028right" }),
    ]);

    // Pi's session format requires LF-only splitting. Node readline also
    // treats U+2028 as a line boundary, so this comparison demonstrates why it
    // cannot be used as the protocol decoder.
    const readlineResult = await readlineRecords(input);
    expect(readlineResult).not.toEqual([
      JSON.stringify({ text: "left\u2028right" }),
    ]);
    expect(readlineResult).toHaveLength(2);
  });
});
