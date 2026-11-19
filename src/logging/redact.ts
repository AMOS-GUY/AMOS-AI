/**
 * Removes secrets and private content from anything about to be logged.
 *
 * Three layers, because any single one can miss:
 *  1. Field names that denote credentials (password, token, apiKey, authorization…) → "[REDACTED]".
 *  2. Field names that denote document or message content (content, body, prompt…) → only their
 *     length is logged. Logs are for troubleshooting, not a second copy of private documents.
 *  3. Known secret values (registered by the secret store) and credential-shaped strings
 *     ("Bearer …", "sk-…") are masked wherever they appear inside strings.
 */

export const REDACTED = "[REDACTED]";

// "token" must not catch usage counters (inputTokens, maxOutputTokens, tokenCount) or tokenizers,
// which AMOS logs routinely from M1.
const SENSITIVE_KEY =
  /pass(word|phrase)?$|secret|token(?!s|[-_]?count|[-_]?usage|iz)|api[-_]?key|authorization|cookie|credential|private[-_]?key/i;
// "messages" = chat history; singular "message" is usually an error/status text and stays visible.
const CONTENT_KEY =
  /^(content|contents|body|text|document|prompt|completion|messages|file[-_]?contents?)$/i;

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/**
 * Secret values shorter than this are not substring-masked: masking "abc" everywhere would mangle
 * ordinary log text. Short secrets are still protected by key-name redaction.
 */
export const MIN_MASKABLE_SECRET_LENGTH = 8;

const MAX_DEPTH = 6;

export class Redactor {
  readonly #secrets = new Set<string>();

  /** Register a secret value so it is masked if it ever appears in a log string. */
  addSecret(value: string): void {
    if (value.length >= MIN_MASKABLE_SECRET_LENGTH) this.#secrets.add(value);
  }

  redactString(input: string): string {
    let out = input;
    // Longest first, so a secret containing another secret is fully masked.
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    for (const pattern of CREDENTIAL_PATTERNS) out = out.replace(pattern, REDACTED);
    return out;
  }

  /** Deep-copy `value` into a JSON-safe, redacted form. Never mutates the input. */
  redactValue(value: unknown): unknown {
    return this.#walk(value, 0, new WeakSet());
  }

  #walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.redactString(value);
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    if (depth >= MAX_DEPTH) return "[Truncated]";
    seen.add(value);

    if (value instanceof Error) return this.#error(value, depth, seen);
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((v) => this.#walk(v, depth + 1, seen));

    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) out[key] = REDACTED;
      else if (CONTENT_KEY.test(key)) out[key] = describeOmitted(v);
      else out[key] = this.#walk(v, depth + 1, seen);
    }
    return out;
  }

  #error(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: error.name,
      message: this.redactString(error.message),
    };
    const extra = error as Error & { code?: unknown; hint?: unknown; details?: unknown };
    if (typeof extra.code === "string") out["code"] = extra.code;
    if (typeof extra.hint === "string") out["hint"] = this.redactString(extra.hint);
    if (extra.details !== undefined) out["details"] = this.#walk(extra.details, depth + 1, seen);
    if (error.stack) out["stack"] = this.redactString(error.stack);
    if (error.cause !== undefined) out["cause"] = this.#walk(error.cause, depth + 1, seen);
    return out;
  }
}

function describeOmitted(value: unknown): string {
  if (typeof value === "string") return `[omitted ${value.length} chars]`;
  if (Array.isArray(value)) return `[omitted ${value.length} items]`;
  return "[omitted]";
}
