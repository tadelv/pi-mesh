// SPDX-License-Identifier: GPL-3.0-or-later

export const SERVICE_TYPE_MESH = "_pi-mesh._tcp";
export const SERVICE_TYPE_CONTROL = "_pi-mesh-control._tcp";

export const AGENT_CARD_ROUTE = "/.well-known/agent-card.json";

export const TXT_KEY_ID = "id";
export const TXT_KEY_NAME = "name";
export const TXT_KEY_VERSION = "version";
export const TXT_KEY_API_VERSION = "api_version";
export const TXT_KEY_AGENT_VERSION = "agent_version";
export const TXT_KEY_PORT = "port";
export const TXT_KEY_FINGERPRINT = "fp";
export const TXT_KEY_CAPABILITIES = "caps";

export const CONTROL_TXT_KEYS = [
  TXT_KEY_ID,
  TXT_KEY_NAME,
  TXT_KEY_VERSION,
  TXT_KEY_API_VERSION,
  TXT_KEY_PORT,
  TXT_KEY_FINGERPRINT,
] as const;

export const MESH_TXT_KEYS = [
  TXT_KEY_ID,
  TXT_KEY_NAME,
  TXT_KEY_VERSION,
  TXT_KEY_AGENT_VERSION,
  TXT_KEY_PORT,
  TXT_KEY_FINGERPRINT,
  TXT_KEY_CAPABILITIES,
] as const;

export const HANDOFF_EXTENSION_URI =
  "https://pi-mesh.dev/extensions/handoff/v1";

/**
 * The A2A revision pi-mesh targets. docs/PROTOCOL.md links only the A2A site,
 * so without a pinned revision there is nothing to check wire shapes against.
 */
export const A2A_PROTOCOL_VERSION = "1.0";
