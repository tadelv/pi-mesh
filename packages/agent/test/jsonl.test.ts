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

    // Pi's format is LF-only, so a decoder that also treats the Unicode line
    // separators U+2028/U+2029 as boundaries would split this record. Any
    // U+2028-splitting decoder fails this assertion, which is the whole point.
    //
    // It deliberately does NOT assert what node:readline does. readline's
    // behaviour is Node-VERSION dependent: it splits on U+2028 on Node 26 and
    // keeps the record whole on Node 22 (verified in CI), so asserting
    // readline's behaviour fails on the very version where readline is
    // correct. The decoder's own behaviour is the requirement; readline is not
    // the contract. A comment describing the trap is not a test.
    expect(decodeJsonl(`${record}\n`)).toEqual([record]);
  });
});
