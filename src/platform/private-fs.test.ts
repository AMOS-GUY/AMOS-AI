/**
 * F1 regression tests: private storage permissions.
 *
 * The POSIX cases are skipped on Windows (no mode bits there) and run in Ubuntu CI and on the
 * laptop. Windows results say nothing about them.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWindows, tempDir } from "../../tests/helpers.ts";
import { AmosError } from "../core/errors.ts";
import { FileSink } from "../logging/file-sink.ts";
import { companionFiles, openDatabase } from "../storage/sqlite.ts";
import { ensurePrivateDir, ensurePrivateFile, insecureDirReason } from "./private-fs.ts";

const mode = (p: string) => fs.statSync(p).mode & 0o777;

function expectInsecure(fn: () => unknown, fragment: string): AmosError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AmosError);
    expect((error as AmosError).code).toBe("INSECURE_PERMISSIONS");
    expect((error as AmosError).message).toContain(fragment);
    return error as AmosError;
  }
  throw new Error("expected INSECURE_PERMISSIONS");
}

/** Run with a permissive umask, the worst case for file creation. */
function withUmask<T>(mask: number, fn: () => T): T {
  const previous = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
}

describe("insecureDirReason (pure, all platforms)", () => {
  it("accepts 0700 only", () => {
    expect(insecureDirReason(0o40700)).toBeNull();
    for (const m of [0o40750, 0o40755, 0o40707, 0o40701, 0o40777]) {
      expect(insecureDirReason(m)).toMatch(/other users have access/);
    }
    expect(insecureDirReason(0o40500)).toMatch(/owner lacks/);
  });
});

describe("database and log files (all platforms)", () => {
  it("keeps SQLite temporary storage in memory", () => {
    const db = openDatabase(path.join(tempDir(), "data", "amos.db"));
    expect(db.prepare("PRAGMA temp_store").get()).toEqual({ temp_store: 2 }); // 2 = MEMORY
    db.close();
  });

  it("lists every SQLite companion file that can hold data", () => {
    expect(companionFiles("/d/amos.db")).toEqual([
      "/d/amos.db-wal",
      "/d/amos.db-shm",
      "/d/amos.db-journal",
    ]);
  });

  it("a read-only open never creates a database", () => {
    const file = path.join(tempDir(), "missing.db");
    expect(() => openDatabase(file, { readOnly: true })).toThrow(/does not exist/);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe.skipIf(isWindows)("POSIX permissions (F1)", () => {
  it("creates the data dir 0700 and the database, WAL and SHM files 0600, even with umask 000", () => {
    const dir = path.join(tempDir(), "share", "amos");
    const file = path.join(dir, "amos.db");
    withUmask(0o000, () => {
      const db = openDatabase(file);
      db.exec("CREATE TABLE t (x TEXT) STRICT");
      db.prepare("INSERT INTO t VALUES (?)").run("private");
      // While the connection is open in WAL mode, -wal and -shm exist.
      expect(fs.existsSync(`${file}-wal`)).toBe(true);
      expect(fs.existsSync(`${file}-shm`)).toBe(true);
      expect(mode(dir)).toBe(0o700);
      expect(mode(file)).toBe(0o600);
      expect(mode(`${file}-wal`)).toBe(0o600);
      expect(mode(`${file}-shm`)).toBe(0o600);
      db.close();
    });
  });

  it("refuses an existing data dir that other users can access, and creates nothing in it", () => {
    const dir = path.join(tempDir(), "shared");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    const error = expectInsecure(() => openDatabase(path.join(dir, "amos.db")), "is not private");
    expect(error.hint).toContain(`chmod 700 "${dir}"`);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(mode(dir)).toBe(0o755); // never silently changed
  });

  it("tightens existing database and companion files that are too open", () => {
    const dir = path.join(tempDir(), "amos");
    fs.mkdirSync(dir, { mode: 0o700 });
    const file = path.join(dir, "amos.db");
    openDatabase(file).close(); // a clean close removes -wal/-shm
    // Simulate files left too open (e.g. restored from a backup with a 022 umask).
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(`${file}-wal`, ""); // an empty WAL is valid for SQLite
    fs.chmodSync(`${file}-wal`, 0o644);
    const db = openDatabase(file);
    expect(mode(file)).toBe(0o600);
    expect(mode(`${file}-wal`)).toBe(0o600);
    db.close();
  });

  it("refuses a database path that is a symbolic link", () => {
    const dir = path.join(tempDir(), "amos");
    fs.mkdirSync(dir, { mode: 0o700 });
    const elsewhere = path.join(tempDir(), "elsewhere.db");
    fs.writeFileSync(elsewhere, "");
    fs.symlinkSync(elsewhere, path.join(dir, "amos.db"));
    expectInsecure(() => openDatabase(path.join(dir, "amos.db")), "symbolic link");
  });

  it("refuses a symlinked WAL file (could redirect writes)", () => {
    const dir = path.join(tempDir(), "amos");
    fs.mkdirSync(dir, { mode: 0o700 });
    const file = path.join(dir, "amos.db");
    openDatabase(file).close();
    fs.rmSync(`${file}-wal`, { force: true });
    fs.symlinkSync(path.join(tempDir(), "x"), `${file}-wal`);
    expectInsecure(() => openDatabase(file), "symbolic link");
  });

  it("checks read-only opens too", () => {
    const dir = path.join(tempDir(), "amos");
    fs.mkdirSync(dir, { mode: 0o700 });
    const file = path.join(dir, "amos.db");
    openDatabase(file).close();
    fs.chmodSync(dir, 0o755);
    expectInsecure(() => openDatabase(file, { readOnly: true }), "is not private");
  });

  it("creates files 0600 and leaves an existing private file alone", () => {
    const dir = tempDir();
    const file = path.join(dir, "f");
    withUmask(0o000, () =>
      expect(ensurePrivateFile(file)).toMatchObject({ created: true, tightened: false }),
    );
    expect(mode(file)).toBe(0o600);
    expect(ensurePrivateFile(file)).toMatchObject({ created: false, tightened: false });
  });

  it("creates missing parent directories private", () => {
    const root = tempDir();
    withUmask(0o000, () => ensurePrivateDir(path.join(root, "a", "b")));
    expect(mode(path.join(root, "a"))).toBe(0o700);
    expect(mode(path.join(root, "a", "b"))).toBe(0o700);
  });

  it("applies the same rules to log files", () => {
    const shared = path.join(tempDir(), "logs");
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o755);
    const sink = new FileSink({ dir: shared, maxBytes: 1024, maxFiles: 2 });
    expectInsecure(() => sink.write({ time: "t", level: "info", msg: "x" }), "is not private");
    expect(fs.readdirSync(shared)).toEqual([]);

    const privateDir = path.join(tempDir(), "private-logs");
    fs.mkdirSync(privateDir, { mode: 0o700 });
    fs.writeFileSync(path.join(privateDir, "amos.log.1"), "old\n");
    fs.chmodSync(path.join(privateDir, "amos.log.1"), 0o644);
    new FileSink({ dir: privateDir, maxBytes: 1024, maxFiles: 2 }).write({
      time: "t",
      level: "info",
      msg: "x",
    });
    expect(mode(path.join(privateDir, "amos.log"))).toBe(0o600);
    expect(mode(path.join(privateDir, "amos.log.1"))).toBe(0o600);
  });
});
