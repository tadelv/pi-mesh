// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";

// The markup is a real file, not a template literal, so it can be reviewed as
// HTML and, in development, served straight from src/ without a rebuild
// (scripts/dashboard-dev.mjs). tsc does not copy non-TS files, so the package
// build copies dashboard.html next to the compiled dashboard.js; the default
// read below therefore finds dist/dashboard.html at runtime.
const dashboardPath = new URL("./dashboard.html", import.meta.url);

/**
 * Read the dashboard markup. Callers that want on-disk edits reflected (the dev
 * server) call this per request; the built server reads dist/dashboard.html.
 */
export function dashboardHtml(): string {
  return readFileSync(dashboardPath, "utf8");
}

/** The markup as of module load, for tests and callers that want it once. */
export const dashboard = dashboardHtml();
