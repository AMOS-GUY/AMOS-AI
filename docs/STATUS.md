# AMOS AI — Development status

_Last updated: 2026-11-20 (end of the M0 overnight session)_

## Current phase

**M0 — Development foundation: implemented and verified on Windows. Linux verification pending.**
M1 has not been started. There is no AI agent, model integration, server or tool execution yet.

| Milestone              | State                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| Architecture & plans   | Refined (v0.2); ADRs 001, 004–008 still _proposed_ pending your approval |
| M0 Foundation          | **Implemented; verified on Windows; Linux CI + laptop checks pending**   |
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
| Config      | platform paths, strict schema + defaults, YAML loader, env overrides, secrets.env loader                                  | ✓ (POSIX permission tests pending Linux)     |
| Logging     | JSON logger, redaction, content omission, rotating file sink                                                              | ✓ (file-mode test pending Linux)             |
| Storage     | `node:sqlite` wrapper, transactions, migrations                                                                           | ✓                                            |
| CLI         | `amos doctor`, `paths`, `config show`, `version`                                                                          | ✓                                            |
| Scripts     | secret scan, connectivity probe, safe clean                                                                               | ✓                                            |
| CI          | `.github/workflows/ci.yml` (ubuntu-24.04 + windows)                                                                       | **never run** (nothing pushed)               |

## Verified results log

| Date       | Where                         | What                                                                                   | Result                                                     |
| ---------- | ----------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 2026-11-20 | Windows 11, Node 24.18.0      | `npm run check`                                                                        | pass — 136 tests passed, 3 skipped (POSIX-only)            |
| 2026-11-20 | Windows, fresh `git clone`    | `npm ci && npm run check`                                                              | pass                                                       |
| 2026-11-20 | Windows, fresh clone          | `npm ci --omit=dev` then `node dist/cli/main.js doctor`                                | pass (runtime deps: yaml, zod only)                        |
| 2026-11-20 | Windows                       | 4 deliberate rule mutations (privacy gate, redaction, loopback check, terminal states) | each caught by failing tests                               |
| 2026-11-20 | Windows (dev PC, VPN present) | `npm run probe`                                                                        | script works; results **not** representative of the laptop |

## Environment findings (dev machine, 2026-11-20)

| Item          | Finding                                                          | Consequence                                                                      |
| ------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| OS            | Windows 11 Pro                                                   | —                                                                                |
| WSL2 / Docker | not installed                                                    | No local Linux verification possible; GitHub Actions is the planned Linux check. |
| Node.js       | v24.18.0                                                         | Supported minimum. REA (M3) needs ≥ 24.22.1.                                     |
| `node:sqlite` | SQLite 3.53.1, FTS5/JSON/STRICT/WAL work, no warning printed     | Node docs mark the module release candidate (ADR-003).                           |
| npm registry  | reachable from the dev PC                                        | Says nothing about the laptop.                                                   |
| GitHub CLI    | not installed                                                    | —                                                                                |
| Repository    | `AMOS-GUY/AMOS-AI`, public; only the first docs commit is pushed | Local `main` is ahead by the M0 commits (unpushed).                              |

## Target laptop (not yet inspected)

To record: Mint version, kernel, CPU model, free disk, Python version, whether bubblewrap works
unprivileged, `npm run check` result, and `npm run probe` output (without VPN).

## Open decisions for the owner

See "Decisions for me" in [OVERNIGHT_REPORT.md](OVERNIGHT_REPORT.md).

## Known limitations

- Linux behaviour (file permission checks, XDG paths on a real system, bubblewrap detection) is
  covered by tests that have only run on Windows so far (three are skipped there).
- Provider endpoints/capabilities in docs and examples come from documentation; none are verified
  from the laptop's network.
- Privacy directory paths in config are validated and stored only; `~` expansion and
  canonicalisation come with the M2 path guard.
- On Windows the `secrets.env` permissions are not checked (ACLs); `amos doctor` shows a warning.
