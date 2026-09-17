// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { JsonlDecoder, decodeJsonl } from "../src/jsonl.js";

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

  it("keeps U+2028 inside one JSON record", () => {
    const record = JSON.stringify({ text: "left\u2028right" });
    const input = `${record}\n`;

    expect(decodeJsonl(input)).toEqual([record]);

    // Pi's format is LF-only. A splitter that also treats the Unicode line
    // separators U+2028/U+2029 as boundaries - which naive line readers do, and
    // which node:readline has done on some Node versions - breaks this record
    // in two. Spelled out here rather than by calling readline, because
    // readline's behaviour varies BY NODE VERSION: CI on Node 22 kept the
    // record whole, so a test asserting readline splits it failed on the very
    // version where readline is correct. The decoder's own behaviour is the
    // thing under test; the failure mode is illustrative.
    const unicodeAwareSplit = input
      .split(/\r?\n|\u2028|\u2029/)
      .filter(Boolean);
    expect(unicodeAwareSplit).toHaveLength(2);
    expect(unicodeAwareSplit).not.toEqual([record]);
  });
});
