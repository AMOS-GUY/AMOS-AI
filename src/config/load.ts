import fs from "node:fs";
import { parseDocument } from "yaml";
import type { z } from "zod";
import { AmosError } from "../core/errors.ts";
import { readEnvOverrides } from "./env.ts";
import { type AmosConfig, configSchema } from "./schema.ts";

/**
 * Layered configuration: built-in defaults < config.yaml < AMOS_* environment variables.
 * Secrets are a separate layer (secrets.ts) and are never part of AmosConfig.
 */

export interface LoadedConfig {
  readonly config: AmosConfig;
  /** The config file that was read, or null if none exists (defaults used). */
  readonly file: string | null;
  /** Environment variables that overrode a setting. */
  readonly envOverrides: readonly string[];
}

export interface LoadConfigOptions {
  readonly configFile: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function loadConfig({ configFile, env }: LoadConfigOptions): LoadedConfig {
  const text = readOptional(configFile);
  const fromFile = text === null ? {} : parseYamlConfig(text, configFile);
  const overrides = readEnvOverrides(env);
  const merged = deepMerge(fromFile, overrides.values);
  return {
    config: validateConfig(merged, text === null ? "defaults" : configFile),
    file: text === null ? null : configFile,
    envOverrides: overrides.applied,
  };
}

function readOptional(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AmosError("CONFIG_PARSE", `Cannot read config file ${file}.`, { cause: error });
  }
}

export function parseYamlConfig(text: string, source: string): Record<string, unknown> {
  const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  const first = doc.errors[0];
  if (first) {
    const pos = first.linePos?.[0];
    const where = pos ? ` at line ${pos.line}, column ${pos.col}` : "";
    throw new AmosError("CONFIG_PARSE", `${source} is not valid YAML${where}: ${first.code}.`, {
      hint: "Check indentation (spaces, not tabs) and that each key appears once.",
      details: pos ? { line: pos.line, column: pos.col } : {},
    });
  }
  const value: unknown = doc.toJS();
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AmosError("CONFIG_INVALID", `${source} must contain a mapping of settings.`);
  }
  return value as Record<string, unknown>;
}

const SECRET_LIKE_KEY = /^(api[-_]?key|apikey|token|secret|password|access[-_]?key)$/i;

/** Validate a raw config object, producing an owner-readable error listing every problem. */
export function validateConfig(raw: unknown, source: string): AmosConfig {
  const secretPaths = findSecretLikeKeys(raw);
  if (secretPaths.length > 0) {
    throw new AmosError(
      "CONFIG_INVALID",
      `${source} contains secret values (${secretPaths.join(", ")}). Secrets are not allowed in config files.`,
      {
        hint: "Put the key in secrets.env (e.g. DEEPSEEK_API_KEY=...) and reference it with apiKeyEnv: DEEPSEEK_API_KEY.",
        details: { paths: secretPaths },
      },
    );
  }
  const removed = findRemovedSettings(raw);
  if (removed.length > 0) {
    throw new AmosError(
      "CONFIG_INVALID",
      `${source} uses removed settings:\n${removed.map((r) => `  - ${r}`).join("\n")}`,
      { hint: "Remove or rename these settings; see config/config.example.yaml." },
    );
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const problems = formatIssues(result.error.issues);
    throw new AmosError("CONFIG_INVALID", `Invalid configuration in ${source}:\n${problems}`, {
      details: { issues: result.error.issues.length },
      hint: "See config/config.example.yaml for the accepted settings.",
    });
  }
  return result.data;
}

/** Settings that existed in an earlier version, with what replaced them. */
const REMOVED_SETTINGS: ReadonlyArray<readonly [path: readonly string[], explanation: string]> = [
  [
    ["network", "connectTimeoutMs"],
    "network.connectTimeoutMs was removed in M0.1: it could not be enforced. Use network.headersTimeoutMs (covers DNS, connect and TLS).",
  ],
];

function findRemovedSettings(raw: unknown): string[] {
  return REMOVED_SETTINGS.filter(([keys]) => {
    let node: unknown = raw;
    for (const key of keys) {
      if (node === null || typeof node !== "object" || !(key in node)) return false;
      node = (node as Record<string, unknown>)[key];
    }
    return true;
  }).map(([, explanation]) => explanation);
}

export function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.map(String).join(".") : "(top level)";
      return `  - ${where}: ${issue.message}`;
    })
    .join("\n");
}

function findSecretLikeKeys(value: unknown, path: string[] = []): string[] {
  if (value === null || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = [...path, key];
    if (SECRET_LIKE_KEY.test(key)) found.push(here.join("."));
    found.push(...findSecretLikeKeys(child, here));
  }
  return found;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Merge `override` into `base`; objects merge recursively, everything else is replaced. */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}
