import fs from "node:fs";
import { AmosError } from "../core/errors.ts";

/**
 * Owner-only directories and files for sensitive data (database, logs, later backups).
 *
 * Model (POSIX):
 *  - The *directory* is the real protection. It must be owned by the current user with no
 *    group/other permissions (0700). Then no other local user can list, read, create, replace or
 *    symlink-swap anything inside it, which also removes the race between a file being created
 *    and its mode being tightened.
 *  - Files inside are additionally kept at 0600 (defence in depth, and so copies made with
 *    permission-preserving tools stay private).
 *  - An existing directory that is too open is *refused*, never silently chmod-ed: it may be a
 *    folder the owner chose via AMOS_DATA_DIR, and changing its permissions would be a surprise.
 *    Files AMOS owns inside a verified private directory are tightened, because they are AMOS's
 *    own files and tightening can only reduce access.
 *
 * Windows: POSIX mode bits do not exist; Node's chmod only toggles read-only. AMOS relies on the
 * per-user ACLs of %LOCALAPPDATA% / %APPDATA%. These checks are skipped there (documented
 * limitation; Windows is a development platform, not the deployment target).
 */

export interface FileReport {
  readonly path: string;
  readonly created: boolean;
  /** Mode was wider than 0600 and was reduced. */
  readonly tightened: boolean;
}

const GROUP_OTHER = 0o077;

// Deliberately not a parameter: letting callers choose the platform would let one skip the checks.
const IS_WINDOWS = process.platform === "win32";

/** Why a mode is unacceptable for a private directory, or null if it is fine. Pure; any OS. */
export function insecureDirReason(mode: number): string | null {
  if ((mode & 0o700) !== 0o700) return "the owner lacks read/write/search permission";
  if ((mode & GROUP_OTHER) !== 0) {
    return `other users have access (mode ${(mode & 0o777).toString(8).padStart(3, "0")})`;
  }
  return null;
}

/**
 * Create `dir` (and missing parents) with 0700, or verify an existing one is private.
 * Throws INSECURE_PERMISSIONS with a fix-it hint when it is not.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (IS_WINDOWS) return;

  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    throw new AmosError("INSECURE_PERMISSIONS", `${dir} is not a directory.`);
  }
  assertOwned(stat, dir);
  const reason = insecureDirReason(stat.mode);
  if (reason) {
    throw new AmosError("INSECURE_PERMISSIONS", `${dir} is not private: ${reason}.`, {
      hint: `Run: chmod 700 "${dir}"  (or point AMOS at a directory only you can access)`,
      details: { mode: (stat.mode & 0o777).toString(8) },
    });
  }
}

/**
 * Create `file` as 0600 if it does not exist (atomically, via open(O_CREAT) with that mode — the
 * umask can only remove bits), or verify and tighten an existing one. Symbolic links are refused:
 * a link could redirect AMOS's writes outside its private directory.
 */
export function ensurePrivateFile(file: string): FileReport {
  const existed = lstatOrNull(file) !== null;
  if (!existed) {
    const fd = fs.openSync(file, "a", 0o600);
    fs.closeSync(fd);
  }
  if (IS_WINDOWS) return { path: file, created: !existed, tightened: false };
  return { ...securePosixFile(file), created: !existed };
}

/**
 * For files SQLite (or anything else) may have created next to ours: verify/tighten each that
 * exists, ignore the rest. Never creates files.
 */
export function securePrivateFilesIfPresent(files: readonly string[]): FileReport[] {
  if (IS_WINDOWS) return [];
  return files
    .filter((f) => lstatOrNull(f) !== null)
    .map((f) => ({ ...securePosixFile(f), created: false }));
}

function securePosixFile(file: string): Omit<FileReport, "created"> {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    throw new AmosError("INSECURE_PERMISSIONS", `${file} is a symbolic link; refusing to use it.`, {
      hint: "Replace the link with the real file, or point AMOS at the real location.",
    });
  }
  if (!stat.isFile()) {
    throw new AmosError("INSECURE_PERMISSIONS", `${file} is not a regular file.`);
  }
  assertOwned(stat, file);
  if ((stat.mode & GROUP_OTHER) === 0) return { path: file, tightened: false };
  fs.chmodSync(file, 0o600);
  const after = fs.lstatSync(file).mode;
  if ((after & GROUP_OTHER) !== 0) {
    throw new AmosError("INSECURE_PERMISSIONS", `Could not make ${file} private.`, {
      hint: "The filesystem may not support Unix permissions (e.g. FAT/NTFS mounts). Use an ext4 location.",
    });
  }
  return { path: file, tightened: true };
}

function assertOwned(stat: fs.Stats, target: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new AmosError("INSECURE_PERMISSIONS", `${target} is owned by another user.`, {
      hint: "AMOS only stores data in locations owned by the user running it.",
      details: { ownerUid: stat.uid, currentUid: uid },
    });
  }
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
