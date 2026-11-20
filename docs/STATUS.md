# AMOS AI — Development status

_Last updated: 2026-11-21 (after the M0.5 audit — see [M0.5_FINAL_AUDIT.md](M0.5_FINAL_AUDIT.md))_

## Current phase

**M0.5 — Final readiness audit: done on the dev PC. Local commits, not pushed.**
M1 verdict: **CONDITIONAL GO** for M1a ([M1_LAUNCH_GATE.md](M1_LAUNCH_GATE.md)).

The laptop ran the M0.1 suite: 244 passed, 1 skipped, as reported in
[LINUX_VALIDATION.md](LINUX_VALIDATION.md). The M0.5 fixes still need a laptop re-run (expect 261
passed, 1 skipped).

M1 has not been started. There is no AI agent, model integration, server or tool execution yet.

| Milestone              | State                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| Architecture & plans   | v0.4; ADRs 001, 004–008 still _proposed_ pending your approval; ADR-020/021 adopted (M0.5) |
| M0 Foundation          | Done — Windows + Ubuntu CI (`807d564`) + laptop                                            |
| M0.1 Hardening         | Done — Windows + Ubuntu CI (`c7990ad`, `a8001a3`) + laptop (owner-reported)                |
| M0.5 Audit             | **Done on Windows (`f3bc307` + docs); laptop re-run and push pending**                     |
| M1 Core agent          | Not started — CONDITIONAL GO, waiting on your decisions (P1–P5)                            |
| M2 Tool execution      | Not started                                                                                |
| M2.5 Laptop checkpoint | Not started                                                                                |
| M3 Skills & MCP        | Not started                                                                                |
| M4 Knowledge           | Not started                                                                                |
| M5 Remote              | Not started                                                                                |
| M6 Reliability         | Not started                                                                                |

## What exists

| Area        | Implemented                                                                                                                                                                   | Tested                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Tooling     | TypeScript 7.0.2 strict, Biome 2.6.8, Vitest 5.1.1 (forks pool), exact-pinned deps, `npm run check`                                                                           | ✓ Windows                                                                                              |
| Git hygiene | `.gitignore` (incl. SQLite companions, probe reports), `.gitattributes` (LF), repo-local noreply author email                                                                 | ✓                                                                                                      |
| Core types  | errors, ids, task state machine + recovery, model capabilities, permission vocabulary                                                                                         | ✓                                                                                                      |
| Privacy     | labels with `local_only` default, `relabel`, `decideEgress`, **EgressGate** + clearances + secret-value scan                                                                  | ✓ Windows (pure logic, OS-independent)                                                                 |
| Network     | **HttpClient**: headers/idle/total timeouts, cancellation, offline (loopback only), cleared bodies only, no redirects; refuses Node env-proxy mode and URL credentials (M0.5) | ✓ Windows, loopback server; env-proxy reproduction in a child process                                  |
| Config      | paths, strict schema (privacy defaults, required provider policy, timeouts), YAML loader, env overrides, secrets.env                                                          | ✓ (POSIX secrets test: Ubuntu CI at `807d564`)                                                         |
| Logging     | JSON logger, redaction, content omission, rotating file sink in a private directory                                                                                           | ✓ (POSIX modes: Ubuntu CI*)                                                                            |
| Storage     | `node:sqlite` wrapper: private dir/files, symlink refusal, `temp_store=MEMORY`, transactions, migrations                                                                      | ✓ (POSIX modes: Ubuntu CI*)                                                                            |
| CLI         | `amos doctor` (incl. directory privacy), `paths`, `config show`, `version`, per-command `--help`                                                                              | ✓ (POSIX doctor checks: Ubuntu CI*)                                                                    |
| Boundaries  | static test: only `src/net` does networking, only `src/storage` uses SQLite, only doctor spawns processes                                                                     | ✓                                                                                                      |
| CI          | ubuntu-24.04 + windows-latest, actions v7                                                                                                                                     | ✓ runs 44750582701 (`c7990ad`) and 44788221582 (`a8001a3`) passed; M0.5 commits not run yet (unpushed) |

## Verified results log

