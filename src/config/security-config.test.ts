/** M0.1 regression tests: configuration rejects unsafe privacy, provider and timeout settings. */
import { describe, expect, it } from "vitest";
import { AmosError } from "../core/errors.ts";
import { validateConfig } from "./load.ts";
import { createEgressGate, providerPolicies } from "./providers.ts";
import { defaultConfig } from "./schema.ts";

function configError(raw: unknown, ...fragments: string[]): string {
  try {
    validateConfig(raw, "test");
  } catch (error) {
    expect(error).toBeInstanceOf(AmosError);
    expect((error as AmosError).code).toBe("CONFIG_INVALID");
    const message = (error as AmosError).message;
    for (const f of fragments) expect(message).toContain(f);
    return message;
  }
  throw new Error("expected CONFIG_INVALID");
}

const cloud = {
  kind: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  location: "cloud",
  privacy: { allowPersonalData: false },
};

describe("F2 — privacy defaults", () => {
  it("defaults unclassified data to local_only", () => {
    expect(defaultConfig().privacy.defaultLabel).toBe("local_only");
  });

  it("rejects public as the default label, explaining why", () => {
    configError(
      { privacy: { defaultLabel: "public" } },
      "privacy.defaultLabel",
      "never treated as public",
    );
  });

  it("rejects unknown and wrongly typed default labels", () => {
    for (const bad of ["Public", "LOCAL_ONLY", "private", "", 1, null, ["local_only"]]) {
      configError({ privacy: { defaultLabel: bad } }, "privacy.defaultLabel");
    }
  });

  it("rejects secret as a default (it would make every unlabelled item unusable)", () => {
    configError({ privacy: { defaultLabel: "secret" } }, "privacy.defaultLabel");
  });

  it("allows personal only when chosen explicitly", () => {
    expect(
      validateConfig({ privacy: { defaultLabel: "personal" } }, "t").privacy.defaultLabel,
    ).toBe("personal");
  });

  it("validates directory labels and allows the stricter secret label", () => {
    configError(
      { privacy: { directories: [{ path: "/a", label: "pub" }] } },
      "privacy.directories.0.label",
    );
    configError({ privacy: { directories: [{ path: "/a" }] } }, "privacy.directories.0.label");
    configError(
      { privacy: { directories: [{ path: "   ", label: "public" }] } },
      "privacy.directories.0.path",
    );
    const c = validateConfig(
      { privacy: { directories: [{ path: "/keys", label: "secret" }] } },
      "t",
    );
    expect(c.privacy.directories[0]?.label).toBe("secret");
  });

  it("rejects the same directory listed twice (order-dependent labels are a downgrade risk)", () => {
    configError(
      {
        privacy: {
          directories: [
            { path: "/home/user/notes", label: "local_only" },
            { path: "/home/user/notes/", label: "public" },
          ],
        },
      },
      "privacy.directories.1.path",
      "duplicates privacy.directories.0",
    );
  });
});

describe("F3 — provider privacy policy", () => {
  it("requires an explicit privacy policy on every provider", () => {
    const { privacy: _omit, ...noPolicy } = cloud;
    configError({ providers: { x: noPolicy } }, "providers.x.privacy", "allowPersonalData");
  });

  it("requires allowPersonalData itself, as a real boolean", () => {
    configError(
      { providers: { x: { ...cloud, privacy: {} } } },
      "providers.x.privacy.allowPersonalData",
      "never assumes",
    );
    for (const bad of ["true", "yes", 1, null]) {
      configError(
        { providers: { x: { ...cloud, privacy: { allowPersonalData: bad } } } },
        "allowPersonalData",
      );
    }
  });

  it("rejects unknown policy keys (no silent typos such as allowPersonal)", () => {
    configError(
      { providers: { x: { ...cloud, privacy: { allowPersonal: true } } } },
      "providers.x.privacy",
    );
  });

  it("feeds exactly the configured policy into the egress gate", () => {
    const config = validateConfig(
      {
        providers: {
          strict: cloud,
          trusted: {
            ...cloud,
            baseUrl: "https://trusted.example:8443/api",
            privacy: { allowPersonalData: true },
          },
          paused: { ...cloud, enabled: false },
        },
      },
      "t",
    );
    expect(providerPolicies(config)).toEqual([
      {
        providerId: "strict",
        location: "cloud",
        enabled: true,
        allowPersonalData: false,
        origin: "https://api.example.com",
      },
      {
        providerId: "trusted",
        location: "cloud",
        enabled: true,
        allowPersonalData: true,
        origin: "https://trusted.example:8443",
      },
      {
        providerId: "paused",
        location: "cloud",
        enabled: false,
        allowPersonalData: false,
        origin: "https://api.example.com",
      },
    ]);
    const gate = createEgressGate(config);
    const build = (c: readonly unknown[]) => c;
    expect(() =>
      gate.authorizeForProvider("strict", [{ label: "personal", content: "x" }], build),
    ).toThrow(AmosError);
    expect(
      gate.authorizeForProvider("trusted", [{ label: "personal", content: "x" }], build).origin,
    ).toBe("https://trusted.example:8443");
    expect(() =>
      gate.authorizeForProvider("paused", [{ label: "public", content: "x" }], build),
    ).toThrow(/disabled/);
  });

  it("an empty configuration has no destinations at all", () => {
    const gate = createEgressGate(defaultConfig());
    expect(() =>
      gate.authorizeForProvider("anything", [{ label: "public", content: "x" }], (c) => c),
    ).toThrow(/Unknown provider/);
  });
});

describe("F4 — timeout settings", () => {
  it("explains that connectTimeoutMs was removed", () => {
    configError(
      { network: { connectTimeoutMs: 5000 } },
      "connectTimeoutMs was removed",
      "headersTimeoutMs",
    );
  });

  it("rejects per-phase timeouts longer than the total", () => {
    configError(
      { network: { headersTimeoutMs: 700_000 } },
      "network.headersTimeoutMs",
      "requestTimeoutMs",
    );
    configError(
      { network: { requestTimeoutMs: 30_000, idleTimeoutMs: 60_000 } },
      "network.idleTimeoutMs",
    );
  });

  it("rejects zero, negative and fractional timeouts", () => {
    for (const bad of [0, -1, 1.5, "60000"])
      configError({ network: { headersTimeoutMs: bad } }, "network.headersTimeoutMs");
  });
});
