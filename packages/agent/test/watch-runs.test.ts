// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * M8-7 STEP 1: runs and findings ride `mesh.watch`.
 *
 * Agent test style: injected roots, fixtures under a temp dir, no machine
 * state. Each clause fails by name when the code it protects is removed.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WatchFrame } from "@pi-mesh/protocol";
import { createRunsPlane, SessionWatch, type RunsPlane } from "../src/index.js";

const NOW = 1_750_000_000_000;
const HUGE_INTERVAL = 3_600_000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function nextFrame(
  watch: SessionWatch,
  label: string,
  milliseconds = 5_000,
): Promise<WatchFrame> {
  const result = await Promise.race([
    watch.next(),
    sleep(milliseconds).then((): IteratorResult<WatchFrame> => {
      throw new Error(`${label}: no frame arrived within ${milliseconds}ms`);
    }),
  ]);
  if (result.done) throw new Error(`${label}: the watch ended early`);
  return result.value;
}

const watches: SessionWatch[] = [];
afterEach(async () => {
  for (const watch of watches.splice(0)) await watch.stop();
});

async function writeStatus(
  tmp: string,
  runId: string,
  status: Record<string, unknown>,
): Promise<void> {
  const dir = join(tmp, "pi-subagents-a", "async-subagent-runs", runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "status.json"), JSON.stringify(status));
}

function runningStatus(
  runId: string,
  lastUpdate: number,
): Record<string, unknown> {
  return {
    runId,
    state: "running",
    startedAt: NOW - 60_000,
    lastUpdate,
  };
}

async function writeRules(
  tmp: string,
  rules: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(tmp, "rules.json"), JSON.stringify(rules));
}

