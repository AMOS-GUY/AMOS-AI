import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatTable, probe } from "../scripts/probe-connectivity.ts";
import { RULES, scanRepository, scanText } from "../scripts/secret-scan.ts";
import { tempDir } from "./helpers.ts";

// Fake credentials are assembled at runtime so this file never contains a literal match.
const fake = {
  openai: ["sk", "-", "A1b2C3d4E5f6G7h8I9j0K1l2"].join(""),
  github: ["gh", "p_", "a".repeat(36)].join(""),
  aws: ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
  pem: ["-----BEGIN RSA", " PRIVATE KEY-----"].join(""),
};

describe("secret-scan rules", () => {
  it.each([
    ["openai-style-key", `const k = "${fake.openai}";`],
    ["github-token", `token: ${fake.github}`],
    ["aws-access-key", `aws=${fake.aws}`],
    ["private-key", fake.pem],
    ["assigned-secret", `DEEPSEEK_API_KEY = "${"x".repeat(24)}"`],
    ["personal-windows-path", `see C:\\Users\\${"alice"}\\Documents\\notes.txt`],
    ["personal-unix-home", ["/home/", "alice/projects/x"].join("")],
  ])("flags %s", (rule, line) => {
    expect(scanText("f", line).map((f) => f.rule)).toContain(rule);
  });

  it.each([
    "apiKeyEnv: DEEPSEEK_API_KEY",
    "DEEPSEEK_API_KEY=",
    "maxOutputTokens: 8192",
    "/home/user/.config/amos",
    String.raw`C:\Users\<you>\AppData`,
    "const password = process.env.PASSWORD;",
  ])("does not flag ordinary text: %s", (line) => {
    expect(scanText("f", line)).toEqual([]);
  });

  it("reports file and line, never the value", () => {
    const findings = scanText("a.txt", `ok\nkey=${fake.openai}`);
    expect(findings).toEqual([{ file: "a.txt", line: 2, rule: "openai-style-key" }]);
    expect(JSON.stringify(findings)).not.toContain(fake.openai);
  });

  it("has unique rule ids", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  });

  it("finds nothing in this repository", () => {
    expect(scanRepository(process.cwd())).toEqual([]);
  });
});

describe("connectivity probe", () => {
  let server: http.Server | undefined;
  afterEach(
    () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
  );

  // Loopback-only test server on an ephemeral port; closed after each test.
  async function listen(handler: http.RequestListener): Promise<string> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  it("counts any HTTP response (even 401) as reachable and sends no credentials", async () => {
    let seenAuth: string | undefined = "unset";
    const url = await listen((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(401).end();
    });
    const result = await probe({ name: "local", url, purpose: "test" }, 2000);
    expect(result).toMatchObject({ reachable: true, status: 401, error: null });
    expect(seenAuth).toBeUndefined();
  });

  it("reports a timeout when the server never answers", async () => {
    const url = await listen(() => {
      /* never respond */
    });
    const result = await probe({ name: "slow", url, purpose: "test" }, 300);
    expect(result).toMatchObject({ reachable: false, error: "timeout" });
  });

  it("reports DNS failure for an unresolvable host", async () => {
    const result = await probe(
      { name: "nx", url: "https://amos-probe.invalid/", purpose: "test" },
      3000,
    );
    expect(result.reachable).toBe(false);
    expect(result.dnsMs).toBeNull();
    expect(result.error).toMatch(/ENOTFOUND|EAI_AGAIN|DNS timeout/);
  });

  it("formats a readable table", () => {
    const table = formatTable([
      {
        name: "a",
        url: "u",
        purpose: "p",
        reachable: true,
        dnsMs: 1,
        responseMs: 20,
        status: 200,
        error: null,
      },
      {
        name: "bb",
        url: "u",
        purpose: "p",
        reachable: false,
        dnsMs: null,
        responseMs: null,
        status: null,
        error: "timeout",
      },
    ]);
    expect(table).toBe("[OK  ] a   200 in 20 ms (dns 1 ms)\n[FAIL] bb  timeout");
  });
});

describe("clean script", () => {
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [path.resolve("scripts/clean.ts"), ...args], {
      cwd,
      encoding: "utf8",
    });

  it("removes a directory inside the working directory", () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, "dist", "x"), { recursive: true });
    expect(run(root, "dist").status).toBe(0);
    expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
  });

  it.each(["..", ".", "../outside"])("refuses %s and deletes nothing", (target) => {
    const parent = tempDir();
    const root = path.join(parent, "repo");
    fs.mkdirSync(path.join(root, "keep"), { recursive: true });
    fs.mkdirSync(path.join(parent, "outside"));
    const result = run(root, target);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing");
    expect(fs.existsSync(path.join(root, "keep"))).toBe(true);
    expect(fs.existsSync(path.join(parent, "outside"))).toBe(true);
  });
});
