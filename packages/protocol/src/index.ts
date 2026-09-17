// SPDX-License-Identifier: GPL-3.0-or-later

export const SERVICE_TYPE_MESH = "_pi-mesh._tcp";
export const SERVICE_TYPE_CONTROL = "_pi-mesh-control._tcp";

export type Skill =
  | "session.list"
  | "session.read"
  | "session.stream"
  | "session.steer"
  | "session.abort"
  | "process.spawn"
  | "process.stop"
  | "mesh.peers"
  | "mesh.handoff";