function planeFor(tmp: string): { plane: RunsPlane; signals: number[] } {
  const signals: number[] = [];
  const plane = createRunsPlane({
    tmp,
    layoutRecognised: true,
    rulesPath: join(tmp, "rules.json"),
    now: () => NOW,
    livenessDeps: {
      platform: "darwin",
      kill: (pid: number) => {
        signals.push(pid);
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
    },
  });
  return { plane, signals };
}

async function roots(): Promise<{ sessionsRoot: string; runsTmp: string }> {
  const sessionsRoot = await mkdtemp(
    join(tmpdir(), "pi-mesh-watch-runs-sessions-"),
  );
  const runsTmp = await mkdtemp(join(tmpdir(), "pi-mesh-watch-runs-tmp-"));
  return { sessionsRoot, runsTmp };
}

async function cleanup(roots: {
  sessionsRoot: string;
  runsTmp: string;
}): Promise<void> {
  await rm(roots.sessionsRoot, { recursive: true, force: true });
  await rm(roots.runsTmp, { recursive: true, force: true });
}

/** Open a watch and return its bootstrap snapshot. */
async function openWatch(
  sessionsRoot: string,
  runs: RunsPlane | undefined,
): Promise<{ watch: SessionWatch; snapshot: WatchFrame }> {
  const watch = new SessionWatch({
    sessionsRoot,
    pollIntervalMs: HUGE_INTERVAL,
    reconcileIntervalMs: HUGE_INTERVAL,
    ...(runs === undefined ? {} : { runs }),
  });
  watches.push(watch);
  const snapshot = await nextFrame(
    watch,
    "watch-runs bootstrap: the snapshot frame",
  );
  if (snapshot.type !== "snapshot") {
    throw new Error(
      `watch-runs bootstrap: first frame must be a snapshot, saw ${snapshot.type}`,
    );
  }
  return { watch, snapshot };
}

describe("M8-7 watch frames: runs and findings", () => {
  it("watch-runs-bootstrap: the snapshot carries the agent's runs and findings", async () => {
    const dirs = await roots();
    try {
      await writeStatus(
        dirs.runsTmp,
        "run-1",
        runningStatus("run-1", NOW - 30_000),
      );
      await writeRules(dirs.runsTmp, { staleMs: 1_000 });
      const { plane, signals } = planeFor(dirs.runsTmp);
      const { snapshot } = await openWatch(dirs.sessionsRoot, plane);
      if (snapshot.type !== "snapshot") throw new Error("unreachable");
      expect(
        snapshot.runs?.map((run) => run.run_id),
        "watch-runs-bootstrap: the snapshot carries the agent's runs",
      ).toEqual(["run-1"]);
      expect(
        snapshot.findings?.findings.map((finding) => finding.rule),
        "watch-runs-bootstrap: the snapshot carries one evaluation pass",
      ).toEqual(["run-stale"]);
      expect(typeof snapshot.findings?.evaluated_at).toBe("string");
      expect(snapshot.findings?.coverage).toMatchObject({
        layout_recognised: true,
        last_error: null,
      });
      expect(typeof snapshot.findings?.coverage.last_success).toBe("string");
      // The read path starts no process and sends no signal.
      expect(signals).toEqual([]);
    } finally {
      await cleanup(dirs);
    }
  });

  it("watch-runs-delta: a new run emits exactly one run frame", async () => {
    const dirs = await roots();
    try {
      await writeRules(dirs.runsTmp, { staleMs: HUGE_INTERVAL });
      const { plane } = planeFor(dirs.runsTmp);
      const { watch } = await openWatch(dirs.sessionsRoot, plane);
      await writeStatus(
        dirs.runsTmp,
        "run-new",
        runningStatus("run-new", NOW - 1_000),
      );
      await watch.poll();
      const frame = await nextFrame(watch, "watch-runs-delta: the run frame");
      expect(frame.type).toBe("run");
      if (frame.type !== "run") throw new Error("unreachable");
      expect(frame.run.run_id).toBe("run-new");
      expect(frame.run.state).toBe("running");
      expect(frame.run.liveness.state).toBe("unknown");
    } finally {
      await cleanup(dirs);
    }
  });

  it("watch-runs-removed: a removed run emits run-removed", async () => {
    const dirs = await roots();
    try {
      await writeStatus(
        dirs.runsTmp,
        "run-keep",
        runningStatus("run-keep", NOW - 1_000),
      );
      await writeStatus(
        dirs.runsTmp,
        "run-gone",
        runningStatus("run-gone", NOW - 1_000),
      );
      await writeRules(dirs.runsTmp, { staleMs: HUGE_INTERVAL });
      const { plane } = planeFor(dirs.runsTmp);
      const { watch } = await openWatch(dirs.sessionsRoot, plane);
      await rm(
        join(dirs.runsTmp, "pi-subagents-a", "async-subagent-runs", "run-gone"),
        { recursive: true },
      );
      await watch.poll();
      const frame = await nextFrame(
        watch,
        "watch-runs-removed: the removal frame",
      );
      expect(frame).toEqual({ type: "run-removed", run_id: "run-gone" });
    } finally {
      await cleanup(dirs);
    }
  });

  it("watch-runs-quiet: clock-only movement emits no run frame", async () => {
    const dirs = await roots();
    try {
      await writeStatus(
        dirs.runsTmp,
        "run-1",
        runningStatus("run-1", NOW - 1_000),
      );
      await writeRules(dirs.runsTmp, { staleMs: HUGE_INTERVAL });
      const { plane } = planeFor(dirs.runsTmp);
      const { watch } = await openWatch(dirs.sessionsRoot, plane);
      // Nothing material changed: probed_at and status_age_ms moved, but
      // those are clock-derived and must not re-emit the run every poll.
      await watch.poll();
      const winner = await Promise.race([
        watch.next().then(() => "frame" as const),
        sleep(300).then(() => "timeout" as const),
      ]);
      expect(
        winner,
        "watch-runs-quiet: no run frame for clock-only movement (remove the probed_at/status_age_ms exclusion to fail this)",
      ).toBe("timeout");
    } finally {
      await cleanup(dirs);
    }
  });

  it("watch-runs-findings: reconcile emits a findings frame replacing the previous set", async () => {
    const dirs = await roots();
    try {
      await writeStatus(
        dirs.runsTmp,
        "run-1",
        runningStatus("run-1", NOW - 1_000),
      );
      await writeRules(dirs.runsTmp, { staleMs: HUGE_INTERVAL });
      const { plane } = planeFor(dirs.runsTmp);
      const { watch, snapshot } = await openWatch(dirs.sessionsRoot, plane);
      if (snapshot.type !== "snapshot") throw new Error("unreachable");
      expect(
        snapshot.findings?.findings,
        "watch-runs-findings: the bootstrap set is observed-empty, not absent",
      ).toEqual([]);
      // The fast pass is not an evaluation pass: changing only the rules
      // and polling must emit nothing - no findings, no spurious run frame.
      await writeRules(dirs.runsTmp, { staleMs: 1_000 });
      await watch.poll();
      const polled = await Promise.race([
        watch.next().then(() => "frame" as const),
        sleep(300).then(() => "timeout" as const),
      ]);
      expect(
        polled,
        "watch-runs-findings: the fast poll is not an evaluation pass",
      ).toBe("timeout");
      // Now the run goes stale; the slow pass re-lists runs and evaluates.
      await writeStatus(
        dirs.runsTmp,
        "run-1",
        runningStatus("run-1", NOW - 30_000),
      );
      await watch.reconcile();
      // The reconcile re-lists runs too: the stale run's last_update changed,
      // so a run frame may precede the findings frame. Drain to findings.
      let frame = await nextFrame(
        watch,
        "watch-runs-findings: a frame after reconcile",
      );
      if (frame.type === "run") {
        frame = await nextFrame(
          watch,
          "watch-runs-findings: the findings frame",
        );
      }
      expect(frame.type).toBe("findings");
      if (frame.type !== "findings") throw new Error("unreachable");
      expect(
        frame.findings.map((finding) => finding.rule),
        "watch-runs-findings: the frame replaces the previous set wholesale",
      ).toEqual(["run-stale"]);
      expect(frame.evaluated_at).toBe(new Date(NOW).toISOString());
      expect(frame.coverage.layout_recognised).toBe(true);
    } finally {
      await cleanup(dirs);
    }
  });

  it("watch-runs-noplane: without a runs plane the snapshot omits runs and findings", async () => {
    const dirs = await roots();
    try {
      const { snapshot } = await openWatch(dirs.sessionsRoot, undefined);
      if (snapshot.type !== "snapshot") throw new Error("unreachable");
      expect(
        "runs" in snapshot,
        "watch-runs-noplane: absent means not observed, never an empty list",
      ).toBe(false);
      expect(
        "findings" in snapshot,
        "watch-runs-noplane: absent means not observed, never 'no findings'",
      ).toBe(false);
    } finally {
      await cleanup(dirs);
    }
  });

  it("watch-runs-peek: peek returns the whole firing set without consuming suppression", async () => {
    const dirs = await roots();
    try {
      await writeStatus(
        dirs.runsTmp,
        "run-1",
        runningStatus("run-1", NOW - 30_000),
      );
      await writeRules(dirs.runsTmp, { staleMs: 1_000 });
      const { plane } = planeFor(dirs.runsTmp);
      const first = plane.evaluateFindings();
      expect(
        first.findings.map((finding) => finding.rule),
        "watch-runs-peek: the stale run fires",
      ).toEqual(["run-stale"]);
      // The mirror reads through peek: still the whole set, not the
      // suppressed (new-only) answer.
      expect(
        plane.peekFindings().findings.map((finding) => finding.rule),
        "watch-runs-peek: peek sees the whole firing set after a notify",
      ).toEqual(["run-stale"]);
      // And peeking consumed nothing: suppression still holds for notify.
      expect(
        plane.evaluateFindings().findings,
        "watch-runs-peek: notify-once still suppresses after peeks",
      ).toEqual([]);
      expect(
        plane.peekFindings().findings.map((finding) => finding.rule),
        "watch-runs-peek: the mirror still sees the firing finding",
      ).toEqual(["run-stale"]);
    } finally {
      await cleanup(dirs);
    }
  });

  it("watch-runs-peek-malformed: a malformed rules file refuses, never reads as no findings", async () => {
    const dirs = await roots();
    try {
      await writeStatus(
        dirs.runsTmp,
        "run-1",
        runningStatus("run-1", NOW - 30_000),
      );
      await writeFile(join(dirs.runsTmp, "rules.json"), "{not json");
      const { plane } = planeFor(dirs.runsTmp);
      await expect(
        (async () => plane.peekFindings())(),
        "watch-runs-peek-malformed: invalid JSON must refuse like evaluateFindings",
      ).rejects.toMatchObject({
        message: expect.stringMatching(/not valid JSON/),
      });
    } finally {
      await cleanup(dirs);
    }
  });
});
