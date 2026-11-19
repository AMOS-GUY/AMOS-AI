import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { KNOWN_AMOS_VARIABLES } from "../config/env.ts";
import { loadConfig } from "../config/load.ts";
import type { AmosPaths } from "../config/paths.ts";
import { loadSecrets } from "../config/secrets.ts";
import { formatErrorForUser } from "../core/errors.ts";
import { Redactor } from "../logging/redact.ts";
import { sqliteCapabilities } from "../storage/sqlite.ts";

/**
 * `amos doctor`: read-only environment checks with actionable output. It never creates files,
 * changes settings or contacts the network (network checks join in M1 with the providers).
 */

export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorInputs {
  readonly paths: AmosPaths;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly nodeVersion: string;
  /** Injected so tests don't depend on what is installed on the machine. */
  readonly findTool?: (command: string, args: readonly string[]) => string | null;
}

/**
 * Oldest Node release AMOS has been tested on. Hard floor: 24.2.0 (import.meta.main); node:sqlite
 * is "release candidate" stability in Node 24, so we only claim versions we actually ran.
 * Must match package.json "engines" (checked by tests/version.test.ts).
 */
export const MIN_NODE_VERSION = "24.18.0";

export function runDoctor(inputs: DoctorInputs): CheckResult[] {
  const findTool = inputs.findTool ?? defaultFindTool;
  return [
    checkNode(inputs.nodeVersion),
    checkSqlite(),
    checkConfig(inputs),
    checkSecrets(inputs),
    ...checkDirectories(inputs.paths),
    checkUnknownVariables(inputs.env),
    checkTool("git", findTool("git", ["--version"]), "warn", "needed for coding tasks (M2)"),
    pythonCheck(findTool, inputs.platform),
    sandboxCheck(findTool, inputs.platform),
  ];
}

export function checkNode(version: string): CheckResult {
  const parsed = parseVersion(version);
  const min = parseVersion(MIN_NODE_VERSION) as readonly number[];
  return parsed && compareVersions(parsed, min) >= 0
    ? { name: "node", status: "ok", detail: version }
    : {
        name: "node",
        status: "fail",
        detail: `${version} is not supported; AMOS needs Node ${MIN_NODE_VERSION} or newer (24 LTS line).`,
      };
}

function checkSqlite(): CheckResult {
  try {
    const caps = sqliteCapabilities();
    const missing = (["fts5", "json", "strictTables"] as const).filter((k) => !caps[k]);
    return missing.length === 0
      ? {
          name: "sqlite",
          status: "ok",
          detail: `SQLite ${caps.sqliteVersion} (fts5, json, strict)`,
        }
      : {
          name: "sqlite",
          status: "fail",
          detail: `SQLite ${caps.sqliteVersion} lacks: ${missing.join(", ")}`,
        };
  } catch (error) {
    return { name: "sqlite", status: "fail", detail: `node:sqlite unusable: ${String(error)}` };
  }
}

function checkConfig({ paths, env }: DoctorInputs): CheckResult {
  try {
    const loaded = loadConfig({ configFile: paths.configFile, env });
    const source = loaded.file ?? "no config file; using defaults";
    const overrides =
      loaded.envOverrides.length > 0 ? `; env overrides: ${loaded.envOverrides.join(", ")}` : "";
    return { name: "config", status: "ok", detail: `${source}${overrides}` };
  } catch (error) {
    return { name: "config", status: "fail", detail: formatErrorForUser(error) };
  }
}

function checkSecrets({ paths, env, platform }: DoctorInputs): CheckResult {
  try {
    const store = loadSecrets({ file: paths.secretsFile, env, platform, redactor: new Redactor() });
    if (!store.fileLoaded) {
      return { name: "secrets", status: "info", detail: `no secrets file (${paths.secretsFile})` };
    }
    const note = platform === "win32" ? " (file permissions are not checked on Windows)" : "";
    return {
      name: "secrets",
      status: platform === "win32" ? "warn" : "ok",
      detail: `${store.fileKeyNames().length} entries in ${paths.secretsFile}${note}`,
    };
  } catch (error) {
    return { name: "secrets", status: "fail", detail: formatErrorForUser(error) };
  }
}

function checkDirectories(paths: AmosPaths): CheckResult[] {
  const dirs = [
    ["config dir", paths.configDir],
    ["data dir", paths.dataDir],
    ["log dir", paths.logDir],
  ] as const;
  return dirs.map(([name, dir]) => {
    if (fs.existsSync(dir)) {
      return writable(dir)
        ? { name, status: "ok", detail: dir }
        : { name, status: "fail", detail: `${dir} exists but is not writable` };
    }
    const ancestor = nearestExisting(dir);
    return ancestor && writable(ancestor)
      ? { name, status: "info", detail: `${dir} (will be created on first use)` }
      : { name, status: "fail", detail: `${dir} cannot be created (no writable parent)` };
  });
}

function checkUnknownVariables(env: DoctorInputs["env"]): CheckResult {
  const unknown = Object.keys(env).filter(
    (k) => k.startsWith("AMOS_") && !KNOWN_AMOS_VARIABLES.has(k),
  );
  return unknown.length === 0
    ? { name: "env", status: "ok", detail: "no unknown AMOS_* variables" }
    : { name: "env", status: "warn", detail: `ignored unknown variables: ${unknown.join(", ")}` };
}

function checkTool(
  name: string,
  version: string | null,
  missingStatus: CheckStatus,
  purpose: string,
): CheckResult {
  return version
    ? { name, status: "ok", detail: version }
    : { name, status: missingStatus, detail: `not found — ${purpose}` };
}

function pythonCheck(findTool: NonNullable<DoctorInputs["findTool"]>, platform: string) {
  const candidates = platform === "win32" ? ["python", "py"] : ["python3"];
  for (const cmd of candidates) {
    const v = findTool(cmd, ["--version"]);
    if (v) return checkTool("python", v, "info", "");
  }
  return checkTool("python", null, "info", "optional; used by document workers (M4)");
}

function sandboxCheck(
  findTool: NonNullable<DoctorInputs["findTool"]>,
  platform: NodeJS.Platform,
): CheckResult {
  if (platform !== "linux") {
    return {
      name: "sandbox",
      status: "info",
      detail: `bubblewrap is Linux-only; on ${platform} AMOS will use stricter approvals (M2)`,
    };
  }
  return checkTool(
    "sandbox",
    findTool("bwrap", ["--version"]),
    "warn",
    "install bubblewrap (sudo apt install bubblewrap) for command sandboxing (M2)",
  );
}

function defaultFindTool(command: string, args: readonly string[]): string | null {
  try {
    const out = execFileSync(command, args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return out.trim().split(/\r?\n/)[0] ?? command;
  } catch {
    return null;
  }
}

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function nearestExisting(dir: string): string | null {
  let current = dir;
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function parseVersion(version: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function formatResults(results: readonly CheckResult[]): string {
  const icon: Record<CheckStatus, string> = {
    ok: "ok  ",
    warn: "WARN",
    fail: "FAIL",
    info: "info",
  };
  const width = Math.max(...results.map((r) => r.name.length));
  return results.map((r) => `[${icon[r.status]}] ${r.name.padEnd(width)}  ${r.detail}`).join("\n");
}
