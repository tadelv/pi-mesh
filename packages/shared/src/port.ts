// SPDX-License-Identifier: GPL-3.0-or-later

const DEFAULT_MESH_PORT = 7330;

/** Resolve PI_MESH_PORT consistently for the CLI and the HTTP listener. */
export function configuredMeshPort(
  value?: number,
  environmentValue = process.env.PI_MESH_PORT,
): number {
  const configured =
    value ??
    (environmentValue === undefined || environmentValue.trim() === ""
      ? DEFAULT_MESH_PORT
      : Number(environmentValue));
  if (!Number.isInteger(configured) || configured < 0 || configured > 65535) {
    if (value === undefined) return DEFAULT_MESH_PORT;
    throw new RangeError("port must be an integer between 0 and 65535");
  }
  return configured;
}
