import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { MIN_NODE_VERSION } from "../src/cli/doctor.ts";
import { VERSION } from "../src/version.ts";

describe("project metadata", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

  it("keeps src/version.ts in sync with package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("pins every dependency to an exact version", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    for (const [name, version] of Object.entries(all)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("keeps .nvmrc, engines and the doctor minimum consistent", () => {
    const nvm = fs.readFileSync(".nvmrc", "utf8").trim();
    expect(pkg.engines.node).toBe(`>=${MIN_NODE_VERSION}`);
    expect(MIN_NODE_VERSION.startsWith(`${nvm}.`)).toBe(true);
  });
});
