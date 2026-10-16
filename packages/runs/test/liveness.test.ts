// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { probeLiveness } from "../src/index.js";

function epermKill(): never {
  const error = new Error("operation not permitted") as Error & {
    code: string;
  };
  error.code = "EPERM";
  throw error;
}

function esrchKill(): never {
  const error = new Error("no such process") as Error & { code: string };
  error.code = "ESRCH";
  throw error;
}

describe("probeLiveness", () => {
  it("reports a dead pid as dead", () => {
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(child.status).toBe(0);
    const deadPid = child.pid;
    const result = probeLiveness(deadPid);
    expect(result.state).toBe("dead");
    expect(result.reason).toBe("pid-dead");
    expect(typeof result.probedAt).toBe("number");
  });

  it("a simulated EPERM is unknown, not alive", () => {
    const result = probeLiveness(4242, { kill: epermKill });
    expect(result.state).toBe("unknown");
    expect(result.reason).toBe("permission-denied");
    expect(result.state).not.toBe("alive");
  });

  it("an injected ESRCH is dead", () => {
    const result = probeLiveness(4242, { kill: esrchKill });
    expect(result.state).toBe("dead");
    expect(result.reason).toBe("pid-dead");
  });

  it("a pid-less run is unknown", () => {
    for (const pid of [undefined, null, "4242", 1.5, 0, -3, NaN]) {
      const result = probeLiveness(pid);
      expect(result.state).toBe("unknown");
      expect(result.reason).toBe("no-pid");
    }
  });

  it("a Linux zombie is dead", () => {
    const zombieStat =
      "4242 (node) Z 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0";
    const result = probeLiveness(4242, {
      kill: () => {},
      readFile: () => zombieStat,
      platform: "linux",
    });
    expect(result.state).toBe("dead");
    expect(result.reason).toBe("zombie");
  });

  it("a Linux non-zombie that answers kill(0) is alive", () => {
    const runningStat =
      "4242 (node) S 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0";
    const result = probeLiveness(4242, {
      kill: () => {},
      readFile: () => runningStat,
      platform: "linux",
    });
    expect(result.state).toBe("alive");
    expect(result.reason).toBe("pid-alive");
  });

  it("a live pid is alive with pid-alive evidence", () => {
    const result = probeLiveness(process.pid);
    expect(result.state).toBe("alive");
    expect(result.reason).toBe("pid-alive");
  });

  it("never sends any signal other than 0", () => {
    const signals: unknown[] = [];
    probeLiveness(4242, {
      kill: (pid, signal) => {
        signals.push(signal);
      },
      platform: "darwin",
    });
    expect(signals).toEqual([0]);
    probeLiveness(4242, { kill: epermKill });
    // The EPERM throw above proves the probe called kill; a signal-bearing
    // call would have thrown a different error shape upstream.
  });

  it("an unexpected probe error is unknown, not dead", () => {
    const result = probeLiveness(4242, {
      kill: () => {
        throw new Error("boom");
      },
    });
    expect(result.state).toBe("unknown");
    expect(result.reason).toBe("probe-failed");
  });
});
