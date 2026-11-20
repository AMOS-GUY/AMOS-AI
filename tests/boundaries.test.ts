/**
 * Architecture tripwires (M0.1): each sensitive capability has exactly one home, so no second code
 * path can bypass the checks there. These are static source scans of src/ (tests excluded). They
 * catch ordinary imports and calls, not deliberately obfuscated code.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = "src";

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

/** Source with comments removed, so prose in comments never trips a rule. (`://` in URLs is kept.) */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = (file: string) => stripComments(fs.readFileSync(file, "utf8"));

const posix = (p: string) => p.split(path.sep).join("/");
const files = sourceFiles(SRC).map((f) => ({ file: posix(f), text: code(f) }));

function importsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(
    /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    out.push((m[1] ?? m[2] ?? m[3]) as string);
  }
  return out;
}

function offenders(
  predicate: (f: { file: string; text: string }) => boolean,
  allowed: readonly string[],
) {
  return files.filter((f) => predicate(f) && !allowed.includes(f.file)).map((f) => f.file);
}

describe("single home for each sensitive capability", () => {
  it("finds the source files (sanity check)", () => {
    expect(files.length).toBeGreaterThan(15);
    expect(files.some((f) => f.file === "src/net/http.ts")).toBe(true);
  });

  it("only src/net/http.ts performs HTTP requests (fetch)", () => {
    expect(offenders((f) => /\bfetch\s*\(/.test(f.text), ["src/net/http.ts"])).toEqual([]);
  });

  it("only src/net/ may import networking modules", () => {
    const network = /^(node:)?(http|https|http2|net|tls|dgram|dns)(\/.*)?$|^undici$/;
    const bad = files
      .filter((f) => !f.file.startsWith("src/net/"))
      .filter((f) => importsOf(f.text).some((m) => network.test(m)))
      .map((f) => f.file);
    expect(bad).toEqual([]);
  });

  it("only the transport consumes egress clearances", () => {
    expect(
      offenders(
        (f) => /\bverifyClearance\s*\(/.test(f.text),
        ["src/net/http.ts", "src/core/egress-gate.ts"],
      ),
    ).toEqual([]);
  });

  it("only src/storage/sqlite.ts touches node:sqlite", () => {
    expect(
      offenders((f) => importsOf(f.text).includes("node:sqlite"), ["src/storage/sqlite.ts"]),
    ).toEqual([]);
  });

  it("only amos doctor starts child processes (agent command tools are M2 work behind the policy engine)", () => {
    expect(
      offenders(
        (f) => importsOf(f.text).some((m) => /^(node:)?child_process$/.test(m)),
        ["src/cli/doctor.ts"],
      ),
    ).toEqual([]);
  });

  it("the rules would catch a violation (self-test of the scanner)", () => {
    expect(importsOf('import x from "node:https";')).toEqual(["node:https"]);
    expect(importsOf('const m = await import("undici");')).toEqual(["undici"]);
    const callsFetch = (t: string) => /\bfetch\s*\(/.test(stripComments(t));
    expect(callsFetch("const r = await fetch(url);")).toBe(true);
    expect(callsFetch("// we never call fetch(url) here")).toBe(false);
    expect(callsFetch("/* fetch(url) */")).toBe(false);
    expect(stripComments('const u = "https://x.example";')).toContain("https://x.example");
  });
});
