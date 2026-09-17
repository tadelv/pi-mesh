// SPDX-License-Identifier: GPL-3.0-or-later

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Minimal sink so tests and callers can pass any line-oriented writer. */
export interface LogSink {
  write(chunk: string): unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  name?: string;
  stream?: LogSink;
}

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isLogLevel(value: string | undefined): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

export function createLogger(options?: LoggerOptions): Logger {
  const configuredLevel = options?.level ?? process.env.PI_MESH_LOG_LEVEL;
  const minimumLevel: LogLevel = isLogLevel(configuredLevel) ? configuredLevel : "info";
  // stderr, not stdout: CLI commands print machine-readable JSON on stdout.
  const stream = options?.stream ?? process.stderr;
  const name = options?.name;

  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_VALUES[level] < LEVEL_VALUES[minimumLevel]) {
      return;
    }

    // fields first: callers cannot clobber the reserved keys.
    const record: Record<string, unknown> = {
      ...fields,
      level,
      time: new Date().toISOString(),
      msg,
      ...(name === undefined ? {} : { name }),
    };
    stream.write(`${JSON.stringify(record)}\n`);
  };

  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}
