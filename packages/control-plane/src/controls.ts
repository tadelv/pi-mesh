// SPDX-License-Identifier: GPL-3.0-or-later

export function agentControls(skills: string[] | null): {
  spawn: boolean;
  steer: boolean;
  stop: boolean;
  abort: boolean;
  models: boolean;
  setModel: boolean;
  resume: boolean;
  commands: boolean;
  status: boolean;
} {
  return {
    spawn: skills?.includes("process.spawn") ?? false,
    steer: skills?.includes("session.steer") ?? false,
    stop: skills?.includes("process.stop") ?? false,
    abort: skills?.includes("session.abort") ?? false,
    models: skills?.includes("session.models") ?? false,
    setModel: skills?.includes("session.set_model") ?? false,
    resume: skills?.includes("session.resume") ?? false,
    commands: skills?.includes("session.commands") ?? false,
    status: skills?.includes("session.status") ?? false,
  };
}
