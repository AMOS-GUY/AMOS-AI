import fs from "node:fs";
import { AmosError } from "../core/errors.ts";
import type { Redactor } from "../logging/redact.ts";

/**
 * Secret loading (docs/ARCHITECTURE.md §8 "Secrets").
 *
 * Sources, highest precedence first:
 *   1. Process environment (e.g. systemd `Environment=` or a shell export for one run).
 *   2. `secrets.env` in the config directory — KEY=VALUE lines, must be private to the owner.
 *
 * Values are only handed out by name, and every value handed out is registered with the log
 * redactor first so it cannot leak into logs.
 */

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse dotenv-style text. Errors cite the line number, never the line's content. */
export function parseEnvFile(text: string, source = "secrets.env"): Map<string, string> {
  const values = new Map<string, string>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;
    const body = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const eq = body.indexOf("=");
    const key = eq === -1 ? "" : body.slice(0, eq).trim();
    if (eq === -1 || !KEY.test(key)) {
      throw new AmosError("SECRET_FILE_INVALID", `${source} line ${index + 1} is not KEY=VALUE.`, {
        details: { line: index + 1 },
        hint: "Each line must look like NAME=value. Lines starting with # are comments.",
      });
    }
    values.set(key, unquote(body.slice(eq + 1).trim(), source, index + 1));
  });
  return values;
}

function unquote(value: string, source: string, line: number): string {
  const first = value[0];
  if (first === '"' || first === "'") {
    if (value.length < 2 || value[value.length - 1] !== first) {
      throw new AmosError("SECRET_FILE_INVALID", `${source} line ${line} has an unclosed quote.`, {
        details: { line },
      });
    }
    return value.slice(1, -1);
  }
  // Unquoted: allow trailing " # comment".
  const hash = value.indexOf(" #");
  return hash === -1 ? value : value.slice(0, hash).trimEnd();
}

export interface FileStatLike {
  readonly mode: number;
  readonly uid: number;
}

/**
 * On POSIX systems the secrets file must be owned by the current user and not readable or
 * writable by group/others — the same rule ssh applies to private keys. Windows uses ACLs instead
 * of mode bits; Node cannot check them reliably, so the check is skipped there (documented).
 */
export function checkSecretsFilePermissions(
  stat: FileStatLike,
  platform: NodeJS.Platform,
  currentUid: number | undefined,
  file: string,
): void {
  if (platform === "win32") return;
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new AmosError("SECRET_FILE_INSECURE", `${file} is not owned by the current user.`, {
      hint: `Run: chown "$USER" "${file}"`,
    });
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new AmosError(
      "SECRET_FILE_INSECURE",
      `${file} is accessible by other users (mode ${(stat.mode & 0o777).toString(8)}).`,
      { hint: `Run: chmod 600 "${file}"` },
    );
  }
}

export class SecretStore {
  readonly #fileValues: ReadonlyMap<string, string>;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #redactor: Redactor;
  readonly fileLoaded: boolean;

  constructor(
    fileValues: ReadonlyMap<string, string>,
    env: Readonly<Record<string, string | undefined>>,
    redactor: Redactor,
    fileLoaded: boolean,
  ) {
    this.#fileValues = fileValues;
    this.#env = env;
    this.#redactor = redactor;
    this.fileLoaded = fileLoaded;
    // Anything in the secrets file is a secret even if never requested.
    for (const value of fileValues.values()) redactor.addSecret(value);
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  get(name: string): string | undefined {
    const fromEnv = this.#env[name];
    const value = fromEnv !== undefined && fromEnv !== "" ? fromEnv : this.#fileValues.get(name);
    if (value !== undefined) this.#redactor.addSecret(value);
    return value;
  }

  require(name: string): string {
    const value = this.get(name);
    if (value === undefined) {
      throw new AmosError("SECRET_MISSING", `Secret ${name} is not set.`, {
        details: { name },
        hint: `Add ${name}=... to secrets.env, or export ${name} in the environment.`,
      });
    }
    return value;
  }

  /** Names available from the file (values are never listed). */
  fileKeyNames(): string[] {
    return [...this.#fileValues.keys()].sort();
  }
}

export interface LoadSecretsOptions {
  readonly file: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly redactor: Redactor;
}

export function loadSecrets({ file, env, platform, redactor }: LoadSecretsOptions): SecretStore {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new SecretStore(new Map(), env, redactor, false);
    }
    throw new AmosError("SECRET_FILE_INVALID", `Cannot read ${file}.`, { cause: error });
  }
  if (!stat.isFile()) {
    throw new AmosError("SECRET_FILE_INVALID", `${file} is not a regular file.`);
  }
  checkSecretsFilePermissions(stat, platform, process.getuid?.(), file);
  const values = parseEnvFile(fs.readFileSync(file, "utf8"), file);
  return new SecretStore(values, env, redactor, true);
}
