import { AmosError } from "../core/errors.ts";
import { type Database, transaction } from "./sqlite.ts";

/**
 * Forward-only schema migrations (docs/ARCHITECTURE.md §12 "Upgrades" / "Rollback").
 *
 * Rules:
 *  - ids are consecutive from 1; a released migration is never edited or renumbered (its name is
 *    recorded and checked, which catches most accidental edits/reorders);
 *  - each migration runs in its own transaction;
 *  - a database migrated by a newer AMOS is refused rather than modified — rollback means
 *    restoring the pre-upgrade snapshot, not running old code against a new schema.
 */

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export interface MigrationResult {
  readonly applied: readonly number[];
  readonly version: number;
}

export function validateMigrations(migrations: readonly Migration[]): void {
  migrations.forEach((m, index) => {
    if (m.id !== index + 1) {
      throw new AmosError("MIGRATION_FAILED", `Migration list is not consecutive at "${m.name}".`, {
        details: { expected: index + 1, found: m.id },
      });
    }
  });
}

export function currentVersion(db: Database): number {
  ensureTable(db);
  const row = db.prepare("SELECT MAX(id) AS v FROM schema_migrations").get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

export function migrate(db: Database, migrations: readonly Migration[]): MigrationResult {
  validateMigrations(migrations);
  ensureTable(db);

  const recorded = db.prepare("SELECT id, name FROM schema_migrations ORDER BY id").all() as {
    id: number;
    name: string;
  }[];
  const newest = migrations.length;
  for (const row of recorded) {
    const known = migrations[row.id - 1];
    if (!known) {
      throw new AmosError(
        "MIGRATION_FAILED",
        `The database was created by a newer AMOS version (schema ${row.id} > ${newest}).`,
        { hint: "Run the newer AMOS version, or restore the backup taken before the upgrade." },
      );
    }
    if (known.name !== row.name) {
      throw new AmosError(
        "MIGRATION_FAILED",
        `Migration ${row.id} is recorded as "${row.name}" but the code calls it "${known.name}".`,
        { hint: "Released migrations must never be edited or renumbered." },
      );
    }
  }

  const applied: number[] = [];
  const insert = db.prepare(
    "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const m of migrations.slice(recorded.length)) {
    try {
      transaction(db, () => {
        db.exec(m.sql);
        insert.run(m.id, m.name, new Date().toISOString());
      });
    } catch (error) {
      throw new AmosError("MIGRATION_FAILED", `Migration ${m.id} (${m.name}) failed.`, {
        cause: error,
        details: { id: m.id },
      });
    }
    applied.push(m.id);
  }
  return { applied, version: newest };
}

function ensureTable(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL
     ) STRICT`,
  );
}
