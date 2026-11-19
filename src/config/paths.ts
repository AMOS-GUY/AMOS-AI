import path from "node:path";
import { AmosError } from "../core/errors.ts";

/**
 * Where AMOS keeps its files on each platform (docs/ARCHITECTURE.md §4).
 *
 * This is the only module that knows platform directory conventions. It is a pure function of
 * (platform, environment, home directory) so every platform's rules are testable on any OS.
 */

export interface AmosPaths {
  readonly configDir: string;
  readonly dataDir: string;
  readonly stateDir: string;
  readonly logDir: string;
  readonly configFile: string;
  readonly secretsFile: string;
  readonly databaseFile: string;
}

export interface PathInputs {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
}

const APP = "amos";

export function resolvePaths({ platform, env, homeDir }: PathInputs): AmosPaths {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!p.isAbsolute(homeDir)) {
    throw new AmosError("UNSUPPORTED_PLATFORM", "Cannot determine an absolute home directory.", {
      details: { platform },
    });
  }

  let base: { configDir: string; dataDir: string; stateDir: string; logDir: string };
  if (platform === "win32") {
    const roaming = absoluteOr(p, env["APPDATA"], p.join(homeDir, "AppData", "Roaming"));
    const local = absoluteOr(p, env["LOCALAPPDATA"], p.join(homeDir, "AppData", "Local"));
    base = {
      configDir: p.join(roaming, APP),
      dataDir: p.join(local, APP),
      stateDir: p.join(local, APP, "state"),
      logDir: p.join(local, APP, "logs"),
    };
  } else if (platform === "darwin") {
    const support = p.join(homeDir, "Library", "Application Support", APP);
    base = {
      configDir: support,
      dataDir: support,
      stateDir: p.join(support, "state"),
      logDir: p.join(homeDir, "Library", "Logs", APP),
    };
  } else {
    // Linux and other Unix-likes follow the XDG Base Directory spec. The spec says relative
    // values must be ignored, which absoluteOr does.
    const config = absoluteOr(p, env["XDG_CONFIG_HOME"], p.join(homeDir, ".config"));
    const data = absoluteOr(p, env["XDG_DATA_HOME"], p.join(homeDir, ".local", "share"));
    const state = absoluteOr(p, env["XDG_STATE_HOME"], p.join(homeDir, ".local", "state"));
    base = {
      configDir: p.join(config, APP),
      dataDir: p.join(data, APP),
      stateDir: p.join(state, APP),
      logDir: p.join(state, APP, "logs"),
    };
  }

  // Explicit overrides (tests, portable installs). Unlike XDG values, a relative override is a
  // mistake the owner should hear about rather than have silently ignored.
  const configDir = override(p, env, "AMOS_CONFIG_DIR") ?? base.configDir;
  const dataDir = override(p, env, "AMOS_DATA_DIR") ?? base.dataDir;
  const stateDir = override(p, env, "AMOS_STATE_DIR") ?? base.stateDir;
  const logDir = env["AMOS_STATE_DIR"] ? p.join(stateDir, "logs") : base.logDir;

  return {
    configDir,
    dataDir,
    stateDir,
    logDir,
    configFile: p.join(configDir, "config.yaml"),
    secretsFile: p.join(configDir, "secrets.env"),
    databaseFile: p.join(dataDir, "amos.db"),
  };
}

function absoluteOr(p: path.PlatformPath, value: string | undefined, fallback: string): string {
  return value && p.isAbsolute(value) ? value : fallback;
}

function override(p: path.PlatformPath, env: PathInputs["env"], name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value === "") return undefined;
  if (!p.isAbsolute(value)) {
    throw new AmosError("CONFIG_INVALID", `${name} must be an absolute path.`, {
      details: { variable: name },
      hint: `Set ${name} to a full path, or unset it to use the default location.`,
    });
  }
  return p.normalize(value);
}
