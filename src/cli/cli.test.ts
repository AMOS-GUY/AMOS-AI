import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Capture, isWindows, tempDir } from "../../tests/helpers.ts";
import { resolvePaths } from "../config/paths.ts";
import type { RuntimeInputs } from "../runtime.ts";
import { checkNode, formatResults, runDoctor } from "./doctor.ts";
import { runCli } from "./main.ts";

function sandbox(extraEnv: Record<string, string> = {}) {
  const root = tempDir();
  const env = {
    AMOS_CONFIG_DIR: path.join(root, "config"),
    AMOS_DATA_DIR: path.join(root, "data"),
    AMOS_STATE_DIR: path.join(root, "state"),
    ...extraEnv,
  };
  const inputs: RuntimeInputs = { env, platform: process.platform, homeDir: root };
  return { root, env, inputs };
}

function run(argv: string[], inputs: RuntimeInputs) {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = runCli(argv, inputs, { stdout: stdout as never, stderr: stderr as never });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe("amos CLI", () => {
  it("prints help and version", () => {
    const { inputs } = sandbox();
    expect(run([], inputs).stdout).toContain("Usage:");
    expect(run(["version"], inputs)).toMatchObject({ code: 0, stdout: "0.0.0\n" });
  });

  it("exits 2 on unknown commands and flags", () => {
    const { inputs } = sandbox();
    expect(run(["frobnicate"], inputs).code).toBe(2);
    expect(run(["doctor", "--nope"], inputs).code).toBe(2);
  });

  it("prints paths as JSON", () => {
    const { inputs, env } = sandbox();
    const out = JSON.parse(run(["paths", "--json"], inputs).stdout);
    expect(out.configFile).toBe(path.join(env.AMOS_CONFIG_DIR, "config.yaml"));
  });

  it("shows effective config and secret names, never secret values, and creates no files", () => {
    const { inputs, env, root } = sandbox();
    fs.mkdirSync(env.AMOS_CONFIG_DIR);
    fs.writeFileSync(path.join(env.AMOS_CONFIG_DIR, "config.yaml"), "logging:\n  level: warn\n");
    fs.writeFileSync(
      path.join(env.AMOS_CONFIG_DIR, "secrets.env"),
      "DEEPSEEK_API_KEY=value-that-must-not-print\n",
      {
        mode: 0o600,
      },
    );
    const before = listTree(root);
    const result = run(["config", "show"], inputs);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("level: warn");
    expect(result.stdout).toContain("DEEPSEEK_API_KEY");
    expect(result.stdout).not.toContain("value-that-must-not-print");
    expect(listTree(root)).toEqual(before);
  });

  it("reports invalid config clearly with exit code 1", () => {
    const { inputs, env } = sandbox();
    fs.mkdirSync(env.AMOS_CONFIG_DIR);
    fs.writeFileSync(path.join(env.AMOS_CONFIG_DIR, "config.yaml"), "server:\n  host: 0.0.0.0\n");
    const result = run(["config", "show"], inputs);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error [CONFIG_INVALID]");
    expect(result.stderr).toContain("server.host");
  });

  it("doctor passes on a clean sandbox and creates nothing", () => {
    const { inputs, root } = sandbox();
    const before = listTree(root);
    const result = run(["doctor", "--json"], inputs);
    const checks = JSON.parse(result.stdout) as { name: string; status: string }[];
    expect(result.code).toBe(0);
    expect(checks.find((c) => c.name === "sqlite")?.status).toBe("ok");
    expect(checks.find((c) => c.name === "config")?.status).toBe("ok");
    expect(listTree(root)).toEqual(before);
  });

  it("doctor fails (exit 1) on broken config and flags unknown AMOS_ variables", () => {
    const { inputs, env } = sandbox({ AMOS_LOGLEVEL: "debug" });
    fs.mkdirSync(env.AMOS_CONFIG_DIR);
    fs.writeFileSync(path.join(env.AMOS_CONFIG_DIR, "config.yaml"), "nonsense: true\n");
    const result = run(["doctor"], inputs);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/\[FAIL\] config/);
    expect(result.stdout).toMatch(/\[WARN\] env .*AMOS_LOGLEVEL/);
  });

  it.skipIf(isWindows)("doctor fails on an insecure secrets file", () => {
    const { inputs, env } = sandbox();
    fs.mkdirSync(env.AMOS_CONFIG_DIR);
    const file = path.join(env.AMOS_CONFIG_DIR, "secrets.env");
    fs.writeFileSync(file, "A=b\n");
    fs.chmodSync(file, 0o644);
    const result = run(["doctor"], inputs);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("chmod 600");
  });
});

