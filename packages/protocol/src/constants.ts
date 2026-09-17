// SPDX-License-Identifier: GPL-3.0-or-later

export const SERVICE_TYPE_MESH = "_pi-mesh._tcp";
export const SERVICE_TYPE_CONTROL = "_pi-mesh-control._tcp";

/**
 * Convert a DNS-SD service type to the bare name bonjour-service expects.
 *
 * bonjour-service composes `_<name>._<protocol>` itself, so handing it the
 * DNS-SD form produces `__pi-mesh-control._tcp._tcp`, a record no browser can
 * find. Always pass this to publish() and find().
 */
export function toBonjourServiceName(serviceType: string): string {
  return serviceType.replace(/^_/, "").replace(/\._(tcp|udp)$/, "");
}

/**
 * Drop TXT entries whose value is the empty string.
 *
 * mDNS TXT attributes are unordered `key=value` strings with no separate value
 * concept, so an empty value goes on the wire as `key=`. Parsers then disagree:
 * bonjour-service drops such an entry from a locally-published record, and
 * returns a key literally named `caps=` when it arrives from the wire. Either
 * way `txt.caps` is undefined. Omit the key instead; a missing key means the
 * same thing to a reader.
 */
export function withoutEmptyTxtValues(
  record: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== ""),
  );
}

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
 * The pinned A2A revision pi-mesh targets, recorded as a COMMIT rather than a
 * URL. The specification site's `/latest` page moves, so citing it would make
 * "conformant with A2A 1.0" unfalsifiable. `spec/a2a.proto` is a verbatim copy
 * of the file at this commit and is what the conformance test reads; see
 * `spec/PROVENANCE.md`.
 */
export const A2A_SOURCE = {
  repository: "https://github.com/a2aproject/A2A",
  tag: "v1.0.1",
  commit: "3303592588e388e62e0f69f701af531d2f4e3991",
  specFile: "specification/a2a.proto",
  sha256: "e195bf96ab630c69797851970203e1b2b6b19528f2e9803b7d904b91a5104016",
} as const;

/** The A2A protocol version this source declares. */
export const A2A_PROTOCOL_VERSION = "1.0";

/** Clients MUST send this header on every request (empty implies 0.3). */
export const A2A_VERSION_HEADER = "A2A-Version";
