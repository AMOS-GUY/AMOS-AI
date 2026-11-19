/**
 * Permission vocabulary shared by config, the policy engine (M2) and the audit log.
 *
 * M0 defines the words only. The engine that evaluates them is M2 work and is deliberately not
 * stubbed here: a placeholder "allow everything" engine would be worse than none.
 */

/** What a tool call does to the world. A tool declares every effect it can have. */
export const EFFECTS = ["read", "write", "delete", "exec", "network", "egress"] as const;
export type Effect = (typeof EFFECTS)[number];

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Outcome of a policy evaluation. `ask` pauses the task until the owner decides. */
export const POLICY_DECISIONS = ["allow", "ask", "deny"] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];
