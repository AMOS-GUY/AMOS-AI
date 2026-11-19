import { describe, expect, it } from "vitest";
import { AmosError } from "./errors.ts";
import {
  assertEgress,
  checkEgress,
  combineLabels,
  DESTINATIONS,
  PRIVACY_LABELS,
  type PrivacyLabel,
} from "./privacy.ts";
import {
  isRetryableProviderError,
  meetsRequirements,
  modelCapabilitiesSchema,
  PROVIDER_ERROR_KINDS,
} from "./provider.ts";

describe("privacy labels", () => {
  it("combines to the most restrictive label", () => {
    expect(combineLabels([])).toBe("public");
    expect(combineLabels(["public", "personal"])).toBe("personal");
    expect(combineLabels(["personal", "local_only", "public"])).toBe("local_only");
    expect(combineLabels(["local_only", "secret"])).toBe("secret");
  });
});

describe("egress gate", () => {
  const approved = { destinationApproved: true };
  const unapproved = { destinationApproved: false };

  it("never lets secrets out, anywhere, even when approved", () => {
    for (const d of DESTINATIONS) expect(checkEgress("secret", d, approved).allowed).toBe(false);
  });

  it("keeps local_only data on local models", () => {
    expect(checkEgress("local_only", "local_model", unapproved).allowed).toBe(true);
    for (const d of ["cloud_model", "external_tool", "remote_client"] as const) {
      expect(checkEgress("local_only", d, approved).allowed).toBe(false);
    }
  });

  it("sends personal data only to approved destinations", () => {
    expect(checkEgress("personal", "cloud_model", approved).allowed).toBe(true);
    expect(checkEgress("personal", "cloud_model", unapproved).allowed).toBe(false);
    expect(checkEgress("personal", "local_model", unapproved).allowed).toBe(true);
  });

  it("lets public data go anywhere", () => {
    for (const d of DESTINATIONS) expect(checkEgress("public", d, unapproved).allowed).toBe(true);
  });

  it("has a decision for every label × destination (exhaustive matrix)", () => {
    const allowedCount = PRIVACY_LABELS.flatMap((l: PrivacyLabel) =>
      DESTINATIONS.map((d) => checkEgress(l, d, unapproved).allowed),
    ).filter(Boolean).length;
    // public: 4, personal: 1 (local_model), local_only: 1, secret: 0
    expect(allowedCount).toBe(6);
  });

  it("throws PRIVACY_VIOLATION with a reason on denial", () => {
    try {
      assertEgress("local_only", "cloud_model", approved);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AmosError);
      expect((error as AmosError).code).toBe("PRIVACY_VIOLATION");
      expect((error as AmosError).message).toContain("cloud_model");
    }
  });
});

describe("model capabilities", () => {
  it("applies conservative defaults: no tools, no structured output", () => {
    const caps = modelCapabilitiesSchema.parse({ contextWindow: 32000, maxOutputTokens: 4000 });
    expect(caps.toolCalling).toBe("none");
    expect(caps.structuredOutput).toBe("none");
    expect(caps.streaming).toBe("full");
  });

  it("rejects inconsistent capability records", () => {
    expect(
      modelCapabilitiesSchema.safeParse({ contextWindow: 1000, maxOutputTokens: 2000 }).success,
    ).toBe(false);
    expect(
      modelCapabilitiesSchema.safeParse({
        contextWindow: 1000,
        maxOutputTokens: 100,
        parallelToolCalls: true,
      }).success,
    ).toBe(false);
    expect(
      modelCapabilitiesSchema.safeParse({ contextWindow: 1000, maxOutputTokens: 100, typo: 1 })
        .success,
    ).toBe(false);
  });

  it("filters models by task requirements", () => {
    const caps = modelCapabilitiesSchema.parse({
      contextWindow: 64000,
      maxOutputTokens: 8000,
      toolCalling: "native",
      structuredOutput: "json_object",
    });
    expect(meetsRequirements(caps, { toolCalling: true, structuredOutput: true })).toBe(true);
    expect(meetsRequirements(caps, { minContextWindow: 128000 })).toBe(false);
    const plain = modelCapabilitiesSchema.parse({ contextWindow: 8000, maxOutputTokens: 1000 });
    expect(meetsRequirements(plain, { toolCalling: true })).toBe(false);
    expect(meetsRequirements(plain, {})).toBe(true);
  });

  it("retries only transient provider errors", () => {
    const retryable = PROVIDER_ERROR_KINDS.filter(isRetryableProviderError).sort();
    expect(retryable).toEqual(["network", "rate_limited", "server", "timeout", "unavailable"]);
    expect(isRetryableProviderError("auth")).toBe(false);
    expect(isRetryableProviderError("invalid_request")).toBe(false);
  });
});
