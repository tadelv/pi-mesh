// SPDX-License-Identifier: GPL-3.0-or-later
// One-off M7 hardware proof: a real devpi session streaming live into a real
// browser against the apollo control plane, then the agent stopped mid-turn.
// Not part of the committed tree.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const token = process.env.M7_TOKEN;
const base = process.env.M7_BASE ?? "http://apollo.local:7331";
const prompt =
  process.env.M7_PROMPT ??
  "Write a 25-line numbered list of short sentences about espresso. Output only the list.";
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(stamp(), ...a);

function ssh(command) {
  return execFileSync("ssh", ["devpi.local", "bash", "-s"], {
    input: command,
    encoding: "utf8",
  });
}

const evidence = {};
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (error) => log("page-error:", error.message));
await page.addInitScript((value) => localStorage.setItem("pi_mesh_token", value), token);
await page.goto(base);
await page.getByRole("button", { name: "Sync", exact: true }).click();
await page.waitForTimeout(2500);
log("synced");

const card = page
  .locator("#agents .agent-section")
  .filter({ hasText: "devpi" })
  .first();
await card.getByLabel("Project").fill("m7-live-proof");
await card.getByLabel("Prompt").fill(prompt);
await card.getByRole("button", { name: "Review start" }).click();
await card.getByRole("button", { name: "Start", exact: true }).click();
const outcome = card.locator("p.result.success");
await outcome.waitFor({ timeout: 40_000 });
evidence.outcome = (await outcome.innerText()).trim();
log("spawn:", evidence.outcome);
await card.getByRole("button", { name: "Open session" }).click();
log("opened the session");

const panel = page.locator("#transcript-panel");
const liveStatus = page.locator("#live-status");

// Wait for the live view to attach and paint its banner.
let attached = false;
const attachDeadline = Date.now() + 45_000;
while (Date.now() < attachDeadline) {
  if ((await panel.locator(".live-banner").count()) > 0) {
    attached = true;
    break;
  }
  await page.waitForTimeout(300);
}
evidence.attached = attached;
log("live view attached:", attached, "status:", (await liveStatus.innerText()).trim());
if (!attached) {
  evidence.transcript = (await panel.innerText()).slice(0, 800);
  writeFileSync("/tmp/m7-proof-evidence.json", JSON.stringify(evidence, null, 2));
  throw new Error("the live view never attached");
}

// Observe the live tail growing over several seconds, without a reload.
let before = (await panel.locator(".live-tail").innerText()).length;
let grew = false;
for (let index = 0; index < 30; index += 1) {
  await page.waitForTimeout(400);
  const now = (await panel.locator(".live-tail").innerText()).length;
  if (now > before) grew = true;
  before = now;
  const status = await liveStatus.innerText();
  if (/ended|disconnected|not live/i.test(status)) break;
}
evidence.liveGrowth = grew;
evidence.liveTail = (await panel.locator(".live-tail").innerText()).slice(0, 700);
evidence.liveStatusBeforeStop = (await liveStatus.innerText()).trim();
evidence.liveRegionHasTokens = (await liveStatus.innerText()).includes("espresso");
log("live tail grew without a reload:", grew);
log("live status:", evidence.liveStatusBeforeStop);
log("live region leaked tokens:", evidence.liveRegionHasTokens);

// Stop the agent mid-turn and watch the browser fall back.
log("stopping the devpi agent");
ssh("kill 34452 2>/dev/null; sleep 1; ps aux | grep '[c]li.js start' | head");
let ended = "";
const endDeadline = Date.now() + 40_000;
while (Date.now() < endDeadline) {
  ended = await liveStatus.innerText();
  if (/ended|disconnected|not live/i.test(ended)) break;
  await page.waitForTimeout(300);
}
evidence.liveStatusAfterStop = ended.trim();
log("live status after stop:", evidence.liveStatusAfterStop);
await page.waitForTimeout(1500);
evidence.transcriptAfterStop = (await panel.innerText()).slice(0, 400);
evidence.liveTailAfterStop = await panel.locator(".live-tail").count();

log("restarting the devpi agent");
ssh(
  "cd /home/vid/pi-mesh && PATH=/home/vid/.local/share/pi-node/node-v22.23.2-linux-arm64/bin:/usr/local/bin:/usr/bin:/bin:/home/vid/.local/bin " +
    "nohup node packages/agent/dist/cli.js start --allow-execution=4903a35d-815f-4a2c-9eaf-f5af5593e394 > /tmp/m7-agent.log 2>&1 & " +
    "sleep 2; ps aux | grep '[c]li.js start' | head",
);

writeFileSync("/tmp/m7-proof-evidence.json", JSON.stringify(evidence, null, 2));
log("evidence written to /tmp/m7-proof-evidence.json");
await page.close();
await browser.close();
