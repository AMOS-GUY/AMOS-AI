/**
 * node:sqlite compatibility proof (ADR-003) plus the migration runner.
 *
 * These tests exercise the exact features AMOS depends on, against the SQLite build bundled in the
 * running Node binary — so running them on Windows, in Linux CI and on the laptop verifies each
 * platform independently.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../tests/helpers.ts";
import { AmosError } from "../core/errors.ts";
import { currentVersion, type Migration, migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import { openDatabase, sqliteCapabilities, transaction } from "./sqlite.ts";

describe("node:sqlite compatibility", () => {
  it("reports a modern SQLite with FTS5, JSON and STRICT tables", () => {
    const caps = sqliteCapabilities();
    const [major, minor] = caps.sqliteVersion.split(".").map(Number);
    expect(major).toBe(3);
    expect(minor).toBeGreaterThanOrEqual(37); // STRICT tables need 3.37
    expect(caps).toMatchObject({ fts5: true, json: true, strictTables: true });
  });

  it("opens a file database in WAL mode with foreign keys on, creating parent dirs", () => {
    const file = path.join(tempDir(), "nested", "dir", "amos.db");
    const db = openDatabase(file);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.close();
    expect(fs.existsSync(file)).toBe(true);
  });

  it("round-trips Unicode text and paths (Chinese file names)", () => {
    const file = path.join(tempDir(), "数据 目录", "amos.db");
    const db = openDatabase(file);
    db.exec("CREATE TABLE notes (title TEXT NOT NULL) STRICT");
    db.prepare("INSERT INTO notes VALUES (?)").run("离散数学 — 第一章 ✓");
    expect(db.prepare("SELECT title FROM notes").get()).toEqual({ title: "离散数学 — 第一章 ✓" });
    db.close();
  });

  it("supports FTS5 full-text search with ranking", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(title, body)");
    const insert = db.prepare("INSERT INTO docs (title, body) VALUES (?, ?)");
    insert.run("graphs", "a graph is a set of vertices and edges");
    insert.run("logic", "propositional logic uses truth tables");
    const rows = db
      .prepare("SELECT title FROM docs WHERE docs MATCH ? ORDER BY rank")
      .all("vertices");
    expect(rows).toEqual([{ title: "graphs" }]);
    db.close();
  });

  it("enforces STRICT column types and foreign keys", () => {
    const db = openDatabase(":memory:");
    db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
             CREATE TABLE child (pid INTEGER NOT NULL REFERENCES parent(id)) STRICT;`);
    expect(() => db.prepare("INSERT INTO parent VALUES (?)").run("not a number")).toThrow();
    expect(() => db.prepare("INSERT INTO child VALUES (?)").run(99)).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("rolls back a failed transaction completely", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (x INTEGER NOT NULL) STRICT");
    expect(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO t VALUES (1)").run();
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 0 });
    expect(transaction(db, () => db.prepare("INSERT INTO t VALUES (2)").run().changes)).toBe(1);
    db.close();
  });

  it("lets a second connection read committed data while WAL is active", () => {
    const file = path.join(tempDir(), "amos.db");
    const writer = openDatabase(file);
    writer.exec("CREATE TABLE t (x INTEGER) STRICT; INSERT INTO t VALUES (1);");
    const reader = openDatabase(file, { readOnly: true });
    writer.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES (2);");
    // Uncommitted write is invisible to the reader, and the reader is not blocked.
    expect(reader.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 1 });
    writer.exec("COMMIT");
    expect(reader.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 2 });
    expect(() => reader.exec("INSERT INTO t VALUES (3)")).toThrow();
    reader.close();
    writer.close();
  });

  it("returns integers as numbers and can opt into BigInt for large values", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (n INTEGER) STRICT");
    db.prepare("INSERT INTO t VALUES (?)").run(2n ** 62n);
    const stmt = db.prepare("SELECT n FROM t");
    stmt.setReadBigInts(true);
    expect(stmt.get()).toEqual({ n: 2n ** 62n });
    db.close();
  });

  it("wraps open failures in a STORAGE error", () => {
    const dir = tempDir();
    // A directory cannot be opened as a database file.
    expect(() => openDatabase(dir)).toThrow(AmosError);
  });
});

describe("migrations", () => {
  const sample: Migration[] = [
    { id: 1, name: "one", sql: "CREATE TABLE a (x INTEGER) STRICT" },
    { id: 2, name: "two", sql: "CREATE TABLE b (y INTEGER) STRICT" },
  ];

  it("applies pending migrations once and records them", () => {
    const db = openDatabase(":memory:");
    expect(migrate(db, sample)).toEqual({ applied: [1, 2], version: 2 });
    expect(migrate(db, sample)).toEqual({ applied: [], version: 2 });
    expect(currentVersion(db)).toBe(2);
    db.close();
  });

  it("applies only new migrations after an upgrade", () => {
    const db = openDatabase(":memory:");
    migrate(db, sample.slice(0, 1));
    expect(migrate(db, sample).applied).toEqual([2]);
    db.close();
  });

  it("rolls back a failing migration and leaves earlier ones applied", () => {
    const db = openDatabase(":memory:");
    const broken = [
      ...sample,
      { id: 3, name: "bad", sql: "CREATE TABLE c (z INTEGER); SELEC nonsense" },
    ];
    expect(() => migrate(db, broken)).toThrow(/Migration 3 \(bad\) failed/);
    expect(currentVersion(db)).toBe(2);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'c'").get()).toBeUndefined();
    db.close();
  });

  it("refuses a database from a newer AMOS version", () => {
    const db = openDatabase(":memory:");
    migrate(db, sample);
    expect(() => migrate(db, sample.slice(0, 1))).toThrow(/newer AMOS version/);
    db.close();
  });

  it("detects renamed/reordered released migrations", () => {
    const db = openDatabase(":memory:");
    migrate(db, sample);
    const renamed = [sample[0] as Migration, { ...(sample[1] as Migration), name: "renamed" }];
    expect(() => migrate(db, renamed)).toThrow(/recorded as "two"/);
    db.close();
  });

  it("rejects non-consecutive migration lists before touching the database", () => {
    const db = openDatabase(":memory:");
    expect(() => migrate(db, [{ id: 2, name: "x", sql: "" }])).toThrow(/not consecutive/);
    db.close();
  });

  it("applies the real AMOS schema to a fresh file database", () => {
    const db = openDatabase(path.join(tempDir(), "amos.db"));
    expect(migrate(db, MIGRATIONS).version).toBe(MIGRATIONS.length);
    db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?)").run("installed", "yes");
    expect(db.prepare("SELECT value FROM app_meta WHERE key = ?").get("installed")).toEqual({
      value: "yes",
    });
    db.close();
  });
});
