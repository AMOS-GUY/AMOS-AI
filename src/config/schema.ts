import { z } from "zod";
import { modelCapabilitiesSchema } from "../core/provider.ts";

/**
 * The owner-editable configuration (`config.yaml`) and its defaults.
 *
 * Every object is `.strict()` so a typo ("loging:") is an error instead of being silently ignored.
 * Secrets never appear here: providers name the environment variable that holds their key
 * (`apiKeyEnv`), and the loader rejects secret-looking keys outright.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const logLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof logLevelSchema>;

const loggingSchema = z
  .object({
    level: logLevelSchema.default("info"),
    file: z
      .object({
        enabled: z.boolean().default(true),
        maxBytes: z
          .number()
          .int()
          .min(64 * 1024)
          .default(5 * 1024 * 1024),
        maxFiles: z.number().int().min(1).max(20).default(5),
      })
      .strict()
      .prefault({}),
  })
  .strict();

// amosd binds to loopback only. Remote access (M5) goes through an authenticated overlay network,
// never by widening this — so the schema refuses any other address.
const serverSchema = z
  .object({
    host: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
    port: z.number().int().min(1024).max(65535).default(47821),
  })
  .strict();

const networkSchema = z
  .object({
    offline: z.boolean().default(false),
    connectTimeoutMs: z.number().int().min(100).max(120_000).default(10_000),
    requestTimeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  })
  .strict();

const directoryLabelSchema = z.enum(["public", "personal", "local_only"]);

const privacySchema = z
  .object({
    /** Label for owner files outside any listed directory. */
    defaultLabel: directoryLabelSchema.default("personal"),
    directories: z
      .array(
        z
          .object({
            path: z.string().min(1),
            label: directoryLabelSchema,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const providerSchema = z
  .object({
    kind: z.literal("openai-compatible"),
    enabled: z.boolean().default(true),
    baseUrl: z.url({ protocol: /^https?$/ }),
    /** Name of the environment variable / secrets.env entry holding the API key. */
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "must be an UPPER_SNAKE_CASE variable name")
      .optional(),
    location: z.enum(["local", "cloud"]),
    models: z.record(z.string().min(1), modelCapabilitiesSchema).default({}),
  })
  .strict()
  .superRefine((provider, ctx) => {
    const url = new URL(provider.baseUrl);
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol === "http:" && !loopback) {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "must use https:// unless it points at this machine (localhost)",
      });
    }
    if (provider.location === "local" && !loopback) {
      ctx.addIssue({
        code: "custom",
        path: ["location"],
        message: "a 'local' provider must point at localhost; remote endpoints are 'cloud'",
      });
    }
  });

export const configSchema = z
  .object({
    logging: loggingSchema.prefault({}),
    server: serverSchema.prefault({}),
    network: networkSchema.prefault({}),
    privacy: privacySchema.prefault({}),
    providers: z
      .record(
        z.string().regex(/^[a-z][a-z0-9-]*$/, "provider ids are lowercase-kebab"),
        providerSchema,
      )
      .default({}),
  })
  .strict();

export type AmosConfig = z.infer<typeof configSchema>;
export type ProviderConfig = AmosConfig["providers"][string];

export function defaultConfig(): AmosConfig {
  return configSchema.parse({});
}
