import { AmosError } from "./errors.ts";
import {
  combineLabels,
  decideEgress,
  type PrivacyLabel,
  parsePrivacyLabel,
  type Recipient,
} from "./privacy.ts";

/**
 * The single enforcement point for data leaving AMOS (M0.1, F2/F3).
 *
 * How it prevents bypasses:
 *  - Provider policy comes only from validated configuration, handed to the gate once at startup.
 *    Callers name a provider id; they cannot claim "this destination is approved".
 *  - The gate computes the combined label itself from every item's own label. Items without a
 *    valid label are rejected, so "forgot to label" cannot become "public".
 *  - A successful check returns an EgressClearance holding the *serialised* request body (an
 *    immutable string), bound to the provider's URL origin. Nothing can be swapped in after the
 *    check.
 *  - Clearances are registered in a module-private WeakSet. A copied or hand-built object is not a
 *    clearance. The HTTP transport (src/net/http.ts) only sends request bodies that carry a genuine
 *    clearance whose origin matches the request URL.
 *
 * What it cannot prevent: code inside AMOS that deliberately smuggles data into the body through
 * the `build` callback's closure. The contract — build the body only from `contents` — is enforced
 * by review and tests, not by the runtime. The threat model is mistakes and injected instructions,
 * not malicious AMOS code.
 */

export interface ProviderPolicy {
  readonly providerId: string;
  readonly location: "local" | "cloud";
  readonly enabled: boolean;
  readonly allowPersonalData: boolean;
  /** `new URL(baseUrl).origin`, e.g. "https://api.deepseek.com". */
  readonly origin: string;
}

export interface LabeledData {
  readonly label: PrivacyLabel;
  readonly content: unknown;
}

export interface EgressClearance {
  readonly providerId: string;
  readonly origin: string;
  readonly label: PrivacyLabel;
  /** Exactly the bytes that may be sent (JSON). */
  readonly body: string;
  readonly contentType: "application/json";
}

const issued = new WeakSet<object>();

export class EgressGate {
  readonly #providers: ReadonlyMap<string, ProviderPolicy>;

  constructor(policies: Iterable<ProviderPolicy>) {
    const map = new Map<string, ProviderPolicy>();
    for (const p of policies) {
      if (map.has(p.providerId)) {
        throw new AmosError("PRIVACY_VIOLATION", `Duplicate provider policy for ${p.providerId}.`);
      }
      if (typeof p.allowPersonalData !== "boolean" || typeof p.enabled !== "boolean") {
        throw new AmosError(
          "PRIVACY_VIOLATION",
          `Provider ${p.providerId} has an incomplete privacy policy.`,
        );
      }
      map.set(p.providerId, Object.freeze({ ...p }));
    }
    this.#providers = map;
  }

  /** The policy for a provider, or undefined. For diagnostics (`amos doctor`, config show). */
  policy(providerId: string): ProviderPolicy | undefined {
    return this.#providers.get(providerId);
  }

  /**
   * Check that every item may be sent to `providerId`, then serialise the request body.
   *
   * @param build Builds the provider request body from the items' contents (in order). It must
   *   not add data from anywhere else.
   * @throws AmosError PRIVACY_VIOLATION when any item may not go to this provider.
   */
  authorizeForProvider(
    providerId: string,
    items: readonly LabeledData[],
    build: (contents: readonly unknown[]) => unknown,
  ): EgressClearance {
    const policy = this.#providers.get(providerId);
    if (!policy) {
      throw new AmosError(
        "PRIVACY_VIOLATION",
        `Unknown provider "${providerId}"; nothing is sent to unconfigured destinations.`,
      );
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new AmosError(
        "PRIVACY_VIOLATION",
        "An outbound request must declare the data it contains.",
      );
    }
    const labels = items.map((item, index) => {
      try {
        return parsePrivacyLabel((item as Partial<LabeledData> | null)?.label);
      } catch {
        throw new AmosError(
          "PRIVACY_VIOLATION",
          `Outbound item ${index} has no valid privacy label.`,
        );
      }
    });
    const label = combineLabels(labels);
    const recipient: Recipient = {
      kind: "model_provider",
      providerId: policy.providerId,
      location: policy.location,
      enabled: policy.enabled,
      allowPersonalData: policy.allowPersonalData,
    };
    const decision = decideEgress(label, recipient);
    if (!decision.allowed) {
      throw new AmosError("PRIVACY_VIOLATION", decision.reason, {
        details: { providerId, label },
        hint:
          label === "local_only"
            ? "Use a local provider, or reclassify the data (owner decision)."
            : "Set privacy.allowPersonalData: true for this provider only if you accept it receiving your data.",
      });
    }
    const contents = Object.freeze(items.map((i) => i.content));
    let body: string | undefined;
    try {
      body = JSON.stringify(build(contents));
    } catch (error) {
      throw new AmosError(
        "PRIVACY_VIOLATION",
        "The request body could not be serialised as JSON.",
        {
          cause: error,
        },
      );
    }
    if (typeof body !== "string") {
      throw new AmosError("PRIVACY_VIOLATION", "The request body could not be serialised as JSON.");
    }
    const clearance: EgressClearance = Object.freeze({
      providerId: policy.providerId,
      origin: policy.origin,
      label,
      body,
      contentType: "application/json",
    });
    issued.add(clearance);
    return clearance;
  }
}

/**
 * Used by the transport before sending a body. Throws unless `value` is a clearance issued by an
 * EgressGate in this process and `url` has the origin it was issued for.
 */
export function verifyClearance(value: unknown, url: URL): EgressClearance {
  if (value === null || typeof value !== "object" || !issued.has(value)) {
    throw new AmosError(
      "PRIVACY_VIOLATION",
      "Refusing to send a request body without an egress clearance.",
    );
  }
  const clearance = value as EgressClearance;
  if (url.origin !== clearance.origin) {
    throw new AmosError(
      "PRIVACY_VIOLATION",
      `This clearance was issued for ${clearance.origin}, not ${url.origin}.`,
      { details: { providerId: clearance.providerId } },
    );
  }
  return clearance;
}
