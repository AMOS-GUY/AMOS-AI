import type { LogLevel } from "../config/schema.ts";
import { Redactor } from "./redact.ts";

/**
 * Structured logger: one JSON object per record, redacted before it reaches any sink.
 *
 * Usage rule (enforced by review, helped by the redactor): log identifiers, sizes, durations and
 * outcomes — not file contents, prompts or model output.
 */

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly [field: string]: unknown;
}

export interface LogSink {
  write(record: LogRecord): void;
  close?(): void;
}

export type LogFields = Readonly<Record<string, unknown>>;

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly sinks: readonly LogSink[];
  readonly redactor?: Redactor;
  readonly bindings?: LogFields;
  readonly clock?: () => Date;
}

const RESERVED = new Set(["time", "level", "msg"]);

export class Logger {
  readonly level: LogLevel;
  readonly #sinks: readonly LogSink[];
  readonly #redactor: Redactor;
  readonly #bindings: LogFields;
  readonly #clock: () => Date;

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.#sinks = options.sinks;
    this.#redactor = options.redactor ?? new Redactor();
    this.#bindings = options.bindings ?? {};
    this.#clock = options.clock ?? (() => new Date());
  }

  /** A logger that adds `bindings` (e.g. { component: "storage" }) to every record. */
  child(bindings: LogFields): Logger {
    return new Logger({
      level: this.level,
      sinks: this.#sinks,
      redactor: this.#redactor,
      bindings: { ...this.#bindings, ...bindings },
      clock: this.#clock,
    });
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  debug(msg: string, fields?: LogFields): void {
    this.#log("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.#log("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.#log("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.#log("error", msg, fields);
  }

  #log(level: LogLevel, msg: string, fields: LogFields | undefined): void {
    if (!this.isLevelEnabled(level)) return;
    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({ ...this.#bindings, ...fields })) {
      // Callers cannot overwrite the envelope; their value is kept under a prefixed name.
      merged[RESERVED.has(key) ? `field_${key}` : key] = value;
    }
    const redacted = this.#redactor.redactValue(merged) as Record<string, unknown>;
    const record: LogRecord = {
      time: this.#clock().toISOString(),
      level,
      msg: this.#redactor.redactString(msg),
      ...redacted,
    };
    for (const sink of this.#sinks) {
      try {
        sink.write(record);
      } catch (error) {
        reportSinkFailure(error);
      }
    }
  }

  close(): void {
    for (const sink of this.#sinks) sink.close?.();
  }
}

let sinkFailureReported = false;

/** A broken sink (disk full, permissions) must never crash the program or spam stderr. */
function reportSinkFailure(error: unknown): void {
  if (sinkFailureReported) return;
  sinkFailureReported = true;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`amos: a log destination failed and will be skipped: ${message}\n`);
}

/** Collects records in memory; for tests and for `amos doctor` output. */
export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
}

/** JSON lines to a stream (stderr by default, which journald captures under systemd). */
export class StreamSink implements LogSink {
  readonly #stream: NodeJS.WritableStream;
  constructor(stream: NodeJS.WritableStream = process.stderr) {
    this.#stream = stream;
  }
  write(record: LogRecord): void {
    this.#stream.write(`${JSON.stringify(record)}\n`);
  }
}
