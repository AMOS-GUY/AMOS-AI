/** M0.5 audit regressions: provider URL hygiene (SEC-04) and one loopback rule (SEC-05). */
import { describe, expect, it } from "vitest";
import { AmosError } from "../core/errors.ts";
import { isLoopbackHost as loopbackFromCore } from "../core/loopback.ts";
import { isLoopbackHost as loopbackFromTransport } from "../net/http.ts";
import { validateConfig } from "./load.ts";

const cloud = {
  kind: "openai-compatible",
  location: "cloud",
  privacy: { allowPersonalData: false },
};
const local = {
  kind: "openai-compatible",
  location: "local",
  privacy: { allowPersonalData: true },
};

function configError(raw: unknown, ...fragments: string[]): string {
  try {
    validateConfig(raw, "test");
  } catch (error) {
    expect(error).toBeInstanceOf(AmosError);
    const message = (error as AmosError).message;
    for (const f of fragments) expect(message).toContain(f);
    return message;
  }
  throw new Error("expected CONFIG_INVALID");
}

describe("provider baseUrl hygiene (SEC-04)", () => {
  it("rejects embedded credentials without echoing the password in the explanation", () => {
    const message = configError(
      { providers: { x: { ...cloud, baseUrl: "https://user:hunter2-pass@api.example.com/v1" } } },
      "providers.x.baseUrl",
      "username or password",
    );
    // The file path and setting path are named; the issue text itself never repeats the URL.
    const issues = message.split("\n").slice(1).join("\n");
    expect(issues).not.toContain("hunter2-pass");
  });

  it("rejects query strings and fragments", () => {
    configError(
      { providers: { x: { ...cloud, baseUrl: "https://api.example.com/v1?key=abc" } } },
      "query string",
    );
    configError(
      { providers: { x: { ...cloud, baseUrl: "https://api.example.com/v1#frag" } } },
      "fragment",
    );
  });

  it("still accepts ordinary base URLs with ports and paths", () => {
    const c = validateConfig(
      {
        providers: {
          x: { ...cloud, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
          o: { ...local, baseUrl: "http://localhost:11434/v1" },
        },
      },
      "t",
    );
    expect(Object.keys(c.providers).sort()).toEqual(["o", "x"]);
  });
});

describe("one loopback definition (SEC-05)", () => {
  it("is the same function in config and transport", () => {
    expect(loopbackFromTransport).toBe(loopbackFromCore);
  });

  it("accepts the whole 127.0.0.0/8 range as local, and nothing that merely looks like it", () => {
    const c = validateConfig(
      { providers: { o: { ...local, baseUrl: "http://127.0.0.2:11434/v1" } } },
      "t",
    );
    expect(c.providers["o"]?.location).toBe("local");
    configError(
      { providers: { o: { ...local, baseUrl: "http://127.0.0.1.evil.test/v1" } } },
      "providers.o",
    );
    configError(
      { providers: { o: { ...local, baseUrl: "https://localhost.evil.test/v1" } } },
      "providers.o.location",
    );
  });
});
