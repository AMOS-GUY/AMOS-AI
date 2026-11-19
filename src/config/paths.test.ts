import { describe, expect, it } from "vitest";
import { AmosError } from "../core/errors.ts";
import { resolvePaths } from "./paths.ts";

describe("resolvePaths", () => {
  it("follows XDG defaults on Linux", () => {
    const p = resolvePaths({ platform: "linux", env: {}, homeDir: "/home/user" });
    expect(p).toEqual({
      configDir: "/home/user/.config/amos",
      dataDir: "/home/user/.local/share/amos",
      stateDir: "/home/user/.local/state/amos",
      logDir: "/home/user/.local/state/amos/logs",
      configFile: "/home/user/.config/amos/config.yaml",
      secretsFile: "/home/user/.config/amos/secrets.env",
      databaseFile: "/home/user/.local/share/amos/amos.db",
    });
  });

  it("honours absolute XDG variables and ignores relative ones (per spec)", () => {
    const p = resolvePaths({
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/cfg", XDG_DATA_HOME: "relative/data", XDG_STATE_HOME: "/st" },
      homeDir: "/home/user",
    });
    expect(p.configDir).toBe("/cfg/amos");
    expect(p.dataDir).toBe("/home/user/.local/share/amos");
    expect(p.logDir).toBe("/st/amos/logs");
  });

  it("uses Library folders on macOS", () => {
    const p = resolvePaths({ platform: "darwin", env: {}, homeDir: "/Users/user" });
    expect(p.configDir).toBe("/Users/user/Library/Application Support/amos");
    expect(p.logDir).toBe("/Users/user/Library/Logs/amos");
  });

  it("uses APPDATA / LOCALAPPDATA on Windows", () => {
    const p = resolvePaths({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\user\\AppData\\Roaming", LOCALAPPDATA: "D:\\Local" },
      homeDir: "C:\\Users\\user",
    });
    expect(p.configDir).toBe("C:\\Users\\user\\AppData\\Roaming\\amos");
    expect(p.dataDir).toBe("D:\\Local\\amos");
    expect(p.databaseFile).toBe("D:\\Local\\amos\\amos.db");
  });

  it("applies AMOS_* overrides, with logs following the state dir", () => {
    const p = resolvePaths({
      platform: "linux",
      env: { AMOS_CONFIG_DIR: "/x/c", AMOS_DATA_DIR: "/x/d", AMOS_STATE_DIR: "/x/s" },
      homeDir: "/home/user",
    });
    expect(p.configFile).toBe("/x/c/config.yaml");
    expect(p.databaseFile).toBe("/x/d/amos.db");
    expect(p.logDir).toBe("/x/s/logs");
  });

  it("rejects relative overrides and a relative home directory", () => {
    expect(() =>
      resolvePaths({ platform: "linux", env: { AMOS_DATA_DIR: "data" }, homeDir: "/home/user" }),
    ).toThrow("AMOS_DATA_DIR must be an absolute path.");
    expect(() => resolvePaths({ platform: "linux", env: {}, homeDir: "home" })).toThrow(AmosError);
  });
});
