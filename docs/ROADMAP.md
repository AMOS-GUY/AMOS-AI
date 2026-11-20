# AMOS AI — Roadmap (v0.1, proposal)

Milestones are sequential; each ends with its acceptance criteria met **with evidence** (test output,
CI run, laptop test notes recorded in [STATUS.md](STATUS.md)). A milestone is not complete because the
code was written.

## Changes proposed to the original phase plan

1. **Laptop connectivity probe moved into M0.** Provider choice depends on what the laptop can reach
   without a VPN. This is the biggest unknown and costs ~1 hour to measure.
2. **Audit log and budgets moved into M1.** Model calls cost money and send data; they should be
   logged from the first call.
3. **New checkpoint M2.5 — first laptop deployment.** Run the minimum viable agent on the real
   laptop after M2 instead of waiting until M6. Deployment problems found late are expensive.
4. **Basic text extraction (PDF/DOCX → text) may move into M3** as a tool, because the academic skill
   is useless without it; full indexing stays in M4.
5. **REA stays in M3 but is the last item**, gated on the MCP client being stable.

## M0 — Development foundation

Scope: repo structure, TypeScript config, Biome, Vitest, config schema + loader, platform paths,
secrets loading, structured logging, core types, SQLite verification, secret-scan script, GitHub
Actions CI (Ubuntu + Windows), connectivity probe script, `amos doctor`, these docs.
(npm workspaces are deferred to M1, when `web/` gives them a purpose — ADR-002.)

Acceptance criteria — status as of 2026-11-20 (evidence in [OVERNIGHT_REPORT.md](OVERNIGHT_REPORT.md)):

- [x] `npm ci && npm run check` (typecheck, lint, test, secret scan, build) passes on Windows, including from a fresh clone.
- [x] …and in CI on Ubuntu — CI run #1 (`807d564`) passed on ubuntu-24.04 and windows-latest (step results; see [M0_REVIEW.md](M0_REVIEW.md)).
- [x] Config loads from the platform config dir, is validated, and invalid config gives a precise error (tested).
- [~] Secrets load from env / `secrets.env`; secrets are redacted in logs (tested). An insecure `secrets.env` is _refused_ (stricter than a warning); the real-file POSIX permission tests exist but are skipped on Windows — **pending a Linux run**.
- [x] The secret scan runs in `npm run check` and as a test, and fails on key-like strings and personal paths.
- [~] `scripts/probe-connectivity.ts` runs and reports DNS/response time/status per endpoint (verified on Windows). It deliberately sends no API keys, so "model list with a key" was dropped. Linux run pending.
- [ ] **Probe executed on the laptop**, results recorded in STATUS.md, provider shortlist decided — **owner action**.
- [x] Node version pinned (`.nvmrc` 24, engines `>=24.18.0`); README explains setup on Windows, WSL2 and Mint.

## M0.1 — Security corrections and pre-M1 hardening

Scope: the M0 review findings (F1–F4, F5, F6, F10, F11). Report: [M0.1_HARDENING_REPORT.md](M0.1_HARDENING_REPORT.md).

- [x] F1: private storage — owner-only directories, `0600` database/WAL/SHM/journal/log files, symlinks refused, `temp_store = MEMORY` (POSIX tests written; **run on Linux pending**)
- [x] F2: unclassified data is `local_only`; `public` rejected as a default; unknown/empty labels fail closed; downgrades need explicit owner reclassification
- [x] F3: required `privacy.allowPersonalData` per provider; egress gate with clearances; single HTTP transport (static boundary test)
- [x] F4: `connectTimeoutMs` removed; headers/idle/total timeouts enforced and tested; distinct error codes
- [x] F5: `--help` never runs a command; unsupported flags and arguments rejected
- [x] F6: CI actions v7 (node24 runtime) — **not yet run** (needs a push)
- [x] F10: `amos doctor` reports non-private data/log directories and a writable config directory
- [x] F11: `.gitignore` covers SQLite companion files and probe reports
- [ ] F7: dev PC Node upgrade to 24.22.3 — **owner action** (system install)