describe("doctor checks", () => {
  it("requires the tested Node 24 minimum", () => {
    expect(checkNode("v24.18.0").status).toBe("ok");
    expect(checkNode("v24.22.1").status).toBe("ok");
    expect(checkNode("v26.1.0").status).toBe("ok");
    expect(checkNode("v24.17.9").status).toBe("fail");
    expect(checkNode("v24.2.0").status).toBe("fail");
    expect(checkNode("v22.12.0").status).toBe("fail");
    expect(checkNode("garbage").status).toBe("fail");
  });

  it("reports missing optional tools as warnings/info, not failures", () => {
    const { env, root } = sandbox();
    const results = runDoctor({
      paths: resolvePaths({ platform: process.platform, env, homeDir: root }),
      env,
      platform: "linux",
      nodeVersion: "v24.18.0",
      findTool: () => null,
    });
    const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));
    expect(byName["git"]).toBe("warn");
    expect(byName["sandbox"]).toBe("warn");
    expect(byName["python"]).toBe("info");
    expect(results.some((r) => r.status === "fail")).toBe(false);
    expect(formatResults(results)).toContain("[WARN] sandbox");
  });
});

function listTree(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

describe("amos help and argument validation (M0.1)", () => {
  it.each([
    [["doctor", "--help"], "Usage: amos doctor"],
    [["doctor", "-h"], "Usage: amos doctor"],
    [["--help", "doctor"], "Usage: amos doctor"],
    [["help", "doctor"], "Usage: amos doctor"],
    [["doctor", "--json", "--help"], "Usage: amos doctor"],
    [["config", "show", "--help"], "Usage: amos config show"],
    [["help", "config", "show"], "Usage: amos config show"],
    [["paths", "-h"], "Usage: amos paths"],
    [["--help"], "Usage:\n  amos doctor"],
    [["-h"], "Usage:\n  amos doctor"],
    [["help"], "Usage:\n  amos doctor"],
  ])("`amos %s` prints help and does not run the command", (argv, expected) => {
    const { inputs, root } = sandbox({ AMOS_LOGLEVEL: "would-warn-if-doctor-ran" });
    const before = listTree(root);
    const result = run(argv, inputs);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(expected);
    expect(result.stdout).not.toMatch(/\[(ok|WARN|FAIL|info)\s*\]/); // no doctor output
    expect(listTree(root)).toEqual(before);
  });

  it("rejects help for unknown commands", () => {
    const { inputs } = sandbox();
    const result = run(["frobnicate", "--help"], inputs);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("No help for unknown command: frobnicate");
  });

  it("rejects --json where it is not supported instead of ignoring it", () => {
    const { inputs } = sandbox();
    expect(run(["version", "--json"], inputs)).toMatchObject({ code: 2 });
    expect(run(["config", "show", "--json"], inputs).stderr).toContain("does not support --json");
  });

  it("rejects extra arguments and incomplete commands", () => {
    const { inputs } = sandbox();
    expect(run(["doctor", "now"], inputs).stderr).toContain("Unexpected argument: now");
    const config = run(["config"], inputs);
    expect(config.code).toBe(2);
    expect(config.stderr).toContain("Did you mean: amos config show");
    expect(run(["config", "edit"], inputs).code).toBe(2);
  });

  it("has a handler for every documented command", () => {
    const { inputs } = sandbox();
    for (const argv of [["doctor"], ["paths"], ["config", "show"], ["version"]]) {
      expect(run(argv, inputs).code, argv.join(" ")).not.toBe(70);
    }
  });
});
