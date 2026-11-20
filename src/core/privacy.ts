import { AmosError } from "./errors.ts";

/**
 * Privacy labels and egress decisions (docs/ARCHITECTURE.md §10, ADR-012, M0.1 F2/F3).
 *
 * Labels, least to most restrictive:
 *   public      — may go anywhere
 *   personal    — local models, and providers whose config says allowPersonalData: true
 *   local_only  — only local (loopback) providers that also allow personal data
 *   secret      — never sent anywhere
 *
 * Fail-closed rules implemented here:
 *  - Unclassified data is `local_only` (DEFAULT_UNCLASSIFIED_LABEL), never public.
 *  - Unknown labels or recipients are rejected/denied, including values that bypass TypeScript
 *    (from JSON, the database or plain JavaScript).
 *  - Combining labels requires at least one label; the most restrictive one wins.
 *  - Lowering a label requires an explicit owner reclassification with a reason; `secret` can
 *    never be lowered.
 *
 * This module is pure. The enforcement point that uses it is src/core/egress-gate.ts.
 */

export const PRIVACY_LABELS = ["public", "personal", "local_only", "secret"] as const;
export type PrivacyLabel = (typeof PRIVACY_LABELS)[number];

/** Label for any data nobody classified. Conservative on purpose: unclassified data stays local. */
export const DEFAULT_UNCLASSIFIED_LABEL: PrivacyLabel = "local_only";

export function isPrivacyLabel(value: unknown): value is PrivacyLabel {
  return typeof value === "string" && (PRIVACY_LABELS as readonly string[]).includes(value);
}

/** Validate an untrusted label value. Throws instead of guessing. */
export function parsePrivacyLabel(value: unknown): PrivacyLabel {
  if (isPrivacyLabel(value)) return value;
  throw new AmosError("PRIVACY_VIOLATION", "Unknown privacy label.", {
    details: { received: typeof value === "string" ? value.slice(0, 32) : typeof value },
    hint: `Valid labels: ${PRIVACY_LABELS.join(", ")}.`,
  });
}

export function restrictiveness(label: PrivacyLabel): number {
  return PRIVACY_LABELS.indexOf(parsePrivacyLabel(label));
}

/**
 * The label of a combination of data is the most restrictive label among its parts. An empty input
 * is an error: "no labels" almost always means a caller forgot to label its data, and treating it
 * as public would be a silent downgrade.
 */
export function combineLabels(labels: Iterable<PrivacyLabel>): PrivacyLabel {
  let result: PrivacyLabel | undefined;
  for (const raw of labels) {
    const label = parsePrivacyLabel(raw);
    if (result === undefined || restrictiveness(label) > restrictiveness(result)) result = label;
  }
  if (result === undefined) {
    throw new AmosError("PRIVACY_VIOLATION", "Cannot combine an empty set of privacy labels.", {
      hint: "Every piece of data must carry a label; use DEFAULT_UNCLASSIFIED_LABEL when unknown.",
    });
  }
  return result;
}

/** An owner's deliberate decision to lower a label. Comes from an authenticated owner action. */
export interface OwnerReclassification {
  readonly kind: "owner_reclassification";
  /** Recorded in the audit log; must say why the data may be shared more widely. */
  readonly reason: string;
}

/**
 * Change a label. Raising (more restrictive) is always allowed. Lowering requires an
 * OwnerReclassification with a non-empty reason. `secret` is never lowered — secrets are
 * identified by the secret store, and no reason makes it safe to send one.
 */
export function relabel(
  current: PrivacyLabel,
  next: PrivacyLabel,
  authorization?: OwnerReclassification,
): PrivacyLabel {
  const from = parsePrivacyLabel(current);
  const to = parsePrivacyLabel(next);
  if (restrictiveness(to) >= restrictiveness(from)) return to;
  if (from === "secret") {
    throw new AmosError("PRIVACY_VIOLATION", "Secret data can never be reclassified.");
  }
  const valid =
    authorization !== undefined &&
    authorization !== null &&
    authorization.kind === "owner_reclassification" &&
    typeof authorization.reason === "string" &&
    authorization.reason.trim().length > 0;
  if (!valid) {
    throw new AmosError(
      "PRIVACY_VIOLATION",
      `Lowering a label from ${from} to ${to} requires an explicit owner reclassification with a reason.`,
    );
  }
  return to;
}

/** Who would receive the data. Built from validated config by the egress gate, never by callers. */
export type Recipient =
  | {
      readonly kind: "model_provider";
      readonly providerId: string;
      readonly location: "local" | "cloud";
      readonly enabled: boolean;
      readonly allowPersonalData: boolean;
    }
  /** External tools (M3) and remote clients (M5) have no data policy yet: public data only. */
  | { readonly kind: "external_tool"; readonly toolId: string }
  | { readonly kind: "remote_client"; readonly clientId: string };

export type EgressDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

const deny = (reason: string): EgressDecision => ({ allowed: false, reason });

/** Pure decision. Validates its inputs at runtime and denies anything it does not recognise. */
export function decideEgress(label: PrivacyLabel, recipient: Recipient): EgressDecision {
  if (!isPrivacyLabel(label)) return deny("Unknown privacy label.");
  if (label === "secret") return deny("Secret data is never sent to any recipient.");
  if (recipient === null || typeof recipient !== "object") return deny("Unknown recipient.");

  switch (recipient.kind) {
    case "model_provider": {
      if (recipient.enabled !== true) return deny(`Provider ${recipient.providerId} is disabled.`);
      if (label === "public") return { allowed: true };
      // Strict `=== true`: a missing or non-boolean policy never grants permission.
      if (recipient.allowPersonalData !== true) {
        return deny(
          `Provider ${recipient.providerId} is not allowed to receive ${label} data (privacy.allowPersonalData is not true).`,
        );
      }
      if (label === "local_only" && recipient.location !== "local") {
        return deny(
          `local_only data never leaves this machine; ${recipient.providerId} is a cloud provider.`,
        );
      }
      return { allowed: true };
    }
    case "external_tool":
    case "remote_client":
      return label === "public"
        ? { allowed: true }
        : deny(
            `No privacy policy exists yet for ${recipient.kind} recipients; only public data may be sent.`,
          );
    default:
      return deny("Unknown recipient kind.");
  }
}