## M0.5 — Final readiness audit and M1 launch gate

Report: [M0.5_FINAL_AUDIT.md](M0.5_FINAL_AUDIT.md) · gate: [M1_LAUNCH_GATE.md](M1_LAUNCH_GATE.md).

- [x] Repository, documentation and dependency audit (DOC-01…07 corrected)
- [x] Security review of all source (SECURITY_AUDIT_M0_5: 0 critical, 0 high, 1 medium fixed, 4 low, 8 info)
- [x] SEC-01 env-proxy refusal, SEC-03 doctor child env, SEC-04 URL credentials, SEC-05 single loopback rule, `ignore-scripts` — tested on Windows
- [x] Linux validation recorded from your laptop run ([LINUX_VALIDATION.md](LINUX_VALIDATION.md))
- [x] Provider strategy ([PROVIDER_STRATEGY.md](PROVIDER_STRATEGY.md))
- [ ] Laptop re-run of the M0.5 suite (expect 261 passed / 1 skipped) — **needs a push and your run**
- [ ] SEC-02 (parent-directory check), SEC-06 (SHA-pinned actions) — open, Low

## Milestone status overview (2026-11-21)

| Milestone              | Status                                                                     |
| ---------------------- | -------------------------------------------------------------------------- |
| M0 Foundation          | **Completed and verified** — Windows, Ubuntu CI, laptop (reported)         |
| M0.1 Hardening         | **Completed and verified** — Windows, Ubuntu CI, laptop (reported: 244/1)  |
| M0.5 Audit             | **Completed** on the dev PC; laptop re-run of its fixes pending            |
| M1 Core agent          | **Requires your approval** — CONDITIONAL GO for M1a (M1_LAUNCH_GATE P1–P5) |
| M1b Web UI             | **Blocked** on D3 (browser authentication) and ADR-004                     |
| M2 Tool execution      | Planned. Needs sandbox and path-guard design notes first                   |
| M2.5 Laptop checkpoint | Planned                                                                    |
| M3 Skills & MCP / REA  | Planned                                                                    |
| M4 Knowledge           | Planned (decide `secure_delete` and labels on stored content during M1)    |
| M5 Remote              | Planned. Needs a remote-access ADR first                                   |
| M6 Reliability         | Planned                                                                    |

## M1 — Core agent

Scope: `amosd` HTTP API + SSE, local auth token, web chat UI, `amos` CLI chat, provider interface,
`openai-compatible` adapter, router with retry/fallback/circuit breaker, conversation + task storage,
agent loop (without tools yet beyond a no-op test tool), cancellation, budgets, usage ledger, audit
log of model calls, structured error reporting.

Acceptance criteria:

- [ ] Chat works end-to-end with streaming from at least one real cloud provider and from Ollama (manual check recorded).
- [ ] Provider adapter covered by tests against a local fake server: streaming, tool-call deltas, usage, each error kind, timeouts, `Retry-After`.
- [ ] Router tests: retry only before first token, fallback order, circuit breaker, `local_only` data never routed to a cloud entry.
- [ ] Killing the network mid-stream yields a clear error in UI/CLI within the configured timeout, no hang (test + manual).
- [ ] Conversations and tasks survive `amosd` restart (test).
- [ ] Cancelling a task stops the model stream within 2 s (test).
- [ ] API rejects requests without the token and with a foreign `Origin` (test).
- [ ] Every model call appears in the usage ledger and audit log, with no secret values (test).

## M2 — Tool execution (minimum viable agent)

Scope: tool interface, policy engine, approvals (UI + CLI), path guard, built-in fs tools, `shell.run`
with command classifier and process-group cancellation, bubblewrap adapter (Linux), backups + undo,
trash, taint tracking, kill switch, final reports with evidence.

Acceptance criteria:

