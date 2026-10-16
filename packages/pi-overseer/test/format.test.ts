// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  baseName,
  fmtAge,
  fmtDuration,
  fmtTokens,
  fmtUsd,
  shortPath,
} from "../format.js";

describe("fmtDuration", () => {
  it("formats seconds, minutes and hours with remainders", () => {
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(59_000)).toBe("59s");
    expect(fmtDuration(60_000)).toBe("1m");
    expect(fmtDuration(61_000)).toBe("1m 1s");
    expect(fmtDuration(3_600_000)).toBe("1h");
    expect(fmtDuration(3_660_000)).toBe("1h 1m");
  });

  it("refuses negative and non-finite input", () => {
    expect(fmtDuration(-5)).toBe("-");
    expect(fmtDuration(NaN)).toBe("-");
  });
});

describe("fmtAge", () => {
  it("reports the elapsed time with an ago suffix", () => {
    expect(fmtAge(1_000, 61_000)).toBe("1m ago");
  });

  it("marks a missing timestamp as unknown", () => {
    expect(fmtAge(undefined)).toBe("?");
  });
});

describe("fmtUsd", () => {
  it("uses milli-dollar precision below one dollar", () => {
    expect(fmtUsd(0.5)).toBe("$0.500");
    expect(fmtUsd(5)).toBe("$5.00");
  });

  it("treats missing, zero and negative cost as zero", () => {
    expect(fmtUsd(undefined)).toBe("$0");
    expect(fmtUsd(0)).toBe("$0");
    expect(fmtUsd(-3)).toBe("$0");
  });
});

describe("fmtTokens", () => {
  it("compacts thousands and millions with one decimal", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1_500)).toBe("1.5k");
    expect(fmtTokens(2_000_000)).toBe("2.0M");
  });

  it("treats missing, zero and negative counts as zero", () => {
    expect(fmtTokens(undefined)).toBe("0");
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(-7)).toBe("0");
  });
});

describe("shortPath", () => {
  it("folds the home directory to a tilde", () => {
    expect(shortPath("/home/u/proj", "/home/u")).toBe("~/proj");
  });

  it("leaves paths outside home and missing paths alone", () => {
    expect(shortPath("/other/x", "/home/u")).toBe("/other/x");
    expect(shortPath(undefined)).toBe("?");
  });
});

describe("baseName", () => {
  it("returns the last path segment", () => {
    expect(baseName("/a/b/c")).toBe("c");
  });

  it("marks a missing path as unknown", () => {
    expect(baseName(undefined)).toBe("?");
  });
});
