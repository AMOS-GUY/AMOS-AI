import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

/** A fresh temporary directory, removed after the current test. */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amos-test-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Collects everything written to it, for asserting CLI output. */
export class Capture {
  text = "";
  write(chunk: string | Uint8Array): boolean {
    this.text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }
}

export const isWindows = process.platform === "win32";
