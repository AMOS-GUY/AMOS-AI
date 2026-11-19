import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWindows, tempDir } from "../../tests/helpers.ts";
import type { AmosError } from "../core/errors.ts";
import { REDACTED, Redactor } from "../logging/redact.ts";
import { checkSecretsFilePermissions, loadSecrets, parseEnvFile, SecretStore } from "./secrets.ts";

describe("parseEnvFile", () => {
  it("parses KEY=VALUE with comments, export, quotes and CRLF", () => {
    const text = [
      "﻿# comment",
      "",
      "A=plain",
      "export B=exported",
      'C="quoted # not a comment"',
      "D='single'",
      "E=value # trailing comment",
      "F=",
      "G=has=equals",
    ].join("\r\n");
    expect(Object.fromEntries(parseEnvFile(text))).toEqual({
      A: "plain",
      B: "exported",
      C: "quoted # not a comment",
      D: "single",
      E: "value",
      F: "",
      G: "has=equals",
    });
  });

  it("reports the line number of malformed lines without echoing content", () => {
    try {
      parseEnvFile("A=1\nthis-is-secret-material\n");
      expect.unreachable();
    } catch (error) {
      expect((error as AmosError).code).toBe("SECRET_FILE_INVALID");
      expect((error as AmosError).message).toContain("line 2");
      expect((error as AmosError).message).not.toContain("secret-material");
    }
    expect(() => parseEnvFile('A="unclosed')).toThrow(/unclosed quote/);
  });
});

describe("checkSecretsFilePermissions", () => {
  const uid = 1000;
  it("accepts 0600 and 0400 owned by the user", () => {
    expect(() =>
      checkSecretsFilePermissions({ mode: 0o100600, uid }, "linux", uid, "s"),
    ).not.toThrow();
    expect(() =>
      checkSecretsFilePermissions({ mode: 0o100400, uid }, "linux", uid, "s"),
    ).not.toThrow();
  });

  it("rejects group/other access with a chmod hint", () => {
    for (const mode of [0o100644, 0o100640, 0o100606, 0o100660]) {
      try {
        checkSecretsFilePermissions({ mode, uid }, "linux", uid, "/c/secrets.env");
        expect.unreachable();
      } catch (error) {
        expect((error as AmosError).code).toBe("SECRET_FILE_INSECURE");
        expect((error as AmosError).hint).toBe('Run: chmod 600 "/c/secrets.env"');
      }
    }
  });

  it("rejects files owned by another user", () => {
    expect(() =>
      checkSecretsFilePermissions({ mode: 0o100600, uid: 0 }, "darwin", uid, "s"),
    ).toThrow(/not owned/);
  });

  it("skips mode checks on Windows (ACL-based)", () => {
    expect(() =>
      checkSecretsFilePermissions({ mode: 0o100666, uid: 0 }, "win32", undefined, "s"),
    ).not.toThrow();
  });
});

describe("SecretStore", () => {
  it("prefers the environment over the file", () => {
    const store = new SecretStore(
      new Map([["K", "from-file-value"]]),
      { K: "from-env-value" },
      new Redactor(),
      true,
    );
    expect(store.get("K")).toBe("from-env-value");
    const fileOnly = new SecretStore(
      new Map([["K", "from-file-value"]]),
      { K: "" },
      new Redactor(),
      true,
    );
    expect(fileOnly.get("K")).toBe("from-file-value");
  });

  it("registers every file value and every accessed value with the redactor", () => {
    const redactor = new Redactor();
    const store = new SecretStore(
      new Map([["FILE_KEY", "file-secret-123"]]),
      { ENV_KEY: "env-secret-456" },
      redactor,
      true,
    );
    expect(redactor.redactString("x file-secret-123 y")).toBe(`x ${REDACTED} y`);
    // Not accessed yet → not known.
    expect(redactor.redactString("env-secret-456")).toBe("env-secret-456");
    store.get("ENV_KEY");
    expect(redactor.redactString("env-secret-456")).toBe(REDACTED);
  });

  it("names the missing secret and how to provide it", () => {
    const store = new SecretStore(new Map(), {}, new Redactor(), false);
    expect(store.has("NOPE")).toBe(false);
    try {
      store.require("NOPE");
      expect.unreachable();
    } catch (error) {
      expect((error as AmosError).code).toBe("SECRET_MISSING");
      expect((error as AmosError).hint).toContain("NOPE=");
    }
  });

  it("lists key names only", () => {
    const store = new SecretStore(
      new Map([
        ["B", "x"],
        ["A", "y"],
      ]),
      {},
      new Redactor(),
      true,
    );
    expect(store.fileKeyNames()).toEqual(["A", "B"]);
  });
});

describe("loadSecrets (real files)", () => {
  it("returns an empty store when the file is absent", () => {
    const store = loadSecrets({
      file: path.join(tempDir(), "secrets.env"),
      env: {},
      platform: process.platform,
      redactor: new Redactor(),
    });
    expect(store.fileLoaded).toBe(false);
  });

  it.skipIf(isWindows)("refuses a world-readable file and accepts it after chmod 600", () => {
    const file = path.join(tempDir(), "secrets.env");
    fs.writeFileSync(file, "TEST_KEY=abcdefgh12345\n", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const load = () =>
      loadSecrets({ file, env: {}, platform: process.platform, redactor: new Redactor() });
    expect(load).toThrow(/accessible by other users/);
    fs.chmodSync(file, 0o600);
    expect(load().get("TEST_KEY")).toBe("abcdefgh12345");
  });

  it.runIf(isWindows)("loads on Windows without a mode check", () => {
    const file = path.join(tempDir(), "secrets.env");
    fs.writeFileSync(file, "TEST_KEY=abcdefgh12345\n");
    const store = loadSecrets({ file, env: {}, platform: "win32", redactor: new Redactor() });
    expect(store.get("TEST_KEY")).toBe("abcdefgh12345");
  });

  it("rejects a directory in place of the file", () => {
    const dir = tempDir();
    expect(() =>
      loadSecrets({ file: dir, env: {}, platform: process.platform, redactor: new Redactor() }),
    ).toThrow(/not a regular file/);
  });
});
