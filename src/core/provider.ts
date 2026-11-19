import { z } from "zod";

/**
 * Model capability descriptions (docs/ARCHITECTURE.md §8).
 *
 * Capabilities are configuration data per model, not hard-coded per vendor, so a new provider only
 * needs config. No provider adapter exists in M0; this schema is what M1's router will read.
 */

export const modelCapabilitiesSchema = z
  .object({
    streaming: z.enum(["full", "text_only", "none"]).default("full"),
    toolCalling: z.enum(["native", "none"]).default("none"),
    parallelToolCalls: z.boolean().default(false),
    structuredOutput: z.enum(["json_schema", "json_object", "none"]).default("none"),
    vision: z.boolean().default(false),
    reasoningOutput: z.boolean().default(false),
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
  })
  .strict()
  .refine((c) => c.maxOutputTokens <= c.contextWindow, {
    message: "maxOutputTokens cannot exceed contextWindow",
    path: ["maxOutputTokens"],
  })
  .refine((c) => !c.parallelToolCalls || c.toolCalling === "native", {
    message: "parallelToolCalls requires toolCalling: native",
    path: ["parallelToolCalls"],
  });

export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

/** Where a provider runs; feeds the privacy egress gate. */
export type ProviderLocation = "local" | "cloud";

export const PROVIDER_ERROR_KINDS = [
  "network",
  "timeout",
  "rate_limited",
  "auth",
  "quota",
  "invalid_request",
  "content_filter",
  "server",
  "unavailable",
] as const;

export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  "network",
  "timeout",
  "rate_limited",
  "server",
  "unavailable",
]);

/** Whether retrying the same request can plausibly succeed. auth/quota/invalid input never will. */
export function isRetryableProviderError(kind: ProviderErrorKind): boolean {
  return RETRYABLE.has(kind);
}

/** What a task needs from a model; used to filter candidates before routing. */
export interface ModelRequirements {
  readonly toolCalling?: boolean;
  readonly structuredOutput?: boolean;
  readonly minContextWindow?: number;
}

export function meetsRequirements(caps: ModelCapabilities, req: ModelRequirements): boolean {
  if (req.toolCalling && caps.toolCalling !== "native") return false;
  if (req.structuredOutput && caps.structuredOutput === "none") return false;
  if (req.minContextWindow !== undefined && caps.contextWindow < req.minContextWindow) return false;
  return true;
}
