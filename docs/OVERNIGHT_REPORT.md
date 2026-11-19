# Overnight report — M0 development foundation (2026-11-20)

## Executive summary

M0 is **implemented and verified on Windows**. The repository now has a strict TypeScript
foundation: configuration (defaults, YAML, environment, secrets), structured redacting logs, core
types and rules (task lifecycle, privacy egress gate, provider capabilities), a verified
`node:sqlite` storage layer with migrations, an `amos` CLI (`doctor`, `paths`, `config show`), a
secret scanner and a connectivity probe for the laptop.

`npm run check` (typecheck → lint → 136 tests → secret scan → build) passes, also from a fresh clone.
**Linux has not been verified**: there is no WSL or Docker on this PC and nothing was pushed, so the
CI workflow has never run. Nothing was pushed, published or deployed, and M1 was not started.

The work took well under the five-hour budget. I stopped when M0 was complete and spent the rest on
verification (fresh clone, production-only install, mutation checks, coverage) rather than adding
features.

## Architecture changes

| Change                                                                                                                                                                                   | Why                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Task lifecycle adds `interrupted`; startup turns `running` into `interrupted`, never silently resumes; recovery needs owner review if a tool call's outcome is unknown (ARCHITECTURE §3) | Your requirement A; a half-finished write must be inspected before resuming.                            |
| Enforcement stated as an execution-layer property: approvals are persisted records bound to one action; chat text is never parsed as approval (§10)                                      | Requirement B.                                                                                          |
| Privacy labels `public < personal < local_only < secret`, most restrictive wins, one `checkEgress` gate for model, tool, web and remote boundaries (§10, ADR-012)                        | Requirement C. Rules implemented and tested now; each boundary calls it when built.                     |
| Provider capability matrix (tool calling, streaming, structured output, context, reasoning, retry, errors) as per-model config data (§8)                                                 | Requirement D.                                                                                          |
| Deployment table: packaging, dependencies, install, config, data, backups, upgrades, rollback, startup/shutdown, logs, health (§12)                                                      | Requirement E.                                                                                          |
| Layout: repo root is the server package; `web/` joins as an npm workspace in M1 (§4, ADR-002 revised)                                                                                    | Workspaces had no purpose before a UI exists; this layout means no code moves later.                    |
| Node minimum raised to the tested 24.18.0 (ADR-013)                                                                                                                                      | `import.meta.main` needs 24.2+; `node:sqlite` is release-candidate stability — claim only what was run. |
| New ADRs 009–014: TS 7 with Node type-stripping, Biome, layered config, privacy gate, Node minimum, credential-free probe                                                                | Decisions made during implementation.                                                                   |

## Implemented work (M0 components)

