// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared display formatting for the overseer panel and tool output.
 */

import { homedir } from "node:os";

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function fmtAge(then: number | undefined, now = Date.now()): string {
  if (then === undefined) return "?";
  return `${fmtDuration(now - then)} ago`;
}

export function fmtUsd(n: number | undefined): string {
  if (!n || !Number.isFinite(n) || n <= 0) return "$0";
  return n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

export function fmtTokens(n: number | undefined): string {
  if (!n || !Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function shortPath(p: string | undefined, home = homedir()): string {
  if (!p) return "?";
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function baseName(p: string | undefined): string {
  if (!p) return "?";
  return p.split("/").filter(Boolean).pop() ?? p;
}
