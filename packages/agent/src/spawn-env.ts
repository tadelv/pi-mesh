// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Build the child environment exactly as a locally launched Pi would see it,
 * except that mesh secrets never cross into a spawned session. The old
 * allowlist made a spawned session unlike a local one (SSH_AUTH_SOCK,
 * toolchain variables, proxies) for no security gain: a spawned Pi can read
 * the same files from the filesystem with its own tools. Pi is not a sandbox
 * (ADR 0008), so an environment filter that a shell command walks around is
 * not a boundary.
 */
export function buildSpawnEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(parent).filter(([name]) => !name.startsWith("PI_MESH_")),
  );
}
