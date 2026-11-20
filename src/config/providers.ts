import { EgressGate, type ProviderPolicy } from "../core/egress-gate.ts";
import type { Redactor } from "../logging/redact.ts";
import type { AmosConfig } from "./schema.ts";

/**
 * Turn validated provider configuration into the egress gate's policy table. This is the only
 * place provider privacy policy is derived, so the gate and diagnostics can never disagree.
 */
export function providerPolicies(config: AmosConfig): ProviderPolicy[] {
  return Object.entries(config.providers).map(([providerId, p]) => ({
    providerId,
    location: p.location,
    enabled: p.enabled,
    allowPersonalData: p.privacy.allowPersonalData,
    origin: new URL(p.baseUrl).origin,
  }));
}

/** @param redactor Its registered secret values are refused in any outbound body. */
export function createEgressGate(config: AmosConfig, redactor?: Redactor): EgressGate {
  return new EgressGate(
    providerPolicies(config),
    redactor ? (body) => redactor.containsKnownSecret(body) : undefined,
  );
}
