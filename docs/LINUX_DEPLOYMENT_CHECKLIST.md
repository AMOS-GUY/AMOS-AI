# Linux Mint deployment checklist — M0

For the ThinkPad (Linux Mint, x86-64, 16 GB). Assumes **no VPN** and an unreliable route to GitHub
and npm. Everything installs under your home directory; **no `sudo` is needed** except where marked
optional.

What M0 gives you on the laptop: the test suite, `amos doctor`, `amos paths`, `amos config show` and
the connectivity probe. There is no agent or service to run yet, and M0 stores no data.

Record every result in [STATUS.md](STATUS.md) ("Target laptop" section) or send it back to me.

---

## 1. Pre-flight facts (2 min)

```bash
cat /etc/os-release | head -3      # expect Linux Mint 21.x or 22.x
uname -m                           # must be x86_64
getconf GNU_LIBC_VERSION           # Node 24 needs glibc ≥ 2.28 (Mint 21+ has 2.35+)
df -h ~ | tail -1                  # need ~1 GB free for Node + repo + node_modules
which -a node npm; node -v 2>/dev/null   # note any existing (apt) Node; it must not shadow ours
python3 --version; git --version; which bwrap || echo "no bubblewrap"
echo "umask $(umask)"              # expect 0002 or 0022
```

## 2. Install Node.js 24 LTS — no root needed (10 min)

**Version: 24.22.3** (latest 24 LTS, released 2026-11-10, a security release; CI most likely runs it too, since `.nvmrc` = `24` resolves to the newest 24.x — inferred, the CI log needs a sign-in to confirm).
24.18.0 is the minimum AMOS accepts, but it lacks security fixes, and REA (M3) needs ≥ 24.22.1.

Pick whichever source works from the laptop:

| Source               | URL                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. nodejs.org        | `https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz`                                                                                                         |
| B. npmmirror (China) | `https://registry.npmmirror.com/-/binary/node/v24.22.3/node-v24.22.3-linux-x64.tar.xz` (redirects to its CDN; reachable from the dev PC, not yet checked from the laptop) |
| C. USB               | Download A on the Windows PC and copy it over                                                                                                                             |

```bash
cd ~/Downloads
# Verify the checksum against nodejs.org's SHASUMS256.txt (fetch it via any route, or copy it by USB).
# On 2026-11-20 nodejs.org listed:
#   4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb  node-v24.22.3-linux-x64.tar.xz
sha256sum node-v24.22.3-linux-x64.tar.xz
mkdir -p ~/.local/opt
tar -xJf node-v24.22.3-linux-x64.tar.xz -C ~/.local/opt
echo 'export PATH="$HOME/.local/opt/node-v24.22.3-linux-x64/bin:$PATH"' >> ~/.bashrc
exec bash
node -v      # v24.22.3
which node   # ~/.local/opt/node-v24.22.3-linux-x64/bin/node — if not, an apt Node is shadowing it
```

## 3. Get the code (5 min)

**Option A — git clone** (needs GitHub reachable):

```bash
mkdir -p ~/src && cd ~/src
git clone https://github.com/AMOS-GUY/AMOS-AI.git && cd AMOS-AI
```

**Option B — USB bundle** (works with no GitHub access). On the Windows PC:

```bash
git -C E:/StorageFolder/AmosAI bundle create E:/amos-ai.bundle HEAD main
```

(`HEAD` must be included. A bundle of only `main` clones to an empty folder — tested.)

On the laptop:

```bash
mkdir -p ~/src && cd ~/src
git clone ~/amos-ai.bundle AMOS-AI && cd AMOS-AI
git remote set-url origin https://github.com/AMOS-GUY/AMOS-AI.git   # for later pulls
```

Keep the repo on the internal ext4 disk, not on a USB stick or NTFS partition: permissions and the
`0600` checks depend on it.

## 4. Install dependencies (2–10 min)

```bash
npm ci                                                    # if registry.npmjs.org is reachable
npm ci --registry=https://registry.npmmirror.com          # otherwise (mirror)
```

