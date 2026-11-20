# AMOS AI — Development status

_Last updated: 2026-11-21 (after M0.1 and CI run 44750582701 — see [M0.1_HARDENING_REPORT.md](M0.1_HARDENING_REPORT.md))_

## Current phase

**M0.1 — Security corrections: done. Pushed (`c7990ad`); CI passed on Ubuntu and Windows.**
The 15 POSIX permission tests ran in Ubuntu CI (inferred from the passing step; the log needs sign-in). The laptop (Linux Mint) is still untested.
M1 has not been started. There is no AI agent, model integration, server or tool execution yet.

| Milestone              | State                                                           |
| ---------------------- | --------------------------------------------------------------- |
| Architecture & plans   | v0.3; ADRs 001, 004–008 still _proposed_ pending your approval  |
| M0 Foundation          | Done — Windows + Ubuntu CI (`807d564`)                          |
| M0.1 Hardening         | **Done — Windows + Ubuntu CI pass (`c7990ad`); laptop pending** |
| M1 Core agent          | Not started (not authorised)                                    |
| M2 Tool execution      | Not started                                                     |
| M2.5 Laptop checkpoint | Not started                                                     |
| M3 Skills & MCP        | Not started                                                     |
| M4 Knowledge           | Not started                                                     |
| M5 Remote              | Not started                                                     |
| M6 Reliability         | Not started                                                     |

## What exists

| Area        | Implemented                                                                                                           | Tested                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Tooling     | TypeScript 7.0.2 strict, Biome 2.6.8, Vitest 5.1.1 (forks pool), exact-pinned deps, `npm run check`                   | ✓ Windows                                            |
| Git hygiene | `.gitignore` (incl. SQLite companions, probe reports), `.gitattributes` (LF), repo-local noreply author email         | ✓                                                    |
| Core types  | errors, ids, task state machine + recovery, model capabilities, permission vocabulary                                 | ✓                                                    |
| Privacy     | labels with `local_only` default, `relabel`, `decideEgress`, **EgressGate** + clearances + secret-value scan          | ✓ Windows (pure logic, OS-independent)               |
| Network     | **HttpClient**: headers/idle/total timeouts, cancellation, offline (loopback only), cleared bodies only, no redirects | ✓ Windows, loopback server                           |
| Config      | paths, strict schema (privacy defaults, required provider policy, timeouts), YAML loader, env overrides, secrets.env  | ✓ (POSIX secrets test: Ubuntu CI at `807d564`)       |
| Logging     | JSON logger, redaction, content omission, rotating file sink in a private directory                                   | ✓ (POSIX modes: Ubuntu CI*)                          |
| Storage     | `node:sqlite` wrapper: private dir/files, symlink refusal, `temp_store=MEMORY`, transactions, migrations              | ✓ (POSIX modes: Ubuntu CI*)                          |
| CLI         | `amos doctor` (incl. directory privacy), `paths`, `config show`, `version`, per-command `--help`                      | ✓ (POSIX doctor checks: Ubuntu CI*)                  |
| Boundaries  | static test: only `src/net` does networking, only `src/storage` uses SQLite, only doctor spawns processes             | ✓                                                    |
| CI          | ubuntu-24.04 + windows-latest, actions v7                                                                             | ✓ v7 run 44750582701 passed (`c7990ad`), no warnings |

## Verified results log

| Date       | Where                                                    | What                                                                 | Result                                                               |
| ---------- | -------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 2026-11-20 | Windows 11, Node 24.18.0                                 | M0 `npm run check`                                                   | pass — 136 passed, 3 skipped                                         |
| 2026-11-20 | Windows, fresh clone                                     | `npm ci && npm run check`; `npm ci --omit=dev` + built `doctor`      | pass                                                                 |
| 2026-11-20 | GitHub Actions ubuntu-24.04 + windows-latest             | CI run #1 on `807d564`                                               | all steps passed (step results via public API; log needs sign-in)    |
| 2026-11-20 | Windows (dev PC, VPN present)                            | `npm run probe`                                                      | script works; **not** representative of the laptop                   |
| 2026-11-20 | Windows, Node 24.18.0                                    | M0.1 baseline `npm run check` (before changes)                       | pass — 136 passed, 3 skipped                                         |
| 2026-11-20 | Windows, clean worktree of `9fe3cea`                     | `npm ci && npm run check` (first M0.1 commit on its own)             | pass — 208 passed, 12 skipped                                        |
| 2026-11-20 | Windows, Node 24.18.0                                    | M0.1 final `npm run check`                                           | pass — **230 passed, 15 skipped** (17 files)                         |
| 2026-11-20 | Windows                                                  | 14 deliberate mutations of M0.1 security rules                       | each caught by ≥ 1 failing test                                      |
| 2026-11-20 | Windows                                                  | HTTP transport tests repeated 6×                                     | 19/19 each time (no flakiness observed)                              |
| 2026-11-21 | GitHub Actions ubuntu-24.04 + windows-latest, actions v7 | CI run 44750582701 on `c7990ad`: `npm ci`, `npm run check`, `doctor` | all steps passed on both OSes; no annotations (Node 20 warning gone) |

## Environment findings (dev machine, 2026-11-20)

| Item          | Finding                                               | Consequence                                                                                   |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| OS            | Windows 11 Pro                                        | —                                                                                             |
| WSL2 / Docker | not installed                                         | No local Linux verification; CI or the laptop must run the POSIX tests.                       |
| Node.js       | v24.18.0                                              | Supported minimum but behind security releases 24.22.1/24.22.3 — **owner action** to upgrade. |
| `node:sqlite` | SQLite 3.53.1, FTS5/JSON/STRICT/WAL work              | Release-candidate stability in Node 24 (ADR-003).                                             |
| Git identity  | repo-local `user.email` = GitHub noreply address      | Commits after `807d564` no longer carry the personal email; published history unchanged.      |
| Repository    | `AMOS-GUY/AMOS-AI`, public; `origin/main` = `c7990ad` | Up to date with local `main`.                                                                 |

## Target laptop (not yet inspected)

Follow [LINUX_DEPLOYMENT_CHECKLIST.md](LINUX_DEPLOYMENT_CHECKLIST.md) and record: Mint version, glibc,
free disk, Python version, bubblewrap/userns result, `npm run check` result (expect 244 passed, 1
skipped), and probe output (without VPN).

## Open decisions for the owner

See "Decisions for you" in [M0.1_HARDENING_REPORT.md](M0.1_HARDENING_REPORT.md) and the open items
in [M1_READINESS.md](M1_READINESS.md).

## Known limitations

- (*) The 15 POSIX permission tests are skipped only on Windows, so the passing Ubuntu CI step
  (run 44750582701) means they ran and passed. Their per-test output was not viewed (the log needs
  a GitHub sign-in). They have not yet run on Linux Mint itself.
- The egress gate cannot stop AMOS code that deliberately builds a request body from data it did
  not declare (ADR-017). Only `GET` without a body is allowed past it, and a URL could still carry
  data in its query string.
- Provider endpoints/capabilities come from documentation; none are verified from the laptop.
- Privacy directory paths are validated and stored only; resolution (`~`, symlinks, nesting) comes
  with the M2 path guard.
- Windows: no POSIX permission checks (ACL-based); `amos doctor` notes it for secrets.env.
