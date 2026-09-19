// SPDX-License-Identifier: GPL-3.0-or-later

import Bonjour from "bonjour-service";
import {
  SERVICE_TYPE_CONTROL,
  TXT_KEY_API_VERSION,
  TXT_KEY_ID,
  TXT_KEY_NAME,
  TXT_KEY_PORT,
  TXT_KEY_VERSION,
  toBonjourServiceName,
  withoutEmptyTxtValues,
} from "@pi-mesh/protocol";

export {
  SERVICE_TYPE_CONTROL,
  TXT_KEY_API_VERSION,
  TXT_KEY_ID,
  TXT_KEY_NAME,
  TXT_KEY_PORT,
  TXT_KEY_VERSION,
  toBonjourServiceName,
  withoutEmptyTxtValues,
};

export interface ControlPlaneService {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  port: number;
}

export interface BonjourPublishOptions {
  type: string;
  name: string;
  port: number;
  txt: Record<string, string>;
}

export interface BonjourLike {
  publish(options: BonjourPublishOptions): unknown;
  destroy(): void | PromiseLike<void>;
}

export function buildControlTxtRecord(
  service: ControlPlaneService,
): Record<string, string> {
  return withoutEmptyTxtValues({
    [TXT_KEY_ID]: service.id,
    [TXT_KEY_NAME]: service.name,
    [TXT_KEY_VERSION]: service.version,
    [TXT_KEY_API_VERSION]: service.apiVersion,
    [TXT_KEY_PORT]: String(service.port),
  });
}

export async function publishControlPlane(
  service: ControlPlaneService,
  options?: { bonjour?: BonjourLike },
): Promise<{ stop: () => Promise<void> }> {
  const bonjour: BonjourLike = options?.bonjour ?? new Bonjour();
  bonjour.publish({
    // bonjour-service composes `_<name>._<protocol>` itself; passing the
    // DNS-SD form here would publish `__pi-mesh-control._tcp._tcp`.
    type: toBonjourServiceName(SERVICE_TYPE_CONTROL),
    name: service.name,
    port: service.port,
    txt: buildControlTxtRecord(service),
  });

  return {
    stop: async () => {
      await bonjour.destroy();
    },
  };
}
