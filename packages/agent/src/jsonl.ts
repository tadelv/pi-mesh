// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile } from "node:fs/promises";

/** Incrementally splits JSONL records on LF, and only on LF. */
export class JsonlDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  push(chunk: string | Uint8Array): string[] {
    if (typeof chunk === "string") {
      // Flush a possible split UTF-8 code point before accepting text chunks.
      this.buffer += this.decoder.decode();
      this.buffer += chunk;
    } else {
      this.buffer += this.decoder.decode(chunk, { stream: true });
    }

    const records: string[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      let record = this.buffer.slice(0, newline);
      if (record.endsWith("\r")) record = record.slice(0, -1);
      records.push(record);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
    }
    return records;
  }

  /** Discards an unterminated final record; it is not a JSONL record yet. */
  finish(): string[] {
    this.buffer += this.decoder.decode();
    return [];
  }

  get pending(): string {
    return this.buffer;
  }
}

/** Decode a complete JSONL document, including a final line without LF. */
export function decodeJsonl(content: string | Uint8Array): string[] {
  const decoder = new JsonlDecoder();
  const records = decoder.push(content);
  if (decoder.pending.length > 0) {
    records.push(...decoder.push("\n"));
  }
  return records;
}

export async function readJsonl(filePath: string): Promise<string[]> {
  return decodeJsonl(await readFile(filePath));
}
