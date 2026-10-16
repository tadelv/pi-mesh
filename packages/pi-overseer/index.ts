// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Overseer - one session watching and steering every other pi session and
 * subagent run on the machine.
 *
 * Observe plane (no dependencies): reads the evidence every pi process already
 * writes, so it sees sessions in any folder under ~ regardless of window:
 *   ~/.pi/agent/sessions/--<munged-cwd>--/<iso>_<uuid>.jsonl
 *   <tmp>/pi-subagents-<scope>/async-subagent-runs/<runId>/status.json
 *
 * Report plane: the /overseer panel and the model-callable `overseer` tool.
 *
 * Control plane: steer/stop/interrupt a run.
 *   - If this session owns the run, execute the pi-subagents RPC here.
 *   - Otherwise broadcast an `overseer/v1` command over pi-intercom's extension
 *     bus; the owning session receives it and executes the RPC in its process.
 *
 * Rules plane: deterministic thresholds become findings, delivered by
 * `rules.action` (notify | steer | stop).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createControlChannel, type ControlChannel, type ControlChannelStatus, type ControlCommand } from "./channel.ts";
import { executeLocalControl, isVerb, type Verb } from "./control.ts";
import { buildFleet, findRun } from "./discovery.ts";
import { fmtAge, fmtDuration, fmtTokens, fmtUsd, shortPath } from "./format.ts";
import { OverseerPanel, type PanelData } from "./panel.ts";
import { DEFAULT_RULES, evaluateRules, type Action, type RulesConfig, type Severity } from "./rules.ts";

interface OverseerConfig {
  /** how far back to scan session transcripts and run artifacts */
  maxAgeHours: number;
  /** message sent when a rule steers a stalled run */
  autoSteerMessage: string;
  rules: RulesConfig;
}

const DEFAULT_CONFIG: OverseerConfig = {
  maxAgeHours: 24,
  autoSteerMessage:
    "Overseer: this run looks stalled (no recent activity). Reply with a one-line status and either continue, finish, or state the blocker.",
  rules: DEFAULT_RULES,
};

const CONFIG_FILE = join(homedir(), ".pi/agent/extensions/overseer/config.json");

/**
 * Subagent child sessions load this extension too. They must register for
 * control (so their own runs are addressable) but must not run the cross-session
 * scan or fire rule notifications on every child turn.
 */
const IS_CHILD_SESSION = Boolean(
  process.env.PI_SUBAGENT_CHILD || process.env.PI_SUBAGENT_RUN_ID || process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET,
);

function loadConfig(): OverseerConfig {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<OverseerConfig>;
    return {
      maxAgeHours: typeof parsed.maxAgeHours === "number" ? parsed.maxAgeHours : DEFAULT_CONFIG.maxAgeHours,
      autoSteerMessage:
        typeof parsed.autoSteerMessage === "string" && parsed.autoSteerMessage.trim()
          ? parsed.autoSteerMessage
          : DEFAULT_CONFIG.autoSteerMessage,
      rules: { ...DEFAULT_RULES, ...(parsed.rules ?? {}) },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

const OverseerParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("summary"),
      Type.Literal("runs"),
      Type.Literal("sessions"),
      Type.Literal("findings"),
      Type.Literal("steer"),
      Type.Literal("stop"),
      Type.Literal("interrupt"),
    ],
    { description: "Read: summary | runs | sessions | findings. Control: steer | stop | interrupt (needs runId)." },
  ),
  runId: Type.Optional(Type.String({ description: "Run id for steer/stop/interrupt" })),
  message: Type.Optional(Type.String({ description: "Steering text for steer" })),
});

function scan(config: OverseerConfig): PanelData {
  const fleet = buildFleet({ maxAgeMs: config.maxAgeHours * 3_600_000 });
  return { fleet, findings: config.rules.enabled ? evaluateRules(fleet, config.rules) : [] };
}

