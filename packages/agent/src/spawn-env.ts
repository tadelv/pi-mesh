// SPDX-License-Identifier: GPL-3.0-or-later

const FIXED_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "PI_OFFLINE",
  "PI_TELEMETRY",
  "PI_SKIP_VERSION_CHECK",
  "PI_CODING_AGENT_DIR",
  "PI_CACHE_RETENTION",
  "PI_PACKAGE_DIR",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
]);

export interface SpawnEnvResult {
  env: NodeJS.ProcessEnv;
  /** Names the caller asked for that are refused outright. */
  refused: string[];
}

function isCredential(name: string): boolean {
  return /^[A-Z0-9_]+_API_KEY$/.test(name);
}

export function buildSpawnEnv(
  parent: NodeJS.ProcessEnv,
  passthrough?: string,
): SpawnEnvResult {
  const env: NodeJS.ProcessEnv = {};
  const refused: string[] = [];
  const requested = (passthrough ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const seen = new Set<string>();
  for (const name of requested) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (name.startsWith("PI_MESH_")) {
      refused.push(name);
      continue;
    }
    if (parent[name] !== undefined) env[name] = parent[name];
  }
  for (const [name, value] of Object.entries(parent)) {
    if (name.startsWith("PI_MESH_")) continue;
    if (FIXED_NAMES.has(name) || isCredential(name)) env[name] = value;
  }
  return { env, refused };
}