- [ ] Path guard test suite: `..` traversal, symlink escape, absolute paths, case-insensitivity on Windows, Unicode names — all denied/allowed correctly.
- [ ] Hard denies (`~/.ssh`, keyrings, `secrets.env`, `.env*`) cannot be overridden by config from a skill (test).
- [ ] Every write creates a backup; `amos undo <task>` restores byte-identical originals (test).
- [ ] Delete never removes data; it moves to trash (test).
- [ ] Commands run without a shell; argv injection attempts are inert (test); unclassified commands require approval (test).
- [ ] Cancellation / kill switch kills child process trees on Linux and Windows (test).
- [ ] Prompt-injection test fixtures (malicious file content, README instructions) do not cause any un-approved write/exec/egress (test).
- [ ] Final report marks claims without tool evidence as unverified (test).
- [ ] Demo task recorded: "fix a failing test in this sample repo" — agent inspects, edits, runs tests, reports, with real tool evidence.

## M2.5 — First laptop deployment (checkpoint)

- [ ] Release tarball built on dev machine, installed on the laptop without internet access to npm.
- [ ] `amos doctor` passes or explains each failure.
- [ ] Laptop checklist items 1–7 (ARCHITECTURE §16) executed; results in STATUS.md.
- [ ] Owner uses AMOS for one real coding or file task on the laptop.

## M3 — Skills and MCP

Scope: skill loader/registry with permission approval and hash pinning, bundled `coding`,
`academic`, `research` skills, MCP client (stdio first), per-tool MCP policy, basic document text
extraction, web fetch tool (+ Playwright with system browser if needed), REA investigation and
integration.

Acceptance criteria:

- [ ] Installing a skill shows its requested permissions; a modified skill requires re-approval (test).
- [ ] MCP server tools appear namespaced, default to `ask`, and a crashing MCP server doesn't crash `amosd` (test).
- [ ] Fetched web content taints the task (test).
- [ ] Academic skill: given a lecture PDF, produces summary + flashcards + quiz, and the quiz-checking mode explains mistakes rather than giving answers first (manual evaluation with real course material).
- [ ] REA registered manually as an MCP server; one static JavaScript analysis task completed on an app the owner is authorised to inspect, under approval policy.

## M4 — Knowledge system

Scope: Python worker protocol, ingestion of PDF/DOCX/PPTX/MD, chunking, full-text search (SQLite
FTS5 — verify availability in `node:sqlite`), optional embeddings (local or China-accessible
provider), memory items (create/inspect/edit/delete), course organisation.

Acceptance criteria:

- [ ] Only explicitly added sources are indexed (test); removing a source removes its chunks (test).
- [ ] Every memory item is visible and deletable in the UI; deletion is real (test).
- [ ] Retrieval quality checked on a small labelled set of questions from real notes.
- [ ] `local_only` sources never reach a cloud model through retrieval (test).
- [ ] Ingestion works offline.

## M5 — Remote access

Scope: decision record comparing Tailscale / Headscale / SSH-based access from the real network,
remote dashboard (mobile-friendly), stronger auth (passkey or TOTP + device tokens), notifications,
task monitoring.

Acceptance criteria:

- [ ] No AMOS port reachable from the public internet (verified with an external scan).
- [ ] Remote access works from a phone on a different network (manual, recorded).
- [ ] Approvals of high-risk actions from remote require re-authentication (test).
- [ ] Revoking a device token cuts access immediately (test).

## M6 — Reliability and deployment

Scope: systemd user service, log rotation, DB backup/restore, update + rollback, OS keychain for
secrets, performance tuning, security hardening review, installation and troubleshooting docs.

Acceptance criteria:

- [ ] Survives reboot, crash (auto-restart), suspend/resume, network change (manual on laptop).
- [ ] Update and rollback tested on the laptop.
- [ ] Restore from backup tested.
- [ ] Threat model reviewed and updated; all "must" mitigations implemented or explicitly accepted.
- [ ] Installation guide followed from scratch by the owner on a clean user account.
