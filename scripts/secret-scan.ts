/**
 * Fails if files that would be committed contain credential-shaped strings or personal machine
 * paths. The repository is public, so this runs as part of `npm run check` and in CI.
 *
 * Scans tracked files plus untracked files that are not git-ignored (i.e. what `git add -A` would
 * pick up). Findings print file:line and the rule, never the matched value.
 *
 * Usage: node scripts/secret-scan.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface Rule {
  readonly id: string;
  readonly pattern: RegExp;
}

// Patterns are assembled from pieces so this file does not match itself.
const BEGIN = ["-----BEGIN", "PRIVATE KEY-----"];

export const RULES: readonly Rule[] = [
  { id: "private-key", pattern: new RegExp(`${BEGIN[0]} ?[A-Z ]*${BEGIN[1]}`) },
  { id: "openai-style-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { id: "github-token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { id: "aws-access-key", pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    id: "assigned-secret",
    // KEY = "long literal" for names that denote credentials. Values that are env-var *names*
    // (UPPER_SNAKE, e.g. apiKeyEnv: "DEEPSEEK_API_KEY") or paths are fine.
    pattern:
      // Case-sensitive on purpose: the lookahead must only skip genuinely upper-case values.
      /\b[A-Za-z_]*([Aa]pi[_-]?[Kk]ey|API[_-]?KEY|[Ss]ecret|SECRET|[Tt]oken|TOKEN|[Pp]assword|PASSWORD)[A-Za-z_]*["']?\s*[:=]\s*["'](?![A-Z0-9_]+["'])[A-Za-z0-9+_=.-]{16,}["']/,
  },
  {
    id: "personal-windows-path",
    // A real user profile path leaks a username. Generic placeholders are allowed.
    pattern: /\b[A-Za-z]:\\+Users\\+(?!<|%|USER|user|you|Public|Default)[^\\\s"'`]+\\/,
  },
  { id: "personal-unix-home", pattern: /\/home\/(?!user\b|you\b|runner\b|<|\$)[a-z][a-z0-9_-]*\// },
];

const SKIP_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".db", ".sqlite"]);
const SKIP_FILES = new Set(["package-lock.json"]);

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) findings.push({ file, line: index + 1, rule: rule.id });
    }
  });
  return findings;
}

export function candidateFiles(repoRoot: string): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split("\0")
    .filter(Boolean)
    .filter((f) => !SKIP_FILES.has(path.basename(f)))
    .filter((f) => !SKIP_EXTENSIONS.has(path.extname(f).toLowerCase()));
}

export function scanRepository(repoRoot: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of candidateFiles(repoRoot)) {
    const full = path.join(repoRoot, file);
    if (!fs.existsSync(full)) continue; // deleted but still in the index
    const buffer = fs.readFileSync(full);
    if (buffer.includes(0)) continue; // binary
    findings.push(...scanText(file, buffer.toString("utf8")));
  }
  return findings;
}

if (import.meta.main) {
  const root = process.cwd();
  const findings = scanRepository(root);
  if (findings.length === 0) {
    console.log(`secret-scan: ${candidateFiles(root).length} files checked, no findings.`);
  } else {
    for (const f of findings) console.error(`secret-scan: ${f.file}:${f.line} [${f.rule}]`);
    console.error(
      `secret-scan: ${findings.length} finding(s). Remove the value (secrets belong in secrets.env, outside the repo).`,
    );
    process.exitCode = 1;
  }
}