| Date       | Where                                                      | What                                                                         | Result                                                               |
| ---------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 2026-11-20 | Windows 11, Node 24.18.0                                   | M0 `npm run check`                                                           | pass — 136 passed, 3 skipped                                         |
| 2026-11-20 | Windows, fresh clone                                       | `npm ci && npm run check`; `npm ci --omit=dev` + built `doctor`              | pass                                                                 |
| 2026-11-20 | GitHub Actions ubuntu-24.04 + windows-latest               | CI run #1 on `807d564`                                                       | all steps passed (step results via public API; log needs sign-in)    |
| 2026-11-20 | Windows (dev PC, VPN present)                              | `npm run probe`                                                              | script works; **not** representative of the laptop                   |
| 2026-11-20 | Windows, Node 24.18.0                                      | M0.1 baseline `npm run check` (before changes)                               | pass — 136 passed, 3 skipped                                         |
| 2026-11-20 | Windows, clean worktree of `9fe3cea`                       | `npm ci && npm run check` (first M0.1 commit on its own)                     | pass — 208 passed, 12 skipped                                        |
| 2026-11-20 | Windows, Node 24.18.0                                      | M0.1 final `npm run check`                                                   | pass — **230 passed, 15 skipped** (17 files)                         |
| 2026-11-20 | Windows                                                    | 14 deliberate mutations of M0.1 security rules                               | each caught by ≥ 1 failing test                                      |
| 2026-11-20 | Windows                                                    | HTTP transport tests repeated 6×                                             | 19/19 each time (no flakiness observed)                              |
| 2026-11-21 | GitHub Actions ubuntu-24.04 + windows-latest, actions v7   | CI run 44750582701 on `c7990ad`: `npm ci`, `npm run check`, `doctor`         | all steps passed on both OSes; no annotations (Node 20 warning gone) |
| 2026-11-21 | **Laptop**, Linux Mint 22.2, Node 24.22.3 (owner-reported) | `npm run check`, doctor, security and sandbox smoke tests, probe (M0.1 code) | pass — **244 passed, 1 skipped**; details in LINUX_VALIDATION        |
| 2026-11-21 | Windows, Node 24.18.0                                      | M0.5 `npm run check` after fixes                                             | pass — **247 passed, 15 skipped** (21 files)                         |
| 2026-11-21 | Windows, clean worktree of `f3bc307`                       | `npm ci` (with `ignore-scripts`) + `npm run check`                           | pass — 247 passed, 15 skipped                                        |
| 2026-11-21 | Windows                                                    | 3 mutations of the M0.5 fixes; env-proxy tests run 3×                        | all caught; 4/4 each time                                            |

## Environment findings (dev machine, 2026-11-20)

| Item          | Finding                                               | Consequence                                                                                   |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| OS            | Windows 11 Pro                                        | —                                                                                             |
| WSL2 / Docker | not installed                                         | No local Linux verification; CI or the laptop must run the POSIX tests.                       |
| Node.js       | v24.18.0                                              | Supported minimum but behind security releases 24.22.1/24.22.3 — **owner action** to upgrade. |
| `node:sqlite` | SQLite 3.53.1, FTS5/JSON/STRICT/WAL work              | Release-candidate stability in Node 24 (ADR-003).                                             |
| Git identity  | repo-local `user.email` = GitHub noreply address      | Commits after `807d564` no longer carry the personal email; published history unchanged.      |
| Repository    | `AMOS-GUY/AMOS-AI`, public; `origin/main` = `a8001a3` | The M0.5 commits are local and unpushed; pushing is your call.                                |

## Target laptop

Profile and results (owner-reported): [LINUX_VALIDATION.md](LINUX_VALIDATION.md). After pushing,
re-run `npm run check` there and expect 261 passed, 1 skipped.

## Open decisions for the owner

See [M1_LAUNCH_GATE.md](M1_LAUNCH_GATE.md) (P1–P5) and the owner decisions in
[PROVIDER_STRATEGY.md](PROVIDER_STRATEGY.md).

## Known limitations

- (\*) The 15 POSIX permission tests are skipped only on Windows. They passed in Ubuntu CI (step
  results; the log needs a sign-in) and on the laptop at M0.1 (owner-reported 244/1).
- Open security findings: SEC-02 and SEC-06, both Low ([SECURITY_AUDIT_M0_5.md](SECURITY_AUDIT_M0_5.md)).
- The egress gate cannot stop AMOS code that deliberately builds a request body from data it did
  not declare (ADR-017). Only `GET` without a body is allowed past it, and a URL could still carry
  data in its query string.
- Provider endpoints/capabilities come from documentation; none are verified from the laptop.
- Privacy directory paths are validated and stored only; resolution (`~`, symlinks, nesting) comes
  with the M2 path guard.
- Windows: no POSIX permission checks (ACL-based); `amos doctor` notes it for secrets.env.
