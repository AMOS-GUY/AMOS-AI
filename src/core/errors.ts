/**
 * One error type for failures AMOS knows how to explain.
 *
 * Every AmosError carries a stable machine-readable `code` and a human message that says what went
 * wrong and, where possible, how to fix it. Unknown errors are wrapped as INTERNAL so callers always
 * handle one shape.
 */

export const ERROR_CODES = [
  "CONFIG_INVALID",
  "CONFIG_PARSE",
  "SECRET_FILE_INSECURE",
  "SECRET_FILE_INVALID",
  "SECRET_MISSING",
  "STORAGE",
  "INSECURE_PERMISSIONS",
  "MIGRATION_FAILED",
  "INVALID_TASK_TRANSITION",
  "INVALID_ID",
  "PRIVACY_VIOLATION",
  "NETWORK",
  "NETWORK_TIMEOUT",
  "NETWORK_CANCELLED",
  "NETWORK_OFFLINE",
  "UNSUPPORTED_PLATFORM",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AmosErrorOptions {
  /** Short, actionable advice shown to the owner. */
  hint?: string;
  /** Structured, non-sensitive context for logs. Never put secrets or document contents here. */
  details?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}

export class AmosError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, options: AmosErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AmosError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details ?? {};
  }
}

export function isAmosError(value: unknown): value is AmosError {
  return value instanceof AmosError;
}

/** Wrap anything thrown into an AmosError without losing the original as `cause`. */
export function toAmosError(value: unknown): AmosError {
  if (isAmosError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new AmosError("INTERNAL", message, { cause: value });
}

/** Render an error for a terminal: message, then hint on its own line. */
export function formatErrorForUser(error: unknown): string {
  const e = toAmosError(error);
  const lines = [`error [${e.code}]: ${e.message}`];
  if (e.hint) lines.push(`hint: ${e.hint}`);
  return lines.join("\n");
}
