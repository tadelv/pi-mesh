// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Package config -> module rules config: defaults line up, overrides pass
 * through under the module's names, and malformed values fall back to the
 * module defaults instead of poisoning detection.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_RULES as MODULE_DEFAULT_RULES } from "@pi-mesh/runs";
import {
  DEFAULT_RULES,
  toModuleConfig,
  type RulesConfig,
} from "../rules.js";

describe("toModuleConfig", () => {
  it("maps the package defaults onto the module defaults", () => {
    expect(toModuleConfig(DEFAULT_RULES)).toEqual(MODULE_DEFAULT_RULES);
  });

  it("passes overrides through, renaming maxRuntimeMs to longMs", () => {
    const mapped = toModuleConfig({
      ...DEFAULT_RULES,
      staleMs: 60_000,
      maxRuntimeMs: 3_600_000,
      action: "stop",
    });
    expect(mapped).toEqual({
      ...MODULE_DEFAULT_RULES,
      staleMs: 60_000,
      longMs: 3_600_000,
    });
    expect(mapped).not.toHaveProperty("action");
  });

  it("falls back to module defaults for malformed values", () => {
    const malformed = {
      ...DEFAULT_RULES,
      staleMs: "soon",
      maxCostUsd: NaN,
      failureStreak: Infinity,
    } as unknown as RulesConfig;
    expect(toModuleConfig(malformed)).toEqual(MODULE_DEFAULT_RULES);
  });
});
