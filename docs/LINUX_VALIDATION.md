# Linux validation record

Results from the target laptop. **Source matters here:**

| Mark | Meaning                                                                                  |
| ---- | ---------------------------------------------------------------------------------------- |
| (O)  | Reported by the owner from the laptop (2026-11-21, M0.5 brief) — not re-run by the audit |
| (CI) | GitHub Actions ubuntu-24.04 — step results read via the public API                       |
| (A)  | Verified by the M0.5 audit itself, which ran on the Windows dev PC                       |

No secrets, API keys, IP addresses or other network report details are recorded here, only endpoint
reachability.

## Machine profile (O)

| Item          | Value                          |
| ------------- | ------------------------------ |
| OS            | Linux Mint 22.2, x86_64        |
| Kernel        | 7.0.0-43-generic (as reported) |
| CPU / RAM     | Intel Core i7 11th gen / 16 GB |
| Node.js / npm | v24.22.3 / 11.19.1             |
| Python        | 3.12.3                         |
| Git           | 2.43.0                         |
| Bubblewrap    | 0.12.0                         |
| SQLite        | 3.54.1 (as reported)           |

Notes:

- Node 24.22.3 meets AMOS's minimum (24.18.0) and REA's (≥ 24.22.1).
- AMOS uses **the SQLite bundled in Node**, not the system `sqlite3`. `amos doctor` reports the
  bundled version, so if 3.54.1 came from the system `sqlite3` CLI it may differ from what AMOS uses.
  Re-check with `amos doctor` (line `sqlite`) if it matters.

## Automated validation (O)

Baseline as reported: M0.1 (`c7990ad`/`a8001a3`, identical source).

| Check       | Result                              |
| ----------- | ----------------------------------- |
| Typecheck   | pass                                |
| Biome       | pass                                |
| Vitest      | 17 files, **244 passed, 1 skipped** |
| Secret scan | 70 files, no findings               |
| Build       | pass                                |

This matches the expected Linux count at that baseline. The skipped test is the Windows-only one,
which means the 15 POSIX permission tests **ran and passed on the laptop**. Ubuntu CI agrees (CI):
runs 44750582701 (`c7990ad`) and 44788221582 (`a8001a3`) succeeded on every step.

**After M0.5** (`f3bc307` and later) the suite has 21 files and 262 tests. Expected on Linux: **261
passed, 1 skipped**. On Windows (A): 247 passed, 15 skipped. The M0.5 changes add no POSIX-only
tests. Re-run `npm run check` on the laptop to confirm.

## Diagnostics (O)

`amos doctor` passed:

- Node.js, SQLite features, config, secrets;
- config directory, environment variables;
- git, Python, bubblewrap.

M0.5 adds a `proxy` line (A): `ok` with no proxy, `info` if proxy variables are set (ignored), and
`FAIL` if Node env-proxy mode is on (SEC-01).

## Security smoke tests (O)

| Test                                                        | Result |
| ----------------------------------------------------------- | ------ |
| Config directory created with mode 700                      | ✓      |
| `secrets.env` created with mode 600                         | ✓      |
| `secrets.env` at mode 644 rejected; back to 600 → doctor ok | ✓      |
| `server.host: 0.0.0.0` rejected                             | ✓      |
| `privacy.defaultLabel` defaults to `local_only`             | ✓      |
| `privacy.defaultLabel: public` rejected                     | ✓      |
| Data directory at mode 755 rejected                         | ✓      |
| Temporary test directories cleaned up                       | ✓      |

## Sandbox prerequisites (O)

| Test                                                    | Result    |
| ------------------------------------------------------- | --------- |
| `bwrap --version`                                       | 0.12.0    |
| `bwrap --ro-bind / / --unshare-user --unshare-net true` | succeeded |
| `kernel.apparmor_restrict_unprivileged_userns`          | 0         |

This shows that unprivileged user namespaces, and with them bubblewrap's isolation, work on this
laptop **today**. It does **not** show that AMOS has a sandbox: none is implemented yet (M2), and the
sysctl could change with an OS update. `amos doctor` should re-check it on every run once M2 depends
on it.

## Network probe (O, summarised)

The full report is stored outside the repository.

| Reachable directly                                                                                                                                                                                                                          | Not reachable directly (timeout) |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| npm registry, npmmirror, nodejs.org, github.com, api.github.com, TUNA PyPI mirror, DeepSeek API (401), Model Studio CN (401), Model Studio intl (401), Ollama registry (404), ModelScope (302), Tailscale control (302), local Ollama (200) | pypi.org, Hugging Face           |

The Anthropic API answered **403**: reachable, but access denied. An unauthenticated 401 or 404 only
proves the endpoint answers; it says nothing about authenticated use. See
[PROVIDER_STRATEGY.md](PROVIDER_STRATEGY.md).

## Limitations

- **Not re-run by the audit:** this audit could not execute anything on Linux. Laptop results are
  as reported.
- **Not seen:** per-test CI output, which requires a GitHub sign-in.
- **Not measured:**
  - local model performance (tokens/s, RAM);
  - behaviour across suspend/resume and network changes;
  - systemd user service (does not exist yet).
- **Unchanged by these results:** the sandbox and remote-access designs still need decisions and
  implementation.

## To re-run after M0.5

The M0.5 commits are local to the dev PC until you push them. After pushing, on the laptop:

```bash
git pull
npm ci
npm run check
node dist/cli/main.js doctor
```

Expect **261 passed, 1 skipped** and a `proxy` line in `doctor`. Record the result here.
