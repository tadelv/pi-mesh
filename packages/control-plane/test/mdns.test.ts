// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  buildControlTxtRecord,
  publishControlPlane,
  SERVICE_TYPE_CONTROL,
  TXT_KEY_API_VERSION,
  TXT_KEY_ID,
  TXT_KEY_NAME,
  TXT_KEY_PORT,
  TXT_KEY_VERSION,
  type ControlPlaneService,
  type BonjourLike,
} from "../src/index.js";

const service: ControlPlaneService = {
  id: "control-1",
  name: "Control Plane",
  version: "0.0.0",
  apiVersion: "1",
  port: 7444,
};

function fakeBonjour() {
  let published: unknown;
  let destroyed = false;
  const bonjour: BonjourLike = {
    publish(options) {
      published = options;
      return undefined;
    },
    destroy() {
      destroyed = true;
    },
  };
  return { bonjour, published: () => published, destroyed: () => destroyed };
}

describe("control-plane mDNS", () => {
  it("builds exactly the documented control-plane TXT record", () => {
    expect(buildControlTxtRecord(service)).toEqual({
      [TXT_KEY_ID]: "control-1",
      [TXT_KEY_NAME]: "Control Plane",
      [TXT_KEY_VERSION]: "0.0.0",
      [TXT_KEY_API_VERSION]: "1",
      [TXT_KEY_PORT]: "7444",
    });
    expect(Object.keys(buildControlTxtRecord(service)).sort()).toEqual(
      [
        TXT_KEY_API_VERSION,
        TXT_KEY_ID,
        TXT_KEY_NAME,
        TXT_KEY_PORT,
        TXT_KEY_VERSION,
      ].sort(),
    );
  });

  it("publishes under the bare service name bonjour-service expects", async () => {
    const fake = fakeBonjour();
    const handle = await publishControlPlane(service, {
      bonjour: fake.bonjour,
    });
    const published = fake.published() as {
      type: string;
      txt: Record<string, string>;
    };

    // Assert the bare name, not our own SERVICE_TYPE_CONTROL constant: echoing
    // the constant would pass even while the publisher wrote
    // `__pi-mesh-control._tcp._tcp`, which no browser can ever find.
    expect(published.type).toBe("pi-mesh-control");
    expect(`_${published.type}._tcp`).toBe(SERVICE_TYPE_CONTROL);
    expect(published.txt).toEqual(buildControlTxtRecord(service));

    await handle.stop();
    expect(fake.destroyed()).toBe(true);
  });
});
