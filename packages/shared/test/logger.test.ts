// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/index.js";

class FakeStream {
  readonly lines: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    this.lines.push(String(chunk));
    return true;
  }
}

describe("createLogger", () => {
  const originalLevel = process.env.PI_MESH_LOG_LEVEL;

  afterEach(() => {
    if (originalLevel === undefined) {
      delete process.env.PI_MESH_LOG_LEVEL;
    } else {
      process.env.PI_MESH_LOG_LEVEL = originalLevel;
    }
  });

  it("writes structured JSON and suppresses levels below the configured level", () => {
    const stream = new FakeStream();
    const logger = createLogger({ level: "warn", name: "test", stream });

    logger.debug("hidden");
    logger.info("hidden too");
    logger.warn("visible", { requestId: 42 });
    logger.error("failed", { retryable: false });

    expect(stream.lines).toHaveLength(2);
    const warning = JSON.parse(stream.lines[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(warning).toMatchObject({
      level: "warn",
      msg: "visible",
      name: "test",
      requestId: 42,
    });
    expect(typeof warning.time).toBe("string");
    expect(Number.isNaN(Date.parse(String(warning.time)))).toBe(false);

    const error = JSON.parse(stream.lines[1] ?? "") as Record<string, unknown>;
    expect(error).toMatchObject({
      level: "error",
      msg: "failed",
      name: "test",
      retryable: false,
    });
  });

  it("uses a valid environment log level and defaults invalid values to info", () => {
    process.env.PI_MESH_LOG_LEVEL = "debug";
    const debugStream = new FakeStream();
    createLogger({ stream: debugStream }).debug("visible");
    expect(debugStream.lines).toHaveLength(1);

    process.env.PI_MESH_LOG_LEVEL = "not-a-level";
    const defaultStream = new FakeStream();
    createLogger({ stream: defaultStream }).debug("hidden");
    createLogger({ stream: defaultStream }).info("visible");
    expect(defaultStream.lines).toHaveLength(1);
  });

  it("defaults to stderr so CLI JSON on stdout stays parseable", () => {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });

    try {
      createLogger().info("to stderr");
    } finally {
      spy.mockRestore();
    }

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "")).toMatchObject({
      level: "info",
      msg: "to stderr",
    });
  });
});
