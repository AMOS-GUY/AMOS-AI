import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AmosError } from "../core/errors.ts";
import {
  ensurePrivateDir,
  ensurePrivateFile,
  securePrivateFilesIfPresent,
} from "../platform/private-fs.ts";

/**
 * Thin wrapper around Node's built-in `node:sqlite` (ADR-003).
 *
 * Only this folder imports node:sqlite, so swapping to better-sqlite3 later would touch one place.
 */

export type Database = DatabaseSync;

export interface OpenOptions {
  readonly readOnly?: boolean;
}

/** SQLite's companion files for a database; they hold the same data as the database itself. */
export function companionFiles(file: string): string[] {
  return [`${file}-wal`, `${file}-shm`, `${file}-journal`];
}

/**
 * Open (creating if needed) a database file with AMOS's standard settings.
 *
 * File security (POSIX, see src/platform/private-fs.ts): the containing directory must be
 * private (created 0700, or refused if an existing one is open to others); the database file is
 * pre-created 0600 before SQLite touches it; existing database/WAL/SHM/journal files are tightened
 * to 0600. SQLite creates its -wal/-shm/-journal files with the database file's mode, so they
 * inherit 0600. Temporary tables and sort spills stay in memory (`temp_store = MEMORY`), so no
 * database content is written to the system temp directory.
 */
export function openDatabase(file: string, options: OpenOptions = {}): Database {
  const inMemory = file === ":memory:";
  if (!inMemory) {
    if (options.readOnly) {
      // Read-only callers never create anything, but still refuse insecure locations.
      if (!fs.existsSync(file)) {
        throw new AmosError("STORAGE", `Database ${file} does not exist.`);
      }
      ensurePrivateDir(path.dirname(file));
    } else {
      ensurePrivateDir(path.dirname(file));
      ensurePrivateFile(file);
    }
    securePrivateFilesIfPresent([file, ...companionFiles(file)]);
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
    db.exec("PRAGMA temp_store = MEMORY");
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
