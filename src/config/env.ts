import { AmosError } from "../core/errors.ts";
import { LOG_LEVELS } from "./schema.ts";

/**
 * Runtime environment-variable overrides. Only the variables listed here are read; anything else
 * named AMOS_* is ignored (and reported by `amos doctor`) rather than guessed at.
 *
 * Path variables (AMOS_CONFIG_DIR, …) are handled in paths.ts; secrets are read by secrets.ts.
 */

export const ENV_OVERRIDES = {
  AMOS_LOG_LEVEL: "logging.level",
  AMOS_LOG_FILE: "logging.file.enabled",
  AMOS_OFFLINE: "network.offline",
  AMOS_PORT: "server.port",
} as const;

export const KNOWN_AMOS_VARIABLES: ReadonlySet<string> = new Set([
  ...Object.keys(ENV_OVERRIDES),
  "AMOS_CONFIG_DIR",
  "AMOS_DATA_DIR",
  "AMOS_STATE_DIR",
]);

export interface EnvOverrides {
  readonly values: Record<string, unknown>;
  readonly applied: readonly string[];
}

export function readEnvOverrides(env: Readonly<Record<string, string | undefined>>): EnvOverrides {
  const values: Record<string, unknown> = {};
  const applied: string[] = [];

  const set = (dotted: string, value: unknown) => {
    const keys = dotted.split(".");
    let node = values;
    for (const key of keys.slice(0, -1)) {
      if (node[key] === undefined) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[keys[keys.length - 1] as string] = value;
  };

  for (const [name, target] of Object.entries(ENV_OVERRIDES)) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    applied.push(name);
    switch (name) {
      case "AMOS_LOG_LEVEL": {
        const level = raw.toLowerCase();
        if (!(LOG_LEVELS as readonly string[]).includes(level)) {
          throw invalid(name, `must be one of ${LOG_LEVELS.join(", ")}`);
        }
        set(target, level);
        break;
      }
      case "AMOS_PORT": {
        if (!/^\d+$/.test(raw)) throw invalid(name, "must be a whole number");
        set(target, Number(raw));
        break;
      }
      default:
        set(target, parseBoolean(name, raw));
    }
  }
  return { values, applied };
}

function parseBoolean(name: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw invalid(name, "must be true/false (also accepted: 1/0, yes/no, on/off)");
}

function invalid(name: string, rule: string): AmosError {
  // The value itself is not echoed: env vars sometimes hold secrets by mistake.
  return new AmosError("CONFIG_INVALID", `Environment variable ${name} ${rule}.`, {
    details: { variable: name },
    hint: `Fix or unset ${name}.`,
  });
}
