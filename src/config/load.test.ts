import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../tests/helpers.ts";
import { AmosError } from "../core/errors.ts";
import { readEnvOverrides } from "./env.ts";
import { deepMerge, loadConfig, parseYamlConfig, validateConfig } from "./load.ts";
import { defaultConfig } from "./schema.ts";

function writeConfig(text: string): string {
  const file = path.join(tempDir(), "config.yaml");
  fs.writeFileSync(file, text);
  return file;
}

function expectConfigError(fn: () => unknown, code: string, ...fragments: string[]): void {
  try {
    fn();
    expect.unreachable("expected a config error");
  } catch (error) {
    expect(error).toBeInstanceOf(AmosError);
    expect((error as AmosError).code).toBe(code);
    for (const f of fragments) expect((error as AmosError).message).toContain(f);
  }
}

describe("defaults", () => {
  it("fills every nested default from an empty config", () => {
    const c = defaultConfig();
    expect(c.logging).toEqual({
      level: "info",
      file: { enabled: true, maxBytes: 5 * 1024 * 1024, maxFiles: 5 },
    });
    expect(c.server).toEqual({ host: "127.0.0.1", port: 47821 });
    expect(c.network.offline).toBe(false);
    expect(c.privacy).toEqual({ defaultLabel: "personal", directories: [] });
    expect(c.providers).toEqual({});
  });
});

describe("loadConfig", () => {
  it("uses defaults when the file does not exist", () => {
    const loaded = loadConfig({ configFile: path.join(tempDir(), "missing.yaml"), env: {} });
    expect(loaded.file).toBeNull();
    expect(loaded.config).toEqual(defaultConfig());
  });

  it("treats an empty or comment-only file as defaults", () => {
    const loaded = loadConfig({ configFile: writeConfig("# nothing yet\n"), env: {} });
    expect(loaded.config).toEqual(defaultConfig());
  });

  it("merges a partial file over defaults", () => {
    const file = writeConfig("logging:\n  level: debug\n  file:\n    maxFiles: 2\n");
    const { config } = loadConfig({ configFile: file, env: {} });
    expect(config.logging.level).toBe("debug");
    expect(config.logging.file).toEqual({ enabled: true, maxBytes: 5242880, maxFiles: 2 });
  });

  it("lets environment variables override the file", () => {
    const file = writeConfig("logging:\n  level: debug\nnetwork:\n  offline: false\n");
    const loaded = loadConfig({
      configFile: file,
      env: { AMOS_LOG_LEVEL: "WARN", AMOS_OFFLINE: "yes", AMOS_PORT: "50000" },
    });
    expect(loaded.config.logging.level).toBe("warn");
    expect(loaded.config.network.offline).toBe(true);
    expect(loaded.config.server.port).toBe(50000);
    expect([...loaded.envOverrides].sort()).toEqual([
      "AMOS_LOG_LEVEL",
      "AMOS_OFFLINE",
      "AMOS_PORT",
    ]);
  });

  it("reports YAML syntax errors with a line number", () => {
    const file = writeConfig("logging:\n  level: info\n   file: [\n");
    expectConfigError(() => loadConfig({ configFile: file, env: {} }), "CONFIG_PARSE", "line");
  });

  it("rejects duplicate keys instead of silently keeping one", () => {
    const file = writeConfig("logging:\n  level: info\nlogging:\n  level: debug\n");
    expectConfigError(() => loadConfig({ configFile: file, env: {} }), "CONFIG_PARSE");
  });

  it("rejects a non-mapping document", () => {
    expectConfigError(
      () => loadConfig({ configFile: writeConfig("- a\n- b\n"), env: {} }),
      "CONFIG_INVALID",
      "mapping",
    );
  });

  it("lists every problem with its path", () => {
    const file = writeConfig("loging: {}\nlogging:\n  level: loud\nserver:\n  port: 80\n");
    expectConfigError(
      () => loadConfig({ configFile: file, env: {} }),
      "CONFIG_INVALID",
      "loging",
      "logging.level",
      "server.port",
    );
  });

  it("refuses non-loopback server addresses", () => {
    expectConfigError(
      () => validateConfig({ server: { host: "0.0.0.0" } }, "test"),
      "CONFIG_INVALID",
      "server.host",
    );
  });

  it("refuses secrets in the config file and explains where they belong", () => {
    try {
      validateConfig(
        { providers: { deepseek: { kind: "openai-compatible", apiKey: "anything" } } },
        "test",
      );
      expect.unreachable();
    } catch (error) {
      const e = error as AmosError;
      expect(e.code).toBe("CONFIG_INVALID");
      expect(e.message).toContain("providers.deepseek.apiKey");
      expect(e.message).not.toContain("anything");
      expect(e.hint).toContain("secrets.env");
    }
  });
});

