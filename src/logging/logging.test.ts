import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isWindows, tempDir } from "../../tests/helpers.ts";
import { AmosError } from "../core/errors.ts";
import { FileSink } from "./file-sink.ts";
import { Logger, type LogRecord, MemorySink } from "./logger.ts";
import { MIN_MASKABLE_SECRET_LENGTH, REDACTED, Redactor } from "./redact.ts";

const fixedClock = () => new Date("2026-11-20T00:00:00.000Z");

function setup(level: "debug" | "info" | "warn" | "error" = "debug") {
  const sink = new MemorySink();
  const redactor = new Redactor();
  const logger = new Logger({ level, sinks: [sink], redactor, clock: fixedClock });
  return { sink, redactor, logger };
}

describe("Logger", () => {
  it("writes structured records with time, level, msg and fields", () => {
    const { sink, logger } = setup();
    logger.info("started", { component: "test", durationMs: 12 });
    expect(sink.records).toEqual([
      {
        time: "2026-11-20T00:00:00.000Z",
        level: "info",
        msg: "started",
        component: "test",
        durationMs: 12,
      },
    ]);
  });

  it("filters below the configured level", () => {
    const { sink, logger } = setup("warn");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(sink.records.map((r) => r.level)).toEqual(["warn", "error"]);
    expect(logger.isLevelEnabled("info")).toBe(false);
  });

  it("adds child bindings and lets call fields override them", () => {
    const { sink, logger } = setup();
    logger.child({ component: "storage", task: "t1" }).info("x", { task: "t2" });
    expect(sink.records[0]).toMatchObject({ component: "storage", task: "t2" });
  });

  it("protects the record envelope from caller fields", () => {
    const { sink, logger } = setup();
    logger.info("real", { level: "fake", msg: "fake", time: "fake" });
    const r = sink.records[0] as LogRecord;
    expect(r.level).toBe("info");
    expect(r.msg).toBe("real");
    expect(r["field_level"]).toBe("fake");
  });

  it("redacts secret-named fields, registered values and credential shapes", () => {
    const { sink, logger, redactor } = setup();
    redactor.addSecret("my-registered-secret-value");
    logger.info("calling provider with my-registered-secret-value", {
      apiKey: "abc",
      headers: { Authorization: "Bearer abc.def.ghi.jkl" },
      note: "token was Bearer abcdefghijklmnop",
      url: "https://x.example/?q=my-registered-secret-value",
    });
    const json = JSON.stringify(sink.records);
    expect(json).not.toContain("my-registered-secret-value");
    expect(json).not.toContain("abcdefghijklmnop");
    expect(sink.records[0]).toMatchObject({
      apiKey: REDACTED,
      headers: { Authorization: REDACTED },
    });
  });

  it("omits document/prompt content, logging only its size", () => {
    const { sink, logger } = setup();
    logger.info("read file", {
      path: "/notes/a.md",
      content: "private lecture notes",
      messages: [1, 2, 3],
    });
    expect(sink.records[0]).toMatchObject({
      path: "/notes/a.md",
      content: "[omitted 21 chars]",
      messages: "[omitted 3 items]",
    });
  });

  it("serialises errors (code, hint, cause) with redaction", () => {
    const { sink, logger, redactor } = setup();
    redactor.addSecret("supersecretvalue");
    const err = new AmosError("STORAGE", "failed with supersecretvalue", {
      hint: "check disk",
      cause: new Error("inner"),
    });
    logger.error("boom", { err });
    const logged = sink.records[0]?.["err"] as Record<string, unknown>;
    expect(logged["code"]).toBe("STORAGE");
    expect(logged["hint"]).toBe("check disk");
    expect(logged["message"]).toBe(`failed with ${REDACTED}`);
    expect((logged["cause"] as Record<string, unknown>)["message"]).toBe("inner");
    expect(String(logged["stack"])).not.toContain("supersecretvalue");
  });

  it("survives circular structures, bigint and deep nesting", () => {
    const { sink, logger } = setup();
    const a: Record<string, unknown> = { n: 1n };
    a["self"] = a;
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 20; i++) {
      deep["next"] = {};
      deep = deep["next"] as Record<string, unknown>;
    }
    logger.info("odd", { a, root });
    const r = sink.records[0] as LogRecord;
    expect(r["a"]).toEqual({ n: "1", self: "[Circular]" });
    expect(JSON.stringify(r)).toContain("[Truncated]");
  });

  it("keeps working when a sink throws", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const good = new MemorySink();
    const logger = new Logger({
      level: "info",
      sinks: [
        {
          write: () => {
            throw new Error("disk full");
          },
        },
        good,
      ],
    });
    expect(() => logger.info("a")).not.toThrow();
    logger.info("b");
    expect(good.records).toHaveLength(2);
    stderr.mockRestore();
  });
});