1. **Tooling** — TypeScript 7.0.2 (strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`), Biome 2.6.8, Vitest 5.1.1, all exact-pinned. Node runs `.ts` directly (no tsx); `tsc` emits `dist/`.
2. **Git hygiene** — `.gitattributes` forces LF (verified: index and working tree are `lf`), `.editorconfig`, `.npmrc` (`save-exact`, `engine-strict`), `.nvmrc`, expanded `.gitignore`.
3. **Core** (`src/core/`) — `AmosError` with stable codes + hints; branded prefixed ids; task state machine, restart and recovery rules; privacy labels + egress gate; model capability schema + requirement matching + retryable error kinds; permission vocabulary (types only; the engine is M2 and is deliberately not stubbed).
4. **Configuration** (`src/config/`) — platform paths (XDG, macOS, Windows, `AMOS_*_DIR` overrides); strict zod schema with defaults (server bound to loopback only, https required for remote providers, `local` providers must be localhost); YAML loader that reports line numbers, duplicate keys and every invalid path; `AMOS_*` env overrides (an explicit list, values never echoed in errors); rejection of secret-looking keys in `config.yaml`; `secrets.env` loader refusing group/other-readable or foreign-owned files on POSIX.
5. **Logging** (`src/logging/`) — JSON-lines logger with levels and child bindings; redaction by field name, registered secret values and token shapes; document/prompt content replaced by its length; a failing sink never crashes; rotating owner-only file sink that creates nothing until the first write.
6. **Storage** (`src/storage/`) — `node:sqlite` wrapper (WAL, foreign keys, busy timeout), transactions, forward-only migrations that refuse newer databases and detect renamed migrations; first migration (`app_meta`).
7. **CLI** (`src/cli/`) — `amos doctor` (read-only, no network; Node, SQLite, config, secrets, directories, unknown env vars, git, python, bubblewrap), `amos paths`, `amos config show` (secret names only), `amos version`.
8. **Scripts** — `secret-scan.ts` (credential shapes + personal machine paths; part of `npm run check` and the tests), `probe-connectivity.ts` (DNS/response time/status for 16 endpoints, no credentials sent, standalone for the laptop), `clean.ts` (refuses paths outside the repo).
9. **CI** — `.github/workflows/ci.yml` running `npm ci`, `npm run check` and `doctor` on ubuntu-24.04 and windows. Written, **not run**.
10. **Docs** — README (setup on Windows, WSL2, Mint; commands; configuration; troubleshooting), ARCHITECTURE, ROADMAP (M0 status), DECISIONS, STATUS, this report; `config/config.example.yaml` and `config/secrets.env.example`.

## Files created (important ones)

| File                                                         | Purpose                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| `package.json`, `package-lock.json`                          | scripts and exact dependency pins                       |
| `tsconfig.json`, `tsconfig.build.json`                       | strict typecheck; build to `dist/` (tests excluded)     |
| `biome.json`, `vitest.config.ts`                             | lint/format and test configuration                      |
| `src/core/{errors,ids,task,privacy,provider,permissions}.ts` | foundational types and rules                            |
| `src/config/{paths,schema,env,load,secrets}.ts`              | configuration system                                    |
| `src/logging/{logger,redact,file-sink}.ts`                   | structured logging                                      |
| `src/storage/{sqlite,migrate,migrations}.ts`                 | SQLite access and schema migrations                     |
| `src/runtime.ts`                                             | startup wiring shared by entry points                   |
| `src/cli/{main,doctor}.ts`                                   | `amos` command                                          |
| `scripts/{secret-scan,probe-connectivity,clean}.ts`          | repo safety, laptop network probe, build cleanup        |
| `tests/` + `src/**/*.test.ts`                                | 11 test files                                           |
| `.github/workflows/ci.yml`                                   | Linux + Windows CI (not yet run)                        |
| `config/*.example*`                                          | documented example configuration (tested to stay valid) |

## Tests

All commands run on Windows 11, Node v24.18.0, in `E:\StorageFolder\AmosAI`.

| Command                                                                                                                                 | Result                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `npm test` (`vitest run`)                                                                                                               | **11 files, 136 passed, 3 skipped**                                     |
| `npm run check`                                                                                                                         | exit 0                                                                  |
| fresh `git clone` → `npm ci` → `npm run check`                                                                                          | exit 0, same counts                                                     |
| fresh clone → `npm ci --omit=dev` → `node dist/cli/main.js doctor`                                                                      | exit 0                                                                  |
| mutation check: broke the `local_only` rule, field-name redaction, the loopback-only schema, and terminal-state finality, one at a time | each produced failing tests (2, 1, 1, 2); originals restored            |
| one-off coverage (`@vitest/coverage-v8` installed `--no-save`, then `npm ci` to restore)                                                | 91% lines / 84% branches; added tests for the two meaningful gaps found |

Skipped on Windows (POSIX-only; they will run in Linux CI / on the laptop):

- `secrets.test.ts` — refuses a world-readable `secrets.env`, accepts it after `chmod 600`
- `logging.test.ts` — log files `0600`, log directory `0700`
- `cli.test.ts` — `doctor` fails on an insecure secrets file

Test areas: config validation and error messages, env overrides, path resolution for all three
platforms, secrets parsing/precedence/permissions, redaction and logging, file rotation, task state
machine, egress matrix, capability schema, SQLite compatibility (FTS5, JSON, STRICT, WAL with a
second reader, rollback, BigInt, Chinese paths), migrations, CLI behaviour and exit codes, secret-scan
rules, probe behaviour against a loopback test server, clean-script refusal, metadata consistency.

## Verification

- **Type checking:** `tsc -p tsconfig.json --noEmit` — 0 errors (sources, tests, scripts).
- **Linting/formatting:** `biome check .` — 0 errors, 0 warnings, 0 infos.
- **Build:** `tsc -p tsconfig.build.json` — `dist/` produced; built CLI runs.
- **Config behaviour:** CLI smoke tests with temporary directories (defaults, invalid config → exit 1
  with a path-specific message, `config show` creates no files and prints no secret values).
- **Secrets:** `npm run secret-scan` — 55 files, no findings. A manual search of committed files for
  names, email addresses, travel plans and local paths found nothing beyond what the original
  approved docs contain (see Security).
- **Network listeners:** none of the Node processes on the machine has a listening TCP socket; port
  47821 is unused. The only listeners created were in tests (loopback, ephemeral port, closed after each test).
- **Nothing pushed:** `origin/main` is still `cb16358`. No `git push` was run this session.

## Git

Commits created this session (on local `main`, **not pushed**):

```
9806758 test(m0): cover clean-script safety refusal and single-file log rotation
05f4b83 fix(m0): security review fixes; docs reflect implementation
1a66abc fix(m0): require the tested Node 24.18+, test runtime wiring
ad6d254 feat(m0): development foundation — tooling, config, logging, core types, SQLite
e308a21 docs: refine architecture for task recovery, privacy gate, capabilities, deployment
```

plus a final commit with this report and STATUS (see `git log`). Working tree: clean after that commit.

## Security

- Secrets: never in config (loader rejects secret-like keys), env > `secrets.env`, file must be
  owner-only on POSIX, every value handed out is registered with the log redactor, values never
  printed by `config show` or included in error messages.
- Logs: credential fields redacted, registered values and token shapes masked, content fields
  logged as sizes only, files `0600` in a `0700` directory (POSIX).
- Server config refuses non-loopback addresses (no listener exists yet).
- Provider config requires https for non-localhost endpoints.
- `amos doctor` is read-only, offline, and launches helper tools from the home directory (avoids
  Windows' current-directory executable search in untrusted folders) — found in self-review.
- Self-review also fixed over-redaction of token _counts_ and singular `message` fields.
- Supply chain: 4 dev + 2 runtime dependencies, exact versions, `npm audit` 0 vulnerabilities at
  install time; runtime deps (`yaml`, `zod`) have no dependencies of their own.
- Public repo: secret scan in `npm run check` and CI; rules also flag personal Windows/Unix home paths.

## Problems

| Problem                                                                           | Status                                                          |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| No Linux verification (no WSL/Docker; CI never ran)                               | **Open** — needs a push or WSL.                                 |
| `node:sqlite` is release candidate stability in Node 24                           | Accepted, isolated in `src/storage/`, tests guard it (ADR-003). |
| First Biome config used a deprecated key                                          | Fixed with `biome migrate`.                                     |
| `useLiteralKeys` lint rule conflicts with TS `noPropertyAccessFromIndexSignature` | Rule disabled, reason in ADR-010.                               |
| Secret-scan false positives on `apiKeyEnv: "DEEPSEEK_API_KEY"` and path values    | Rule refined; regression cases in tests.                        |
| `config show` created the log directory as a side effect                          | Fixed (lazy file sink) and tested.                              |
| Probe roadmap item "model list with a key"                                        | Dropped on purpose (ADR-014).                                   |
| Laptop probe run                                                                  | **Open** — owner action.                                        |

## Linux compatibility

- **Portable by construction:** no native npm addons; paths via one `resolvePaths()` with
  per-platform rules (tested for linux/darwin/win32 on Windows using `path.posix`/`path.win32`);
  LF line endings; no shell invocations (`execFileSync` with argv); no Windows-only APIs.
- **Assumed, not verified:** POSIX permission checks, `0600`/`0700` file modes, XDG paths on a real
  home directory, `bwrap` detection, `python3` detection, SQLite features in the Linux Node build,
  behaviour of the probe on the laptop's network.
- **To run on Linux (CI or laptop):** `npm ci && npm run check` (runs the 3 skipped tests),
  `npm run doctor`, and on the laptop `npm run probe` without VPN.

## Decisions for me

1. **Push the 6 local commits?** I was not authorised to push. Pushing would also run the CI workflow
   — the first Linux verification. Recommendation: push.
2. **Commit author email.** Every commit, including the one already on GitHub, records your personal
   Gmail address as the author, which is public in a public repository. Option: set a GitHub
   "noreply" address for this repo (`git config user.email <id>+AMOS-GUY@users.noreply.github.com`)
   before pushing more. Removing it from already-pushed history would need a force-push — your call.
3. **Run the probe on the laptop** (`node scripts/probe-connectivity.ts --json probe.json`, no VPN)
   and tell me which provider accounts you have; this sets the M1 provider shortlist.
4. **Approve the remaining proposed ADRs** (001, 004–008) or amend them before M1.
5. Optional: install WSL2 Ubuntu 24.04 for local Linux testing (needs admin rights).

## Next steps

Recommended next milestone: **M1 — Core agent**, after decisions 1–3. Exact scope (from ROADMAP):
`amosd` HTTP API + SSE on loopback with token auth and Host/Origin checks; `openai-compatible`
provider adapter (streaming, tool-call deltas, usage, error mapping) tested against a local fake
server; router with retry-before-first-token, fallback, circuit breaker and the egress gate; SQLite
tables for conversations, tasks, usage and audit; agent loop without real tools; cancellation and
budgets; CLI chat; `web/` workspace with a minimal React + Vite chat UI. Out of scope for M1: any
filesystem or shell tool (M2).

Before M1 starts it is worth doing two small M0 follow-ups: confirm CI is green on Ubuntu once
pushed, and record the laptop's `doctor` + `probe` output in STATUS.md.
