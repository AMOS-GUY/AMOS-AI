import { AmosError } from "./errors.ts";

/**
 * Privacy labels and the egress gate (docs/ARCHITECTURE.md §10).
 *
 * Every boundary crossing — model request, external tool call, web request, remote client
 * response — must call `checkEgress` first. M0 implements and tests the decision rules; later
 * milestones call it from each boundary as that boundary is built.
 */

/** Ordered from least to most restrictive. */
export const PRIVACY_LABELS = ["public", "personal", "local_only", "secret"] as const;
export type PrivacyLabel = (typeof PRIVACY_LABELS)[number];

export const DESTINATIONS = [
  "local_model",
  "cloud_model",
  "external_tool",
  "remote_client",
] as const;
export type Destination = (typeof DESTINATIONS)[number];

export function restrictiveness(label: PrivacyLabel): number {
  return PRIVACY_LABELS.indexOf(label);
}

/** A context's label is the most restrictive label of anything in it. Empty context is public. */
export function combineLabels(labels: Iterable<PrivacyLabel>): PrivacyLabel {
  let result: PrivacyLabel = "public";
  for (const label of labels) {
    if (restrictiveness(label) > restrictiveness(result)) result = label;
  }
  return result;
}

export interface EgressContext {
  /**
   * For cloud_model / external_tool / remote_client: whether the owner has approved this specific
   * destination (provider on the approved list, tool allowed to receive personal data, or an
   * authenticated remote device). Ignored for local_model.
   */
  readonly destinationApproved: boolean;
}

export type EgressDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function checkEgress(
  label: PrivacyLabel,
  destination: Destination,
  context: EgressContext,
): EgressDecision {
  if (label === "secret") {
    return { allowed: false, reason: "Secrets are never sent to any destination." };
  }
  if (destination === "local_model") return { allowed: true };
  if (label === "local_only") {
    return { allowed: false, reason: `local_only data may not be sent to ${destination}.` };
  }
  if (label === "public") return { allowed: true };
  // label === "personal"
  return context.destinationApproved
    ? { allowed: true }
    : { allowed: false, reason: `personal data requires an owner-approved ${destination}.` };
}

/** Throwing variant for call sites that must stop on denial. */
export function assertEgress(
  label: PrivacyLabel,
  destination: Destination,
  context: EgressContext,
): void {
  const decision = checkEgress(label, destination, context);
  if (!decision.allowed) {
    throw new AmosError("PRIVACY_VIOLATION", decision.reason, {
      details: { label, destination },
      hint: "Use a local model, or change the directory's privacy label in config if appropriate.",
    });
  }
}