describe("Redactor", () => {
  it("redacts credential field names but keeps usage counters and status messages", () => {
    const out = new Redactor().redactValue({
      accessToken: "a",
      auth_token: "b",
      refreshToken: "c",
      clientSecret: "d",
      api_key: "e",
      passphrase: "f",
      inputTokens: 120,
      maxOutputTokens: 4096,
      tokenCount: 7,
      tokenizer: "bpe",
      message: "connection refused",
    });
    expect(out).toEqual({
      accessToken: REDACTED,
      auth_token: REDACTED,
      refreshToken: REDACTED,
      clientSecret: REDACTED,
      api_key: REDACTED,
      passphrase: REDACTED,
      inputTokens: 120,
      maxOutputTokens: 4096,
      tokenCount: 7,
      tokenizer: "bpe",
      message: "connection refused",
    });
  });

  it("does not substring-mask very short secrets (would mangle logs)", () => {
    const r = new Redactor();
    r.addSecret("a".repeat(MIN_MASKABLE_SECRET_LENGTH - 1));
    expect(r.redactString("aaaaaaa banana")).toBe("aaaaaaa banana");
  });

  it("masks overlapping secrets fully", () => {
    const r = new Redactor();
    r.addSecret("abcdefgh");
    r.addSecret("abcdefgh-ijkl");
    expect(r.redactString("v=abcdefgh-ijkl")).toBe(`v=${REDACTED}`);
  });

  it("masks private key blocks and common token formats", () => {
    const r = new Redactor();
    const pem = [
      "-----BEGIN",
      "OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH",
      "PRIVATE KEY-----",
    ].join(" ");
    expect(r.redactString(`key: ${pem}`)).toBe(`key: ${REDACTED}`);
    expect(r.redactString(`ghp_${"a".repeat(36)}`)).toBe(REDACTED);
    expect(r.redactString(`sk-${"b".repeat(32)}`)).toBe(REDACTED);
  });

  it("does not mutate the input", () => {
    const input = { password: "x", nested: { token: "y" } };
    new Redactor().redactValue(input);
    expect(input).toEqual({ password: "x", nested: { token: "y" } });
  });
});

describe("FileSink", () => {
  const record = (msg: string): LogRecord => ({ time: "t", level: "info", msg });

  it("creates nothing until the first write", () => {
    const dir = path.join(tempDir(), "logs");
    const sink = new FileSink({ dir, maxBytes: 1024, maxFiles: 3 });
    expect(fs.existsSync(dir)).toBe(false);
    sink.write(record("hello"));
    expect(fs.readFileSync(sink.file, "utf8")).toBe(`${JSON.stringify(record("hello"))}\n`);
  });

  it("rotates by size and keeps at most maxFiles files", () => {
    const dir = tempDir();
    const sink = new FileSink({ dir, maxBytes: 200, maxFiles: 3 });
    for (let i = 0; i < 40; i++) sink.write(record(`message number ${i} ${"x".repeat(30)}`));
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(["amos.log", "amos.log.1", "amos.log.2"]);
    for (const f of files) expect(fs.statSync(path.join(dir, f)).size).toBeLessThanOrEqual(200);
    // Newest record is in the active file, and lines are intact JSON.
    const active = fs.readFileSync(path.join(dir, "amos.log"), "utf8").trim().split("\n");
    expect(JSON.parse(active[active.length - 1] as string).msg).toContain("message number 39");
  });

  it("with maxFiles = 1, truncates instead of keeping rotated files", () => {
    const dir = tempDir();
    const sink = new FileSink({ dir, maxBytes: 120, maxFiles: 1 });
    for (let i = 0; i < 10; i++) sink.write(record(`line ${i} ${"y".repeat(40)}`));
    expect(fs.readdirSync(dir)).toEqual(["amos.log"]);
    expect(fs.readFileSync(sink.file, "utf8")).toContain("line 9");
  });

  it("appends to an existing file across restarts", () => {
    const dir = tempDir();
    new FileSink({ dir, maxBytes: 10_000, maxFiles: 2 }).write(record("first"));
    new FileSink({ dir, maxBytes: 10_000, maxFiles: 2 }).write(record("second"));
    expect(fs.readFileSync(path.join(dir, "amos.log"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it.skipIf(isWindows)("creates owner-only log files and directories", () => {
    const dir = path.join(tempDir(), "logs");
    const sink = new FileSink({ dir, maxBytes: 1024, maxFiles: 2 });
    sink.write(record("x"));
    expect(fs.statSync(sink.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe("Redactor.containsKnownSecret", () => {
  it("finds registered values raw or JSON-escaped, ignores short values", () => {
    const r = new Redactor();
    r.addSecret('abc"defghi');
    r.addSecret("short");
    expect(r.containsKnownSecret('x abc"defghi y')).toBe(true);
    expect(r.containsKnownSecret(JSON.stringify({ v: 'abc"defghi' }))).toBe(true);
    expect(r.containsKnownSecret("short")).toBe(false);
    expect(r.containsKnownSecret("nothing here")).toBe(false);
  });
});