The lockfile points at registry.npmjs.org; npm automatically substitutes the configured
`--registry`. Dev tools (TypeScript 7, Biome, Vitest's bundler) download Linux-specific native
binaries here, so **a `node_modules` copied from Windows will not work for tests.**

**Offline fallback (runtime only, no tests):** the runtime dependencies (`yaml`, `zod`) are pure
JavaScript. On Windows run `npm run build`, then copy `dist/`, `package.json` and
`node_modules/{yaml,zod}` into the laptop's repo. `node dist/cli/main.js doctor` then works with no
registry at all. _(Untested on the laptop, but the same layout ran in CI and on Windows after
`npm ci --omit=dev`.)_

## 5. Run the tests (2 min)

```bash
npm run check
```

Expected on Linux (as of M0.5, `f3bc307`): typecheck clean, Biome clean, **21 files, 261 passed, 1
skipped** (the skipped one is Windows-only), secret scan clean, build OK. On Windows the same suite
shows 247 passed and 15 skipped: the 15 are POSIX permission tests (secrets file,
log/database/WAL/SHM file modes, private directories, symlink refusal, doctor directory checks).
They passed on the laptop at M0.1 (244 passed, 1 skipped — see [LINUX_VALIDATION.md](LINUX_VALIDATION.md))
and in Ubuntu CI. Any failure: copy the full output.

## 6. Configuration and secrets (3 min)

```bash
node dist/cli/main.js paths
# expect: ~/.config/amos, ~/.local/share/amos, ~/.local/state/amos(/logs)
install -d -m 700 ~/.config/amos
install -m 600 /dev/null ~/.config/amos/secrets.env   # creates it 0600 regardless of umask
cp config/config.example.yaml ~/.config/amos/config.yaml   # optional; defaults work without it
node dist/cli/main.js config show
ls -l ~/.config/amos            # secrets.env must show -rw-------
```

Do **not** put real API keys in `secrets.env` yet. M0 doesn't use them, and they are not needed for
any check below.

## 7. CLI smoke tests (5 min)

```bash
A="node dist/cli/main.js"
$A version                        # 0.0.0
$A doctor; echo "exit $?"         # exit 0; note any WARN (git, sandbox) — they are not failures
$A doctor --json > /dev/null && echo json-ok

# Negative test 1: insecure secrets file must be refused
chmod 644 ~/.config/amos/secrets.env
$A doctor; echo "exit $?"         # expect [FAIL] secrets … hint: chmod 600 … and exit 1
chmod 600 ~/.config/amos/secrets.env
$A doctor; echo "exit $?"         # back to exit 0

# Negative test 2: invalid config gives a precise error
mkdir -p /tmp/amos-bad
printf 'server:\n  host: 0.0.0.0\n' > /tmp/amos-bad/config.yaml
AMOS_CONFIG_DIR=/tmp/amos-bad $A config show; echo "exit $?"   # error [CONFIG_INVALID] … server.host, exit 1
rm -r /tmp/amos-bad

# Env override
AMOS_LOG_LEVEL=debug $A config show | grep -A1 envOverrides     # lists AMOS_LOG_LEVEL

# M0.1: help never runs the command
$A doctor --help | head -1          # "Usage: amos doctor [--json]" and no check output

# M0.1: privacy defaults
$A config show | grep defaultLabel  # defaultLabel: local_only
mkdir -p /tmp/amos-priv && printf 'privacy:\n  defaultLabel: public\n' > /tmp/amos-priv/config.yaml
AMOS_CONFIG_DIR=/tmp/amos-priv $A config show; echo "exit $?"  # CONFIG_INVALID … never treated as public, exit 1
rm -r /tmp/amos-priv

# M0.1: a data directory other users can read is reported (and would be refused)
mkdir -p /tmp/amos-shared && chmod 755 /tmp/amos-shared
AMOS_DATA_DIR=/tmp/amos-shared $A doctor; echo "exit $?"       # [FAIL] data dir … is not private … chmod 700, exit 1
rm -r /tmp/amos-shared

# Nothing is listening (M0 has no server)
ss -ltnp 2>/dev/null | grep -i node || echo "no node listeners"
```

## 8. Sandbox readiness for M2 (2 min, report only)

```bash
bwrap --version || echo "bubblewrap missing"        # optional install: sudo apt install bubblewrap
bwrap --ro-bind / / --unshare-user --unshare-net true && echo "userns OK" || echo "userns BLOCKED"
sysctl kernel.apparmor_restrict_unprivileged_userns 2>/dev/null
```

Ubuntu 24.04-based systems may block unprivileged user namespaces through AppArmor. **Don't change
the sysctl.** Just report the result; M2's design depends on it.

## 9. Connectivity probe — the most important result (2 min)

Disconnect any VPN or proxy first. Write the report **outside** the repository, because it describes
your network:

```bash
node scripts/probe-connectivity.ts --json ~/amos-probe-$(date +%F).json
```

How to read it:

| Result                              | Meaning                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `OK 200/301/302/401/403/404`        | Reachable. 401/403 just means "no API key", which is expected.                                             |
| `FAIL timeout`                      | Blocked or very slow. Rerun once with `--timeout 20000` to tell which.                                     |
| `FAIL ENOTFOUND` / `EAI_AGAIN`      | DNS failure: blocked, or a DNS problem                                                                     |
| `FAIL ECONNRESET` / `CERT_*`        | Connection reset or a certificate error, typical of interference — or a wrong system clock (`timedatectl`) |
| `FAIL ECONNREFUSED` on local Ollama | Ollama is not installed or running — expected                                                              |

Send me the table and tell me which provider accounts you have. That sets M1's provider list.

## 10. Rollback / uninstall

M0 writes nothing outside the places below, and it has no service to stop.

```bash
rm -rf ~/src/AMOS-AI                                  # the code
ls -la ~/.config/amos ~/.local/share/amos ~/.local/state/amos 2>/dev/null   # inspect first
rm -rf ~/.config/amos ~/.local/share/amos ~/.local/state/amos             # contains secrets.env
rm -rf ~/.local/opt/node-v24.22.3-linux-x64           # Node, then delete its PATH line in ~/.bashrc
```

Return to an earlier AMOS version: `git -C ~/src/AMOS-AI checkout <commit>` and then
`npm ci && npm run build`.

## 11. Backup and recovery

- **M0 has no data to back up.** No command opens a database at the real data path; tests use
  temporary directories that they delete afterwards.
- Worth keeping: `~/.config/amos/config.yaml`. Keep `secrets.env` out of ordinary backups: if you back
  it up, use encrypted storage only.
- Database backup and restore (SQLite's online backup API) starts with M1, when there is data. It is
  tested in M6.

## 12. Linux issues that might come up

| Symptom                                                                          | Likely cause                                                         | Fix                                                                        |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `node -v` shows v12/v18                                                          | apt Node earlier in `PATH`                                           | Put `~/.local/opt/…/bin` first; `hash -r`; don't remove system packages    |
| `npm ci` hangs or times out                                                      | Registry unreachable                                                 | `--registry=https://registry.npmmirror.com`; or the offline fallback in §4 |
| `npm ci` fails on `@typescript/typescript-linux-x64` or `@biomejs/cli-linux-x64` | Optional native package blocked or partially downloaded              | Retry with the mirror; `npm cache verify`                                  |
| `SECRET_FILE_INSECURE`                                                           | File created with umask 0022                                         | `chmod 600 ~/.config/amos/secrets.env`                                     |
| POSIX permission tests fail                                                      | Repo or tmp on a filesystem without Unix permissions (NTFS, FAT USB) | Use the ext4 home directory; `echo $TMPDIR`                                |
| `git clone` fails or is very slow                                                | GitHub unreachable                                                   | USB bundle (§3B)                                                           |
| Probe shows `CERT_*` everywhere                                                  | Wrong system clock                                                   | `timedatectl status`; enable NTP                                           |
| `bwrap: setting up uid map: Permission denied`                                   | AppArmor userns restriction                                          | Report only (§8)                                                           |
| Garbled Chinese file names in output                                             | Non-UTF-8 locale                                                     | `locale` should show `UTF-8`; AMOS itself is UTF-8 throughout (tested)     |

## Done when

- [ ] `npm run check`: 261 passed, 1 skipped (M0.5; it was 244/1 at M0.1)
- [ ] `doctor` exit 0, and both negative tests behave as described
- [ ] Probe report saved outside the repo, with results sent
- [ ] `bwrap` result noted
- [ ] Pre-flight facts recorded in STATUS.md