function summaryText(data: PanelData): string {
  const { fleet, findings } = data;
  const now = fleet.generatedAt;
  const out: string[] = [
    `${fleet.liveRuns.length} live run(s) · ${fleet.sessions.length} session(s) in window (${fleet.liveSessions.length} live) · ${fmtUsd(fleet.totals.cost)} · ${fmtTokens(fleet.totals.tokens)} tok`,
  ];
  for (const f of findings) out.push(`[${f.severity}] ${f.rule}: ${f.label} ${f.message} → ${f.action}`);
  for (const r of fleet.liveRuns) {
    out.push(
      `  live ${r.agent ?? "agent"} ${r.runId.slice(0, 8)} ${r.state} ${r.startedAt ? fmtDuration(now - r.startedAt) : "?"} ${fmtUsd(r.totalCost)} ${shortPath(r.cwd)}`,
    );
  }
  for (const s of fleet.liveSessions) out.push(`  session ${shortPath(s.cwd)} ${fmtAge(s.lastActiveAt, now)}`);
  if (!findings.length && !fleet.liveRuns.length) out.push("no active work");
  return out.join("\n");
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const notified = new Set<string>();
  let liveCtx: ExtensionContext | undefined;

  // Mirror pi-subagents' own identity (`getSessionFile() ?? getSessionId()`), which is
  // exactly the value it writes to status.json.sessionId - so the target key we
  // compute always matches the key the owning session computes.
  const selfSessionKey = (): string | undefined => {
    try {
      return liveCtx?.sessionManager.getSessionFile() ?? liveCtx?.sessionManager.getSessionId();
    } catch {
      return undefined;
    }
  };

  const notify = (message: string, level: "info" | "warning" | "error") => {
    try {
      liveCtx?.ui?.notify(message, level);
    } catch {
      // notifications are best-effort
    }
  };

  /** Executes in the process that owns the run, after a peer command arrives. */
  async function handleCommand(command: ControlCommand): Promise<void> {
    const result = await executeLocalControl(pi.events, command.verb, command.runId, command.text);
    channel.publishResult({
      target: command.target,
      runId: command.runId,
      verb: command.verb,
      ok: result.ok,
      detail: result.detail,
    });
    notify(
      `overseer: peer ${command.verb} on ${command.runId.slice(0, 8)} ${result.ok ? "ok" : `failed — ${result.detail}`}`,
      result.ok ? "info" : "warning",
    );
  }

  const channel: ControlChannel = createControlChannel(pi.events, {
    selfSessionFile: selfSessionKey,
    onCommand: (command) => {
      void handleCommand(command).catch(() => undefined);
    },
  });

  interface ControlOutcome {
    ok: boolean;
    detail: string;
    where: "local" | "peer" | "lookup";
  }

  /** The three details shapes the overseer tool returns: a usage error, a control outcome, or a fleet read. */
  type OverseerToolDetails =
    | { action: Verb; ok: boolean }
    | ({ action: Verb; runId: string } & ControlOutcome)
    | {
        action: string;
        liveRuns: number;
        sessions: number;
        liveSessions: number;
        findings: { rule: string; severity: Severity; id: string; action: Action }[];
        totals: { tokens: number; cost: number };
        control: ControlChannelStatus;
      };

  async function runControl(verb: Verb, runId: string, text?: string): Promise<ControlOutcome> {
    const run = findRun(runId);
    if (!run) return { ok: false, detail: `no run '${runId}' found on this host`, where: "lookup" };

    const owner = run.parentSessionFile;
    const self = selfSessionKey();
    if (!owner || owner === self) {
      const result = await executeLocalControl(pi.events, verb, runId, text);
      return { ok: result.ok, detail: result.detail, where: "local" };
    }

    const published = channel.publishCommand({ target: owner, runId, verb, text });
    return published.ok
      ? {
          ok: true,
          detail: `${verb} broadcast to owning session ${owner.split("/").pop() ?? owner}`,
          where: "peer",
        }
      : { ok: false, detail: published.detail, where: "peer" };
  }

  pi.registerTool<typeof OverseerParams, OverseerToolDetails>({
    name: "overseer",
    label: "Overseer",
    description:
      "Inspect every pi session and subagent run on this machine (any project folder), and steer, stop, or interrupt a run by id.",
    parameters: OverseerParams,

    async execute(_toolCallId, params) {
      const action = params.action as string;

      if (isVerb(action)) {
        const runId = (params.runId ?? "").trim();
        if (!runId) {
          return {
            content: [{ type: "text", text: `${action} requires runId (use action: "runs" to list ids)` }],
            details: { action, ok: false },
          };
        }
        const outcome = await runControl(action, runId, params.message);
        return {
          content: [
            {
              type: "text",
              text: outcome.ok
                ? `${action} accepted (${outcome.where}): ${outcome.detail}`
                : `${action} failed (${outcome.where}): ${outcome.detail}`,
            },
          ],
          details: { action, runId, ok: outcome.ok, where: outcome.where, detail: outcome.detail },
          isError: !outcome.ok,
        };
      }

      const data = scan(config);
      const { fleet, findings } = data;
      const now = fleet.generatedAt;
      const control = channel.status();
      let text: string;

      switch (action) {
        case "findings":
          text = findings.length
            ? findings.map((f) => `[${f.severity}] ${f.rule} · ${f.label} · ${f.message} → ${f.action}`).join("\n")
            : "No rule findings.";
          break;
        case "runs":
          text = fleet.runs.length
            ? fleet.runs
                .map(
                  (r) =>
                    `${r.live ? "●" : "○"} ${r.agent ?? "agent"} ${r.runId.slice(0, 8)} ${r.state} ${r.startedAt ? fmtDuration(now - r.startedAt) : "?"} ${fmtUsd(r.totalCost)} ${fmtTokens(r.totalTokens)} ${shortPath(r.cwd)}`,
                )
                .join("\n")
            : "No runs in window.";
          break;
        case "sessions":
          text = fleet.sessions.length
            ? fleet.sessions
                .map(
                  (s) =>
                    `${s.live ? "●" : "○"} ${shortPath(s.cwd)} ${fmtAge(s.lastActiveAt, now)} · ${fleet.runsBySession.get(s.file)?.length ?? 0} run(s)`,
                )
                .join("\n")
            : "No sessions in window.";
          break;
        default:
          text = summaryText(data);
      }

      return {
        content: [{ type: "text", text }],
        details: {
          action,
          liveRuns: fleet.liveRuns.length,
          sessions: fleet.sessions.length,
          liveSessions: fleet.liveSessions.length,
          findings: findings.map((f) => ({ rule: f.rule, severity: f.severity, id: f.id, action: f.action })),
          totals: fleet.totals,
          control,
        },
      };
    },
  });

  pi.registerCommand("overseer", {
    description: "Show all live pi sessions and subagent runs, and steering status",
    handler: async (_args, ctx) => {
      liveCtx = ctx;
      const data = { ...scan(config), control: channel.status() };
      if (ctx.mode !== "tui") {
        ctx.ui.notify(summaryText(data), "info");
        return;
      }
      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new OverseerPanel(data, theme, () => done(), () => ({ ...scan(config), control: channel.status() }));
      });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    liveCtx = ctx;
    channel.register();
  });

  pi.on("session_tree", (_event, ctx) => {
    liveCtx = ctx;
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (IS_CHILD_SESSION) return;
    liveCtx = ctx;

    let data: PanelData;
    try {
      data = scan(config);
    } catch {
      return;
    }

    const live = new Set<string>();
    for (const finding of data.findings) {
      const key = `${finding.rule}:${finding.id}`;
      live.add(key);
      if (notified.has(key)) continue;
      notified.add(key);

      ctx.ui.notify(
        `overseer: ${finding.rule} — ${finding.label} ${finding.message}`,
        finding.severity === "critical" ? "error" : "warning",
      );

      const wantsAction = config.rules.action === "steer" || config.rules.action === "stop";
      if (wantsAction && finding.kind === "run") {
        const verb: Verb = config.rules.action === "stop" ? "stop" : "steer";
        void runControl(verb, finding.id, verb === "steer" ? config.autoSteerMessage : undefined).then((outcome) => {
          notify(
            `overseer auto-${verb} ${finding.id.slice(0, 8)} (${outcome.where}): ${outcome.ok ? "ok" : outcome.detail}`,
            outcome.ok ? "info" : "warning",
          );
        });
      }
    }
    for (const key of [...notified]) if (!live.has(key)) notified.delete(key);

    const control = channel.status();
    const bits = [`${data.fleet.liveRuns.length} live`];
    if (data.findings.length) bits.push(`${data.findings.length} finding(s)`);
    if (control.available && control.connected) bits.push("steer ready");
    ctx.ui.setStatus("overseer", bits.join(" · "));
  });

  pi.on("session_shutdown", () => {
    notified.clear();
    channel.dispose();
  });
}
