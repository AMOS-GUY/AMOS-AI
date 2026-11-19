import type { Migration } from "./migrate.ts";

/**
 * The AMOS schema, in order. Append only. M0 creates only installation metadata; tasks,
 * conversations, approvals, audit and usage tables arrive with the milestones that use them.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "app_meta",
    sql: `CREATE TABLE app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          ) STRICT`,
  },
];
