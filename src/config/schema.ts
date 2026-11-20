import { z } from "zod";
import { isLoopbackHost } from "../core/loopback.ts";
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

// Timeouts the HTTP transport (src/net/http.ts) actually enforces. There is deliberately no
// separate "connect" timeout: Node's built-in fetch cannot enforce one without the undici package
// (M0.1 F4). DNS, connect and TLS are covered by headersTimeoutMs.
const networkSchema = z
  .object({
    /** true = no requests except to this machine (loopback). */
    offline: z.boolean().default(false),
    /** From sending the request until response headers arrive (includes DNS, connect, TLS). */
    headersTimeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
    /** Longest silence allowed between two chunks of a response body. */
    idleTimeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
    /** Hard limit for the whole request, including reading the full body. */
    requestTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
  })
  .strict()
  .superRefine((n, ctx) => {
    for (const key of ["headersTimeoutMs", "idleTimeoutMs"] as const) {
      if (n[key] > n.requestTimeoutMs) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `cannot exceed requestTimeoutMs (${n.requestTimeoutMs})`,
        });
      }
    }
  });

// `secret` is allowed for directories (it only restricts further). `public` is allowed for an
// explicitly listed directory, never as the default for unclassified data.
const directoryLabelSchema = z.enum(["public", "personal", "local_only", "secret"]);

const defaultLabelSchema = z.enum(["personal", "local_only"], {
  error: () =>
    "must be local_only (the default) or personal. Unclassified data is never treated as public; list public directories explicitly under privacy.directories",
});

function normalizeDirKey(p: string): string {
  return p.trim().replace(/[\\/]+$/, "") || p.trim();
}

const privacySchema = z
  .object({
    /** Label for owner data that no rule classifies. Conservative default: local_only. */
    defaultLabel: defaultLabelSchema.default("local_only"),
    directories: z
      .array(
        z
          .object({
            path: z.string().trim().min(1),
            label: directoryLabelSchema,
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((privacy, ctx) => {
    // Two entries for one directory would make its label depend on order — a silent downgrade risk.
    const seen = new Map<string, number>();
    privacy.directories.forEach((d, index) => {
      const key = normalizeDirKey(d.path);
      const first = seen.get(key);
      if (first !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["directories", index, "path"],
          message: `duplicates privacy.directories.${first} ("${d.path}"); give each directory one label`,
        });
      } else {
        seen.set(key, index);
      }
    });
  });

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
    /**
     * Required, no default (M0.1 F3): every provider states whether it may receive personal data.
     * false → only `public` data is sent to it. local_only data additionally requires
     * location: local.
     */
    privacy: z
      .object(
        {
          allowPersonalData: z.boolean({
            error: () =>
              "is required and must be true or false — AMOS never assumes a provider may receive your data",
          }),
        },
        {
          error: () =>
            "is required: add `privacy: { allowPersonalData: false }` (or true if this provider may receive your personal data)",
        },
      )
      .strict(),
    models: z.record(z.string().min(1), modelCapabilitiesSchema).default({}),
  })
  .strict()
  .superRefine((provider, ctx) => {
    const url = new URL(provider.baseUrl);
    const loopback = isLoopbackHost(url.hostname);
    // Credentials and query strings in a URL end up in config output and logs; providers get
    // their keys via apiKeyEnv (headers) only (M0.5 audit, SEC-04).
    if (url.username !== "" || url.password !== "") {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message:
          "must not contain a username or password; put the key in secrets.env and use apiKeyEnv",
      });
    }
    if (url.search !== "" || url.hash !== "") {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "must not contain a query string or fragment (keys never go in URLs)",
      });
    }
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
