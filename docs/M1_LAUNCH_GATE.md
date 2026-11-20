# M1 launch gate (2026-11-21)

## Recommendation: **CONDITIONAL GO**

**M1a can start once the five "before any M1 code" items below are settled.** Those items are your
decisions plus one re-run of the tests on the laptop. Nothing technical blocks M1a: the security
foundations it builds on exist, are tested, and passed on Linux (as reported from the laptop and in
Ubuntu CI).

Two kinds of work stay **blocked** behind conditions of their own:

- the web UI (M1b), until browser authentication (D3) is decided;
- any tool beyond an in-memory no-op, until the M2 policy engine exists.

Why not plain GO: the provider order, privacy permissions and budgets are yours to set; D1/D4/D6/D7
shape M1's code; and the M0.5 changes have not yet been re-run on Linux.

Why not NO-GO: there is no unresolved critical or high finding, the Linux prerequisites are met, the
privacy/egress/transport chain that M1's provider adapter must use is implemented and tested, and
every provider endpoint M1 needs is reachable directly.

## M1 objectives (from ROADMAP, with the recommended D1 split)

**M1a — agent core, CLI first:**

- `amosd` on loopback with token auth;
- the `openai-compatible` provider adapter and router;
- conversations and tasks in SQLite;
- an agent loop with a no-op tool only;
- streaming, cancellation and budgets;
- a usage ledger and audit log;
- `amos chat`.

**M1b — web UI:** React + Vite, after D3.

## Preconditions

### Before any M1 code

| #   | Precondition                                                                                                                                           | Owner?           | Status                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ----------------------------------------- |
| P1  | Approve or amend ADR-001 (single `amosd` + thin clients), ADR-005 (OpenAI-compatible adapter first), ADR-006 (policy in code)                          | you              | open                                      |
| P2  | Decide D1 (M1a/M1b split), D4 (one task per user turn), D6 (`node:http` vs Hono), D7 (model presets file), D8 (no proxy in M1 — see PROVIDER_STRATEGY) | you              | open; recommendations in M1_READINESS     |
| P3  | Choose providers: Ollama + which cloud account(s); `privacy.allowPersonalData` per provider; token budgets                                             | you              | open; see PROVIDER_STRATEGY               |
| P4  | Re-run `npm run check` on the laptop after pushing the M0.5 commits (expect 261 passed / 1 skipped)                                                    | you (push + run) | open                                      |
| P5  | Confirm the M0.1 privacy choices (unclassified = `local_only`; `allowPersonalData` required)                                                           | you              | open (implemented, awaiting confirmation) |

### Recommended before M1 code (not blocking)

- Upgrade the dev PC's Node from 24.18.0 to 24.22.3 (security releases), then raise `.nvmrc`,
  `engines` and the doctor minimum together.
- Pin CI actions by SHA (SEC-06).

### Before specific M1 components

| Component                                 | Must exist first                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| First persisted user data (conversations) | SEC-02 fix (parent-directory check), POSIX test run on Linux; `secure_delete` decision for content tables                            |
| Provider adapter                          | Reviewed against SEC-07 rules (bodies only from `contents`, no data in URLs, key only in `Authorization`)                            |
| Local API (`amosd`)                       | `Host`/`Origin` checks, bearer token in a `0600` file in the private config dir, schema-enforced loopback binding (already enforced) |
| Web UI (M1b)                              | D3 decided (recommended: one-time code exchanged for an `HttpOnly` `SameSite=Strict` cookie), ADR-004 approved                       |
| Any tool other than the in-memory no-op   | M2 policy engine; until then the registry refuses tools with effects (M1_READINESS)                                                  |

## Prerequisites by area

| Area           | State                                                                                         | Evidence                             |
| -------------- | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| Architecture   | Coherent; M1 shape fixed by existing gate and transport                                       | ARCHITECTURE §3/§8/§10, M1_READINESS |
| Security       | No open critical/high/medium findings; 2 low open (SEC-02, SEC-06)                            | SECURITY_AUDIT_M0_5                  |
| Linux          | Node 24.22.3, bwrap and userns working, M0.1 suite passed (reported)                          | LINUX_VALIDATION                     |
| Providers      | DeepSeek and Model Studio reachable unauthenticated; Ollama running locally; Anthropic denied | PROVIDER_STRATEGY                    |
| Tool execution | Not started by design (M2)                                                                    | ROADMAP                              |
| Sandbox        | Prerequisites present on the laptop; AMOS integration does not exist (M2)                     | LINUX_VALIDATION                     |

## M1a acceptance criteria

These extend ROADMAP M1.

- [ ] **Streaming, local:** chat streams end-to-end from local Ollama, including in offline mode
      (manual check recorded).
- [ ] **Streaming, cloud:** chat streams from one cloud provider with your key (manual, recorded,
      with a budget in place).
- [ ] **Egress path is unavoidable:** every provider request goes through `authorizeForProvider` and
      `HttpClient`. The boundary test still passes, and a new test shows that `local_only` data never
      reaches a fake cloud provider, including through fallback.
- [ ] **Adapter behaviour (fake server tests):**
  - streaming;
  - tool-call fragment accumulation;
  - usage parsing;
  - every `ProviderErrorKind`;
  - retry only before the first byte;
  - `Retry-After`;
  - circuit breaker.
- [ ] **Budgets:** per-task and per-day token budgets are enforced before and after each call, and
      exceeding one ends the task `failed` (reason `budget`).
- [ ] **Persistence and recovery:** tasks and conversations survive a restart; `running` becomes
      `interrupted`, never resumed silently.
- [ ] **Cancellation:** stops a stream within 2 s; the kill switch is persisted.
- [ ] **API security:** requests without the token, or with a foreign `Origin`/`Host`, are rejected.
- [ ] **Secrets and logging:** no secret appears in logs, the audit log or errors (tests);
      `amos.log` has a single writer (`amosd`).
- [ ] **Data files:** private on POSIX (re-verified on the laptop).
- [ ] **Full suite:** `npm run check` passes on Windows, in Ubuntu CI and on the laptop.

## Not in M1

Real tools, the sandbox, MCP/REA, memory/RAG, document workers, remote access and the web UI
(M1b).
