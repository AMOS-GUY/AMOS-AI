import { randomUUID } from "node:crypto";
import { AmosError } from "./errors.ts";

/**
 * Prefixed random identifiers ("task_<uuid>"). The prefix makes ids self-describing in logs and
 * prevents passing a conversation id where a task id is expected (enforced at compile time by the
 * brand, at runtime by `parseId`).
 */

declare const brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [brand]: B };

export const ID_PREFIXES = {
  task: "task",
  conversation: "conv",
  approval: "appr",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type Id<K extends IdKind> = Branded<string, K>;
export type TaskId = Id<"task">;
export type ConversationId = Id<"conversation">;
export type ApprovalId = Id<"approval">;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newId<K extends IdKind>(kind: K): Id<K> {
  return `${ID_PREFIXES[kind]}_${randomUUID()}` as Id<K>;
}

export function isId<K extends IdKind>(kind: K, value: unknown): value is Id<K> {
  if (typeof value !== "string") return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  return value.startsWith(prefix) && UUID_V4.test(value.slice(prefix.length));
}

/** Validate untrusted input (API parameters, DB rows) as an id of the given kind. */
export function parseId<K extends IdKind>(kind: K, value: unknown): Id<K> {
  if (isId(kind, value)) return value;
  throw new AmosError("INVALID_ID", `Not a valid ${kind} id.`, {
    details: { kind, received: typeof value === "string" ? value.slice(0, 64) : typeof value },
  });
}
