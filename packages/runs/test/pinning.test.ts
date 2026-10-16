// SPDX-License-Identifier: GPL-3.0-or-later

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertSupportedLayout,
  assertSupportedVersion,
  PINNED_PI_SUBAGENTS_VERSION,
} from "../src/index.js";

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(
  readFileSync(path.join(packageDir, "package.json"), "utf8"),
) as unknown as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

describe("pinning", () => {
  it("declares pi-subagents pinned exactly, with no range", () => {
    expect(packageJson.dependencies?.["pi-subagents"]).toBe("0.78.0");
  });

  it("the pin is the single source of truth and matches the manifest", () => {
    expect(PINNED_PI_SUBAGENTS_VERSION).toBe("0.78.0");
    expect(PINNED_PI_SUBAGENTS_VERSION).toBe(
      packageJson.dependencies?.["pi-subagents"],
    );
    expect(assertSupportedVersion(PINNED_PI_SUBAGENTS_VERSION)).toEqual({
      ok: true,
    });
  });

  it("accepts the pinned line and refuses everything outside it", () => {
    for (const version of ["0.78.0", "0.78.1", "0.78.9"]) {
      expect(assertSupportedVersion(version)).toEqual({ ok: true });
    }
    for (const version of ["0.79.0", "0.77.9", "1.78.0", "0.78", "abc"]) {
      expect(assertSupportedVersion(version).ok).toBe(false);
    }
    expect(assertSupportedVersion("")).toEqual({
      ok: false,
      reason: "missing-version",
    });
    expect(assertSupportedVersion(undefined).ok).toBe(false);
    expect(assertSupportedVersion(78).ok).toBe(false);
  });

  it("refuses an unrecognised layout without throwing", () => {
    expect(() => assertSupportedLayout("/no/such/dir")).not.toThrow();
    expect(assertSupportedLayout("/no/such/dir").ok).toBe(false);
  });

  it("has no @pi-mesh/* dependency and imports nothing from the mesh", () => {
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ] as const) {
      for (const name of Object.keys(packageJson[section] ?? {})) {
        expect(name.startsWith("@pi-mesh/")).toBe(false);
      }
    }
    const srcDir = path.join(packageDir, "src");
    for (const entry of readdirSync(srcDir).sort()) {
      if (!entry.endsWith(".ts")) {
        continue;
      }
      const content = readFileSync(path.join(srcDir, entry), "utf8");
      expect(content.includes("@pi-mesh/")).toBe(false);
      expect(content.includes("SPDX-License-Identifier")).toBe(true);
    }
  });
});
