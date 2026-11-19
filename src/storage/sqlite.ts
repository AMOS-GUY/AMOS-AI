import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AmosError } from "../core/errors.ts";

/**
 * Thin wrapper around Node's built-in `node:sqlite` (ADR-003).
 *
 * Only this folder imports node:sqlite, so swapping to better-sqlite3 later would touch one place.
 */

export type Database = DatabaseSync;

export interface OpenOptions {
  readonly readOnly?: boolean;
}

/** Open (creating if needed) a database file with AMOS's standard settings. */
export function openDatabase(file: string, options: OpenOptions = {}): Database {
  const inMemory = file === ":memory:";
  if (!inMemory && !options.readOnly) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  let db: Database;
  try {
    db = new DatabaseSync(file, { readOnly: options.readOnly ?? false });
  } catch (error) {
    throw new AmosError("STORAGE", `Cannot open database ${file}.`, { cause: error });
  }
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (!inMemory && !options.readOnly) {
      // WAL: readers don't block the writer, and a crash mid-write cannot corrupt committed data.
      const row = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string };
      if (row.journal_mode !== "wal") {
        throw new AmosError("STORAGE", `SQLite refused WAL mode for ${file}.`, {
          details: { journalMode: row.journal_mode },
          hint: "The data directory may be on a filesystem without shared-memory support (e.g. a network drive).",
        });
      }
      db.exec("PRAGMA synchronous = NORMAL");
    }
  } catch (error) {
    db.close();
    throw error instanceof AmosError
      ? error
      : new AmosError("STORAGE", `Cannot configure database ${file}.`, { cause: error });
  }
  return db;
}

/** Run `fn` in a transaction; roll back if it throws. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface SqliteCapabilities {
  readonly sqliteVersion: string;
  readonly fts5: boolean;
  readonly json: boolean;
  readonly strictTables: boolean;
}

/** Probe the SQLite build bundled with this Node binary (used by tests and `amos doctor`). */
export function sqliteCapabilities(): SqliteCapabilities {
  const db = new DatabaseSync(":memory:");
  try {
    const { v } = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
    return {
      sqliteVersion: v,
      fts5: succeeds(db, "CREATE VIRTUAL TABLE probe_fts USING fts5(body)"),
      json: succeeds(db, "SELECT json_extract('{\"a\":1}', '$.a')"),
      strictTables: succeeds(db, "CREATE TABLE probe_strict (x INTEGER) STRICT"),
    };
  } finally {
    db.close();
  }
}

function succeeds(db: Database, sql: string): boolean {
  try {
    db.exec(sql);
    return true;
  } catch {
    return false;
  }
}
