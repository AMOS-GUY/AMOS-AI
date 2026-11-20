import { describe, expect, it } from "vitest";
import {
  isRetryableProviderError,
  meetsRequirements,
  modelCapabilitiesSchema,
  PROVIDER_ERROR_KINDS,
} from "./provider.ts";

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
