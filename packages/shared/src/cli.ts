// SPDX-License-Identifier: GPL-3.0-or-later

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when this module was invoked as the process entry point.
 *
 * Both sides go through realpath. npm and pnpm install `bin` entries as
 * symlinks, so import.meta.url is the real file while argv[1] is the link;
 * comparing with resolve() alone silently skips the entire CLI there, and the
 * process exits 0 having done nothing.
 */
export function isDirectInvocation(
  metaUrl: string,
  entryPath: string | undefined,
): boolean {
  if (entryPath === undefined) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entryPath);
  } catch {
    return false;
  }
}
