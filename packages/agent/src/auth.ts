// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createNonce,
  PI_MESH_HEADERS,
  signRequest,
  type RequestTranscriptFields,
} from "@pi-mesh/protocol";
import type { PeerIdentity } from "./identity.js";

export function signedHeaders(
  key: Uint8Array,
  identity: PeerIdentity,
  request: { method: string; path: string; body: Uint8Array | string },
): Record<string, string> {
  const fields: RequestTranscriptFields = {
    ...request,
    peerId: identity.peerId,
    nonce: createNonce(),
    timestamp: new Date().toISOString(),
  };
  return {
    [PI_MESH_HEADERS.peer]: identity.peerId,
    [PI_MESH_HEADERS.nonce]: fields.nonce,
    [PI_MESH_HEADERS.timestamp]: fields.timestamp,
    [PI_MESH_HEADERS.signature]: signRequest(key, fields),
  };
}