describe("provider config", () => {
  const base = {
    kind: "openai-compatible",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    location: "cloud",
    models: {
      "deepseek-chat": { contextWindow: 65536, maxOutputTokens: 8192, toolCalling: "native" },
    },
  };

  it("accepts a valid cloud provider with model capabilities", () => {
    const c = validateConfig(
      { providers: { deepseek: { ...base, baseUrl: "https://api.deepseek.com" } } },
      "t",
    );
    const model = c.providers["deepseek"]?.models["deepseek-chat"];
    expect(model?.toolCalling).toBe("native");
    expect(model?.structuredOutput).toBe("none");
  });

  it("requires https for remote endpoints", () => {
    expectConfigError(
      () => validateConfig({ providers: { x: { ...base, baseUrl: "http://example.com" } } }, "t"),
      "CONFIG_INVALID",
      "providers.x.baseUrl",
      "https",
    );
  });

  it("allows http only for localhost, and 'local' only for localhost", () => {
    const ollama = {
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      location: "local",
    };
    expect(validateConfig({ providers: { ollama } }, "t").providers["ollama"]?.location).toBe(
      "local",
    );
    expectConfigError(
      () =>
        validateConfig(
          { providers: { fake: { ...ollama, baseUrl: "https://example.com/v1" } } },
          "t",
        ),
      "CONFIG_INVALID",
      "providers.fake.location",
    );
  });

  it("validates the key variable name, not a key value", () => {
    expectConfigError(
      () =>
        validateConfig(
          { providers: { x: { ...base, baseUrl: "https://a.example", apiKeyEnv: "sk-123" } } },
          "t",
        ),
      "CONFIG_INVALID",
      "apiKeyEnv",
    );
  });
});

describe("env overrides", () => {
  it("ignores unset/empty variables", () => {
    expect(readEnvOverrides({ AMOS_LOG_LEVEL: "" }).applied).toEqual([]);
  });

  it("rejects invalid values without echoing them", () => {
    expectConfigError(
      () => readEnvOverrides({ AMOS_OFFLINE: "maybe-secret" }),
      "CONFIG_INVALID",
      "AMOS_OFFLINE",
    );
    try {
      readEnvOverrides({ AMOS_OFFLINE: "maybe-secret" });
    } catch (error) {
      expect((error as Error).message).not.toContain("maybe-secret");
    }
    expectConfigError(() => readEnvOverrides({ AMOS_PORT: "80a" }), "CONFIG_INVALID", "AMOS_PORT");
    expectConfigError(() => readEnvOverrides({ AMOS_LOG_LEVEL: "trace" }), "CONFIG_INVALID");
  });
});

describe("deepMerge", () => {
  it("merges objects recursively and replaces arrays and scalars", () => {
    expect(deepMerge({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2] }, d: 2 })).toEqual({
      a: { b: 1, c: [2] },
      d: 2,
    });
  });
});

describe("config/config.example.yaml", () => {
  const text = fs.readFileSync("config/config.example.yaml", "utf8");

  it("is valid as shipped and equals the defaults", () => {
    const file = writeConfig(text);
    expect(loadConfig({ configFile: file, env: {} }).config).toEqual(defaultConfig());
  });

  it("stays valid with the commented provider and privacy examples enabled", () => {
    // Uncomment the example blocks ("  # key: …" → "  key: …") after removing the empty defaults.
    const lines = text.split("\n");
    const start = (marker: string) => lines.findIndex((l) => l.startsWith(marker));
    const uncomment = (from: number) => {
      for (let i = from; i < lines.length && /^\s*#/.test(lines[i] as string); i++) {
        const line = lines[i] as string;
        if (/^\s*# (example|Path handling|until then)/.test(line)) continue;
        lines[i] = line.replace(/^(\s*)# ?/, "$1");
      }
    };
    lines[start("providers: {}")] = "";
    uncomment(start("# example (used from M1"));
    lines[lines.indexOf("  directories: []")] = "";
    uncomment(lines.findIndex((l) => l.includes("# directories:")));
    const config = validateConfig(parseYamlConfig(lines.join("\n"), "example"), "example");
    expect(Object.keys(config.providers).sort()).toEqual(["deepseek", "ollama"]);
    expect(config.providers["ollama"]?.location).toBe("local");
    expect(config.privacy.directories.map((d) => d.label)).toEqual(["local_only", "public"]);
  });
});
