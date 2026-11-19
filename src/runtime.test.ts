import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Capture, tempDir } from "../tests/helpers.ts";
import { REDACTED } from "./logging/redact.ts";
import { createRuntime } from "./runtime.ts";

function sandbox() {
  const root = tempDir();
  const env = {
    AMOS_CONFIG_DIR: path.join(root, "config"),
    AMOS_DATA_DIR: path.join(root, "data"),
    AMOS_STATE_DIR: path.join(root, "state"),
  };
  fs.mkdirSync(env.AMOS_CONFIG_DIR);
  return { root, env };
}

describe("createRuntime", () => {
  it("wires config, secrets and logging so secret values never reach log output", () => {
    const { env } = sandbox();
    fs.writeFileSync(path.join(env.AMOS_CONFIG_DIR, "config.yaml"), "logging:\n  level: debug\n");
    fs.writeFileSync(
      path.join(env.AMOS_CONFIG_DIR, "secrets.env"),
      "MODEL_KEY=runtime-secret-0001\n",
      {
        mode: 0o600,
      },
    );
    const consoleOut = new Capture();
    const rt = createRuntime({
      env,
      platform: process.platform,
      homeDir: path.dirname(env.AMOS_CONFIG_DIR),
      consoleStream: consoleOut as never,
    });
    expect(rt.loaded.config.logging.level).toBe("debug");
    expect(rt.secrets.require("MODEL_KEY")).toBe("runtime-secret-0001");

    rt.logger.debug("using key runtime-secret-0001", { component: "test" });
    rt.logger.close();

    const fileText = fs.readFileSync(path.join(env.AMOS_STATE_DIR, "logs", "amos.log"), "utf8");
    for (const text of [consoleOut.text, fileText]) {
      expect(text).toContain(`using key ${REDACTED}`);
      expect(text).not.toContain("runtime-secret-0001");
      expect(JSON.parse(text.trim())).toMatchObject({ level: "debug", component: "test" });
    }
  });

  it("respects logging.file.enabled = false and a null console", () => {
    const { env } = sandbox();
    const rt = createRuntime({
      env: { ...env, AMOS_LOG_FILE: "off" },
      platform: process.platform,
      homeDir: path.dirname(env.AMOS_CONFIG_DIR),
      consoleStream: null,
    });
    rt.logger.error("nowhere to go");
    expect(fs.existsSync(path.join(env.AMOS_STATE_DIR, "logs"))).toBe(false);
  });

  it("fails fast on invalid configuration", () => {
    const { env } = sandbox();
    fs.writeFileSync(
      path.join(env.AMOS_CONFIG_DIR, "config.yaml"),
      "network:\n  offline: sometimes\n",
    );
    expect(() =>
      createRuntime({
        env,
        platform: process.platform,
        homeDir: path.dirname(env.AMOS_CONFIG_DIR),
        consoleStream: null,
      }),
    ).toThrow(/network\.offline/);
  });
});
