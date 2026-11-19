import { AmosError } from "./errors.ts";

/**
 * Task lifecycle rules (docs/ARCHITECTURE.md §3).
 *
 * M0 defines only the state machine; the runner that drives it arrives in M1. Keeping the rules in
 * one pure module means the runner, the API and startup recovery cannot disagree about them.
 */

export const TASK_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["awaiting_approval", "interrupted", "completed", "failed", "cancelled"],
  awaiting_approval: ["running", "cancelled", "failed"],
  interrupted: ["queued", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function allowedTransitions(from: TaskStatus): readonly TaskStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new AmosError("INVALID_TASK_TRANSITION", `A task cannot move from ${from} to ${to}.`, {
      details: { from, to, allowed: TRANSITIONS[from] },
    });
  }
}

/**
 * Status a persisted task should have after amosd restarts. A task that was `running` when the
 * process died is never silently resumed: it becomes `interrupted` for the owner (or recovery logic)
 * to inspect. Tasks waiting for approval keep waiting.
 */
export function statusAfterRestart(status: TaskStatus): TaskStatus {
  return status === "running" ? "interrupted" : status;
}

export interface RecoveryFacts {
  /** A tool call was started but its outcome was never recorded. */
  readonly toolCallInFlight: boolean;
  /** The index of the last fully recorded step, or null if none was recorded. */
  readonly lastCompletedStep: number | null;
}

export type RecoveryAssessment =
  | { readonly kind: "auto_resumable" }
  | { readonly kind: "needs_owner_review"; readonly reason: string }
  | { readonly kind: "not_recoverable"; readonly reason: string };

/** Decide whether an interrupted task may be re-queued without asking the owner. */
export function assessRecovery(status: TaskStatus, facts: RecoveryFacts): RecoveryAssessment {
  if (status !== "interrupted") {
    return {
      kind: "not_recoverable",
      reason: `Only interrupted tasks can be resumed (is ${status}).`,
    };
  }
  if (facts.toolCallInFlight) {
    return {
      kind: "needs_owner_review",
      reason: "A tool call was in progress; its effects must be checked before resuming.",
    };
  }
  if (facts.lastCompletedStep === null) {
    return { kind: "needs_owner_review", reason: "No completed step was recorded." };
  }
  return { kind: "auto_resumable" };
}
