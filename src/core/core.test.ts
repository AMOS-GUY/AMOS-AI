import { describe, expect, it } from "vitest";
import { AmosError, formatErrorForUser, isAmosError, toAmosError } from "./errors.ts";
import { isId, newId, parseId } from "./ids.ts";
import {
  allowedTransitions,
  assertTransition,
  assessRecovery,
  canTransition,
  isTaskStatus,
  isTerminal,
  statusAfterRestart,
  TASK_STATUSES,
} from "./task.ts";

describe("errors", () => {
  it("keeps code, hint, details and cause", () => {
    const cause = new Error("disk full");
    const e = new AmosError("STORAGE", "Cannot write.", {
      hint: "Free space.",
      cause,
      details: { a: 1 },
    });
    expect(e).toBeInstanceOf(Error);
    expect(isAmosError(e)).toBe(true);
    expect(e.code).toBe("STORAGE");
    expect(e.cause).toBe(cause);
    expect(e.details).toEqual({ a: 1 });
    expect(formatErrorForUser(e)).toBe("error [STORAGE]: Cannot write.\nhint: Free space.");
  });

  it("wraps unknown throwables as INTERNAL without losing them", () => {
    const original = new TypeError("boom");
    const wrapped = toAmosError(original);
    expect(wrapped.code).toBe("INTERNAL");
    expect(wrapped.message).toBe("boom");
    expect(wrapped.cause).toBe(original);
    expect(toAmosError("plain string").message).toBe("plain string");
    const existing = new AmosError("CONFIG_INVALID", "x");
    expect(toAmosError(existing)).toBe(existing);
  });
});

describe("ids", () => {
  it("creates prefixed, unique, valid ids", () => {
    const a = newId("task");
    const b = newId("task");
    expect(a).toMatch(/^task_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
    expect(isId("task", a)).toBe(true);
  });

  it("rejects ids of the wrong kind or shape", () => {
    const conv = newId("conversation");
    expect(isId("task", conv)).toBe(false);
    expect(() => parseId("task", conv)).toThrow(AmosError);
    expect(() => parseId("task", "task_not-a-uuid")).toThrow(/Not a valid task id/);
    expect(() => parseId("task", 42)).toThrow(AmosError);
    expect(parseId("conversation", conv)).toBe(conv);
  });
});

describe("task lifecycle", () => {
  it("allows the documented happy path", () => {
    const path = ["queued", "running", "awaiting_approval", "running", "completed"] as const;
    for (let i = 1; i < path.length; i++) {
      expect(canTransition(path[i - 1] as never, path[i] as never)).toBe(true);
    }
  });

  it("supports interruption and resumption through the queue", () => {
    expect(canTransition("running", "interrupted")).toBe(true);
    expect(canTransition("interrupted", "queued")).toBe(true);
    // Resuming never jumps straight back to running.
    expect(canTransition("interrupted", "running")).toBe(false);
  });

  it("makes terminal states final", () => {
    for (const status of TASK_STATUSES.filter(isTerminal)) {
      expect(allowedTransitions(status)).toEqual([]);
      for (const to of TASK_STATUSES) expect(canTransition(status, to)).toBe(false);
    }
    expect(TASK_STATUSES.filter(isTerminal).sort()).toEqual(["cancelled", "completed", "failed"]);
  });

  it("lets every non-terminal state be cancelled (kill switch requirement)", () => {
    for (const status of TASK_STATUSES.filter((s) => !isTerminal(s))) {
      expect(canTransition(status, "cancelled")).toBe(true);
    }
  });

  it("only reaches each non-queued state from a defined predecessor", () => {
    // Every state is reachable from queued.
    const reachable = new Set(["queued"]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of [...reachable]) {
        for (const next of allowedTransitions(s as never)) {
          if (!reachable.has(next)) {
            reachable.add(next);
            grew = true;
          }
        }
      }
    }
    expect([...reachable].sort()).toEqual([...TASK_STATUSES].sort());
  });

  it("throws a descriptive error on illegal transitions", () => {
    expect(() => assertTransition("completed", "running")).toThrow(
      "A task cannot move from completed to running.",
    );
    expect(() => assertTransition("queued", "running")).not.toThrow();
  });

  it("marks running tasks interrupted after a restart and leaves others alone", () => {
    expect(statusAfterRestart("running")).toBe("interrupted");
    expect(statusAfterRestart("awaiting_approval")).toBe("awaiting_approval");
    expect(statusAfterRestart("queued")).toBe("queued");
    expect(statusAfterRestart("completed")).toBe("completed");
  });

  it("requires owner review when a tool call's outcome is unknown", () => {
    expect(
      assessRecovery("interrupted", { toolCallInFlight: true, lastCompletedStep: 3 }).kind,
    ).toBe("needs_owner_review");
    expect(
      assessRecovery("interrupted", { toolCallInFlight: false, lastCompletedStep: null }).kind,
    ).toBe("needs_owner_review");
    expect(
      assessRecovery("interrupted", { toolCallInFlight: false, lastCompletedStep: 2 }).kind,
    ).toBe("auto_resumable");
    expect(assessRecovery("failed", { toolCallInFlight: false, lastCompletedStep: 2 }).kind).toBe(
      "not_recoverable",
    );
  });

  it("validates untrusted status strings", () => {
    expect(isTaskStatus("running")).toBe(true);
    expect(isTaskStatus("RUNNING")).toBe(false);
    expect(isTaskStatus(undefined)).toBe(false);
  });
});
