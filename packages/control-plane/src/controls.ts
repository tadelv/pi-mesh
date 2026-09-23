// SPDX-License-Identifier: GPL-3.0-or-later

export function agentControls(skills: string[] | null): {
  spawn: boolean;
  steer: boolean;
  stop: boolean;
  abort: boolean;
} {
  return {
    spawn: skills?.includes("process.spawn") ?? false,
    steer: skills?.includes("session.steer") ?? false,
    stop: skills?.includes("process.stop") ?? false,
    abort: skills?.includes("session.abort") ?? false,
  };
}
