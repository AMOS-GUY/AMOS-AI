import fs from "node:fs";
import path from "node:path";
import type { LogRecord, LogSink } from "./logger.ts";

/**
 * Append-only JSON-lines log file with size-based rotation:
 *   amos.log → amos.log.1 → … → amos.log.<maxFiles-1> → deleted.
 *
 * Writes are synchronous: log volume is low, and synchronous appends mean the last records before a
 * crash are on disk. Files are created owner-only (0600) because logs contain paths and task names.
 */

export interface FileSinkOptions {
  readonly dir: string;
  readonly fileName?: string;
  readonly maxBytes: number;
  /** Total number of files kept, including the active one. */
  readonly maxFiles: number;
}

export class FileSink implements LogSink {
  readonly file: string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #dir: string;
  #size: number | undefined;

  /** Touches nothing on disk until the first record is written. */
  constructor({ dir, fileName = "amos.log", maxBytes, maxFiles }: FileSinkOptions) {
    this.#dir = dir;
    this.file = path.join(dir, fileName);
    this.#maxBytes = maxBytes;
    this.#maxFiles = maxFiles;
  }

  write(record: LogRecord): void {
    if (this.#size === undefined) {
      fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      this.#size = fileSize(this.file);
    }
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.#size > 0 && this.#size + bytes > this.#maxBytes) this.#rotate();
    fs.appendFileSync(this.file, line, { mode: 0o600 });
    this.#size += bytes;
  }

  #rotate(): void {
    const oldest = `${this.file}.${this.#maxFiles - 1}`;
    if (this.#maxFiles <= 1) {
      fs.rmSync(this.file, { force: true });
    } else {
      fs.rmSync(oldest, { force: true });
      for (let i = this.#maxFiles - 2; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
      }
      fs.renameSync(this.file, `${this.file}.1`);
    }
    this.#size = 0;
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
