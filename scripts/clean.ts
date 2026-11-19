/**
 * Cross-platform removal of build output. Refuses anything outside the repository root, so a bad
 * argument cannot delete unrelated files.
 *
 * Usage: node scripts/clean.ts dist [more-dirs…]
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
for (const arg of process.argv.slice(2)) {
  const target = path.resolve(root, arg);
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    console.error(`clean: refusing to remove ${target} (outside the repository)`);
    process.exit(1);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
