// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Overseer panel - the interactive /overseer view.
 *
 * Bounded render: only the most recent N of each section, so it fits a normal
 * terminal without a scroll viewport. `r` re-scans, arrows scroll if it still
 * overflows, Esc closes.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  attentionRuns,
  type Fleet,
  type RunRecord,
  type SessionRecord,
} from "./discovery.ts";
import type { Finding } from "./rules.ts";
import { fmtAge, fmtDuration, fmtTokens, fmtUsd, shortPath } from "./format.ts";

import type { ControlChannelStatus } from "./channel.ts";

export interface PanelData {
  fleet: Fleet;
  findings: Finding[];
  control?: ControlChannelStatus;
}

const MAX_FINDINGS = 10;
const MAX_RUNS = 12;
const MAX_SESSIONS = 12;

export class OverseerPanel {
  private data: PanelData;
  private readonly refresh: () => PanelData;
  private readonly theme: Theme;
  private readonly done: () => void;
  private scroll = 0;
  private lastWidth?: number;
  private lastLines?: string[];

  constructor(
    data: PanelData,
    theme: Theme,
    done: () => void,
    refresh: () => PanelData,
  ) {
    this.data = data;
    this.theme = theme;
    this.done = done;
    this.refresh = refresh;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (matchesKey(data, "r")) {
      this.data = this.refresh();
      this.scroll = 0;
      this.invalidate();
      return;
    }
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.scroll += 1;
      this.invalidate();
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.scroll = Math.max(0, this.scroll - 1);
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.lastLines && this.lastWidth === width) return this.lastLines;
    this.lastLines = this.build(width);
    this.lastWidth = width;
    return this.lastLines;
  }

  invalidate(): void {
    this.lastWidth = undefined;
    this.lastLines = undefined;
  }

  private build(width: number): string[] {
    const th = this.theme;
    const { fleet, findings } = this.data;
    const now = fleet.generatedAt;
    const lines: string[] = [];
    const rule = (label: string) => {
      const text = ` ${label} `;
      const pad = Math.max(0, width - text.length - 3);
      return truncateToWidth(
        th.fg("borderMuted", "─".repeat(3)) +
          th.fg("accent", text) +
          th.fg("borderMuted", "─".repeat(pad)),
        width,
      );
    };

    lines.push("");
    const unknown = fleet.runs.filter(
      (r) => r.liveness.state === "unknown",
    ).length;
    lines.push(
      truncateToWidth(
        th.fg("accent", th.bold(" Overseer")) +
          th.fg(
            "muted",
            `   ${fleet.liveRuns.length} live run${fleet.liveRuns.length === 1 ? "" : "s"}`,
          ) +
          (unknown ? th.fg("warning", ` · ${unknown} unknown`) : "") +
          th.fg(
            "dim",
            ` · ${fleet.sessions.length} sessions (${fleet.liveSessions.length} live)`,
          ) +
          th.fg(
            "dim",
            ` · ${fmtUsd(fleet.totals.cost)} · ${fmtTokens(fleet.totals.tokens)} tok`,
          ),
        width,
      ),
    );
    if (this.data.control) {
      const c = this.data.control;
      const label =
        c.available && c.connected
          ? "steer ready"
          : c.available
            ? "steer channel idle"
            : "observe-only (no pi-intercom)";
      lines.push(truncateToWidth(th.fg("dim", `  control: ${label}`), width));
    }

    if (findings.length) {
      lines.push(rule(`Findings (${findings.length})`));
      for (const f of findings.slice(0, MAX_FINDINGS)) {
        const mark =
          f.severity === "critical"
            ? th.fg("error", "!!")
            : th.fg("warning", " !");
        lines.push(
          truncateToWidth(
            `  ${mark} ${th.fg("accent", f.rule)} ${th.fg("muted", f.label)} ${th.fg("text", f.message)} ${th.fg("dim", `→ ${f.action}`)}`,
            width,
          ),
        );
      }
      if (findings.length > MAX_FINDINGS)
        lines.push(
          truncateToWidth(
            th.fg("dim", `  … ${findings.length - MAX_FINDINGS} more`),
            width,
          ),
        );
    }

    const attention = attentionRuns(fleet);
    const unresolved = attention.length - fleet.liveRuns.length;
    lines.push(
      rule(
        `Live runs (${fleet.liveRuns.length}${unresolved ? ` + ${unresolved} unknown` : ""})`,
      ),
    );
    if (!attention.length)
      lines.push(truncateToWidth(th.fg("dim", "  none"), width));
    for (const run of attention.slice(0, MAX_RUNS))
      lines.push(truncateToWidth(this.runLine(run, now, width), width));

    lines.push(rule(`Sessions (${fleet.sessions.length})`));
    if (!fleet.sessions.length)
      lines.push(truncateToWidth(th.fg("dim", "  none in scan window"), width));
    for (const s of fleet.sessions.slice(0, MAX_SESSIONS))
      lines.push(
        truncateToWidth(this.sessionLine(s, now, fleet, width), width),
      );

    lines.push("");
    lines.push(
      truncateToWidth(
        th.fg("dim", "  r refresh · ↑/↓ scroll · Esc close"),
        width,
      ),
    );
    lines.push("");

    const max = Math.max(0, lines.length - 1);
    this.scroll = Math.min(this.scroll, max);
    return this.scroll ? lines.slice(this.scroll) : lines;
  }

  // shortcut: these private line helpers ignore width, revisit when the panel is reworked
  // finding: no width-aware layout happens here; lines are only chopped to fit by the caller.
  private runLine(run: RunRecord, now: number, _width: number): string {
    void _width;
    const th = this.theme;
    const tri = run.live ? "alive" : run.liveness.state;
    const dot =
      tri === "alive"
        ? th.fg("success", "●")
        : tri === "unknown"
          ? th.fg("warning", "◐")
          : th.fg("dim", "○");
    const agent = th.fg("text", (run.agent ?? "agent").padEnd(14).slice(0, 14));
    const state = th.fg(
      tri === "alive" ? "success" : tri === "unknown" ? "warning" : "muted",
      run.state.padEnd(9).slice(0, 9),
    );
    const t =
      run.startedAt !== undefined
        ? fmtDuration(now - run.startedAt).padEnd(8)
        : "".padEnd(8);
    const cost = fmtUsd(run.totalCost).padEnd(9);
    const cwd = th.fg("dim", shortPath(run.cwd));
    const evidence =
      tri === "unknown" ? th.fg("dim", ` (${run.liveness.reason})`) : "";
    return `  ${dot} ${agent} ${state} ${th.fg("muted", t)} ${th.fg("muted", cost)} ${cwd}${evidence}`;
  }

  private sessionLine(
    s: SessionRecord,
    now: number,
    fleet: Fleet,
    _width: number,
  ): string {
    void _width;
    const th = this.theme;
    const dot = s.live ? th.fg("success", "●") : th.fg("dim", "○");
    const runs = fleet.runsBySession.get(s.file)?.length ?? 0;
    const fans = runs
      ? th.fg("accent", ` ${runs} run${runs === 1 ? "" : "s"}`)
      : th.fg("dim", " 0 runs");
    return `  ${dot} ${th.fg("text", shortPath(s.cwd).padEnd(34).slice(0, 34))} ${th.fg("muted", fmtAge(s.lastActiveAt, now).padEnd(11))}${fans}`;
  }
}
