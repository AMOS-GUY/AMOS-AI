# AMOS AI — Development status

_Last updated: 2026-11-20 (after the M0 review — see [M0_REVIEW.md](M0_REVIEW.md))_

## Current phase

**M0 — Development foundation: implemented; verified on Windows and in Ubuntu CI. Laptop (Linux Mint) not yet tested.**
M1 has not been started. There is no AI agent, model integration, server or tool execution yet.

| Milestone              | State                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| Architecture & plans   | Refined (v0.2); ADRs 001, 004–008 still _proposed_ pending your approval |
| M0 Foundation          | **Implemented; Windows + Ubuntu CI pass; laptop checks pending**         |
| M1 Core agent          | Not started (not authorised)                                             |
| M2 Tool execution      | Not started                                                              |
| M2.5 Laptop checkpoint | Not started                                                              |
| M3 Skills & MCP        | Not started                                                              |
| M4 Knowledge           | Not started                                                              |
| M5 Remote              | Not started                                                              |
| M6 Reliability         | Not started                                                              |

## What exists (M0)

| Area        | Implemented                                                                                                               | Tested                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Tooling     | TypeScript 7.0.2 strict, Biome 2.6.8, Vitest 5.1.1, exact-pinned deps, `npm run check`                                    | ✓ (Windows, fresh clone)                     |
| Git hygiene | `.gitignore`, `.gitattributes` (LF), `.editorconfig`, `.npmrc`, `.nvmrc`                                                  | line endings verified (`git ls-files --eol`) |
| Core types  | errors, ids, task state machine + recovery rules, privacy labels + egress gate, model capabilities, permission vocabulary | ✓                                            |
| Config      | platform paths, strict schema + defaults, YAML loader, env overrides, secrets.env loader                                  | ✓ (POSIX tests pass in Ubuntu CI, inferred*) |
| Logging     | JSON logger, redaction, content omission, rotating file sink                                                              | ✓ (as above*)                                |
| Storage     | `node:sqlite` wrapper, transactions, migrations                                                                           | ✓                                            |
| CLI         | `amos doctor`, `paths`, `config show`, `version`                                                                          | ✓                                            |
| Scripts     | secret scan, connectivity probe, safe clean                                                                               | ✓                                            |
| CI          | `.github/workflows/ci.yml` (ubuntu-24.04 + windows)                                                                       | ✓ run #1 passed (both OSes)                  |

## Verified results log

| Date       | Where                                                         | What                                                                                   | Result                                                            |
| ---------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 2026-11-20 | Windows 11, Node 24.18.0                                      | `npm run check`                                                                        | pass — 136 tests passed, 3 skipped (POSIX-only)                   |
| 2026-11-20 | Windows, fresh `git clone`                                    | `npm ci && npm run check`                                                              | pass                                                              |
| 2026-11-20 | Windows, fresh clone                                          | `npm ci --omit=dev` then `node dist/cli/main.js doctor`                                | pass (runtime deps: yaml, zod only)                               |
| 2026-11-20 | Windows                                                       | 4 deliberate rule mutations (privacy gate, redaction, loopback check, terminal states) | each caught by failing tests                                      |
| 2026-11-20 | Windows (dev PC, VPN present)                                 | `npm run probe`                                                                        | script works; results **not** representative of the laptop        |
| 2026-11-20 | GitHub Actions ubuntu-24.04 + windows-latest (Node 24 latest) | CI run #1 on `807d564`: `npm ci`, `npm run check`, `doctor`                            | all steps passed (read via the public API; the log needs sign-in) |
| 2026-11-20 | Windows, Node 24.18.0                                         | review re-run of `npm run check`, plus CLI precedence and secret-rejection checks      | pass — see M0_REVIEW                                              |

## Environment findings (dev machine, 2026-11-20)

| Item          | Finding                                                      | Consequence                                                                     |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| OS            | Windows 11 Pro                                               | —                                                                               |
| WSL2 / Docker | not installed                                                | No local Linux verification; GitHub Actions is the Linux check.                 |
| Node.js       | v24.18.0                                                     | Supported minimum, but behind security releases 24.22.1/24.22.3 (M0_REVIEW F7). |
| `node:sqlite` | SQLite 3.53.1, FTS5/JSON/STRICT/WAL work, no warning printed | Node docs mark the module release candidate (ADR-003).                          |
| npm registry  | reachable from the dev PC                                    | Says nothing about the laptop.                                                  |
| GitHub CLI    | not installed                                                | —                                                                               |
| Repository    | `AMOS-GUY/AMOS-AI`, public; all commits pushed (`807d564`)   | Commits carry a personal email (M0_REVIEW, "Git privacy review").               |

## Target laptop (not yet inspected)

Follow [LINUX_DEPLOYMENT_CHECKLIST.md](LINUX_DEPLOYMENT_CHECKLIST.md) and record: Mint version, glibc,
free disk, Python version, bubblewrap/userns result, `npm run check` result, and probe output (without VPN).

## Open decisions for the owner

See [M1_READINESS.md](M1_READINESS.md) ("Decisions to finalise before M1" and the pre-M1 checklist)
and the git email recommendation in [M0_REVIEW.md](M0_REVIEW.md).

## Known limitations

- (\*) The three POSIX tests are skipped only on Windows, so the passing Ubuntu CI step implies they
  ran. Their individual output was not viewed (the log needs a GitHub sign-in). Linux **Mint**
  itself is untested.
- Open review findings F1–F13 ([M0_REVIEW.md](M0_REVIEW.md)). None block an M0 deployment; F1–F4
  must be settled for M1.
- Provider endpoints/capabilities in docs and examples come from documentation; none are verified
  from the laptop's network.
- Privacy directory paths in config are validated and stored only; `~` expansion and
  canonicalisation come with the M2 path guard.
- On Windows the `secrets.env` permissions are not checked (ACLs); `amos doctor` shows a warning.
