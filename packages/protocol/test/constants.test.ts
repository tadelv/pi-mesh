// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  SERVICE_TYPE_CONTROL,
  SERVICE_TYPE_MESH,
  toBonjourServiceName,
  withoutEmptyTxtValues,
} from "../src/index.js";

describe("discovery constants", () => {
  it("keeps the DNS-SD service types from docs/PROTOCOL.md", () => {
    expect(SERVICE_TYPE_MESH).toBe("_pi-mesh._tcp");
    expect(SERVICE_TYPE_CONTROL).toBe("_pi-mesh-control._tcp");
  });

  it("strips the DNS-SD framing for bonjour-service", () => {
    expect(toBonjourServiceName(SERVICE_TYPE_CONTROL)).toBe("pi-mesh-control");
    expect(toBonjourServiceName(SERVICE_TYPE_MESH)).toBe("pi-mesh");
  });

  it("round-trips back to the exact service type", () => {
    // bonjour-service builds `_<name>._<protocol>` from the bare name. If that
    // recomposition does not reproduce the advertised type, the publisher is
    // writing a record that browsers will never match - which is precisely the
    // bug this helper exists to prevent.
    for (const serviceType of [SERVICE_TYPE_MESH, SERVICE_TYPE_CONTROL]) {
      expect(`_${toBonjourServiceName(serviceType)}._tcp`).toBe(serviceType);
    }
  });

  it("drops empty TXT values instead of emitting a bare key", () => {
    expect(
      withoutEmptyTxtValues({ id: "a", caps: "", fp: "x", name: "" }),
    ).toEqual({ id: "a", fp: "x" });
  });
});
