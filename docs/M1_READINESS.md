# M1 readiness review (2026-11-20)

Does the M0 foundation support M1 (ROADMAP: `amosd`, provider adapter and router, conversations,
tasks, agent loop, streaming, cancellation, budgets, usage and audit, CLI chat, web chat)? And what
must be decided before writing M1 code?

## Verdict

**The foundation is ready. The M1 design is not, yet.** M0's config, secrets, logging, storage
wrapper, task state machine, capability schema and egress rules are usable as they are. But **eight
design decisions (D1–D8) are open**, and two of them (D2 privacy approval, D3 browser auth) touch
security. Starting M1 without them would mean deciding them implicitly in code. M1 also depends on
your **laptop probe result** to pick the providers.

## Update after M0.1 (2026-11-20)

M0.1 ([report](M0.1_HARDENING_REPORT.md)) changed this assessment:

- **D2 is implemented** as recommended, option (a): `privacy.allowPersonalData` is required per
  provider, with no default. This was within the M0.1 brief ("each provider configuration must
  explicitly define whether it is permitted to receive personal data"). Revert or amend it if you
  prefer (b) or (c).
- **D5 is implemented** as recommended, option (b): `connectTimeoutMs` was removed in favour of the
  enforced `headersTimeoutMs`, `idleTimeoutMs` and `requestTimeoutMs`.
- **F1–F4 are fixed.** The persistence, privacy and timeout rows in the table below are resolved:
  `openDatabase` enforces private files, the `EgressGate` exists and is wired into the runtime, and
  `HttpClient` is the transport M1 adapters must use.
- M1's provider adapter therefore has a fixed shape: build labelled items → `runtime.egress.authorizeForProvider(id, items, build)` →
  `httpClientFromConfig(config).request({ url, body: clearance, signal })`. Fallback means a new
  `authorizeForProvider` call for the next provider.
- Still open for you: D1, D3, D4, D6, D7, D8, ADR-001/004/005/006 approval, and the laptop probe.

## What M1 can build on, and what it can't

| M1 needs                    | Provided by M0                                                                             | Gap                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Config for providers/models | `providers.*` schema with per-model capabilities, https-only remote, loopback-only `local` | No field saying which providers may receive `personal` data (D2). Writing capabilities by hand for every model is tedious: ship conservative presets as data (D7). |
| API keys                    | `SecretStore.require(apiKeyEnv)`, redactor registration                                    | —                                                                                                                                                                  |
| Task tracking               | `TaskStatus`, transitions, `statusAfterRestart`, `assessRecovery`                          | No tables yet. Task ↔ conversation relationship undecided (D4).                                                                                                    |
| Persistence                 | `openDatabase`, `transaction`, `migrate`                                                   | File permissions (M0_REVIEW F1). `node:sqlite` is synchronous: keep transactions short, and batch stream deltas rather than writing each token.                    |
| Logging/observability       | Redacting structured logger, child bindings                                                | Single writer per log file (F8): `amosd` owns `amos.log`, the CLI logs to stderr.                                                                                  |
| Errors                      | `AmosError` + codes                                                                        | Add `PROVIDER_*`, `TASK_*`, `AUTH_*`, `BUDGET_EXCEEDED` codes.                                                                                                     |
| Privacy                     | `checkEgress`, `combineLabels`                                                             | No caller yet; M1 adds the first (D2).                                                                                                                             |
| Timeouts                    | `network.*` settings                                                                       | `connectTimeoutMs` cannot be implemented with built-in `fetch` (F4, D5).                                                                                           |

## Architecture review by concern

**Provider abstraction.** The internal `ModelProvider` / `StreamEvent` design (ARCHITECTURE §8) is
right. Specific risks:

- OpenAI-compatible streams deliver tool calls as fragments (id and name first, argument JSON in
  pieces). The adapter needs an accumulator, and should emit `tool_call` only when it is complete
  and its JSON parses. A truncated stream (`finish_reason: length`) must not yield a half-parsed call.
- Reasoning output (`reasoning_content` on some providers) has to be **stripped from history**
  before the next request. As I recall, DeepSeek's documentation says its reasoning model returns an
  error if `reasoning_content` is sent back; verify this in M1. Keep it as a separate, non-replayed
  event type.
- `usage` may arrive only in the final chunk, and only with `stream_options.include_usage`. Some
  providers omit it entirely, so fall back to the estimator and flag the figure as estimated.
- Token estimation: Chinese text costs roughly one token per character, versus about four
  characters per token for English. A single chars/4 estimate would undercount Chinese prompts by
  about 4×. Use a script-aware estimate, and always prefer provider-reported usage.

**Streaming.** SSE is the right transport. Make the stream **replayable**: persist task events
(`task_events` table: seq, type, payload) and support `Last-Event-ID`, so a reconnecting UI or CLI
loses nothing. The same table is the audit trail and the debugging record. One mechanism, three
uses.

**Conversation management.** Store messages in the internal vendor-neutral format and render them
per provider at request time. Then fallback to another provider re-renders history instead of
reusing foreign tool-call ids. Mark each message with its privacy label at creation, so the label of
a context is a cheap `combineLabels` over stored labels.

**Agent execution loop.** Fine as designed: budgets on steps, tokens, wall time and spend. Make the
loop a pure state-transition function over persisted state plus an effect runner. Restart recovery
(`statusAfterRestart`) then falls out naturally, and the loop is testable without a network.

**Tool invocation in M1.** The roadmap allows only a no-op test tool, but M1 builds the
tool-calling path. Risk: a tool path without the M2 policy engine invites "temporary" real tools.
**Recommendation:** the M1 tool registry refuses to register any tool whose declared effects
include anything but `read` of in-memory data, until the M2 policy engine exists. Enforce this in
code, not by convention.

**Task tracking.** Decide D4. Recommended: every user turn that triggers model work creates one
task (`task_…`) linked to its conversation (`conv_…`). Tasks carry budgets, status and events;
conversations carry messages.

**Approval workflows.** Not needed functionally in M1, since no tool needs one. But the _schema and
API shape_ should exist so that M2 doesn't rework them: an `approvals` row bound to (task, tool,
SHA-256 of the canonical JSON arguments), states `pending/approved/denied/expired`, created only by
the executor and decided only through the authenticated API. Chat text is never parsed as approval.

**Cancellation.** `AbortController` per task, passed through router → adapter → `fetch`. Cancel
must (1) abort the stream, (2) persist `cancelled` before acknowledging, (3) never be retried by the
router. The kill switch must be **persisted** (a row or flag file), so a restart doesn't resume work
after it was pulled. Test: cancellation lands within 2 s (already in ROADMAP).

**Error handling.** Map every provider failure to `ProviderErrorKind`. A task that fails must end in
`failed`, with the error kind, the last provider tried and a readable reason, never a silent hang.
Distinguish "provider rejected the content" (`content_filter`, not retryable, needs a clear message
since some China-hosted providers filter more strictly) from transport errors.

**Observability.** Bind `task`, `conv`, `provider`, `model` and a per-request `req` id on child
loggers. A usage ledger row per call, with latency, first-token time, tokens, estimated flag and
outcome. `amos doctor` gains provider reachability (respecting `network.offline`).

**Provider failure and retry.**

- Retry only before the first streamed byte. Tool-call fragments count as output.
- Honour `Retry-After`.
- Use a circuit breaker per provider.
- Retrying a non-idempotent call after a timeout can bill twice, which is acceptable but should be
  logged.
- Fallback across providers is also an **egress change**: the next provider must pass the egress gate
  on its own (D2). Never fall back silently to a provider you haven't approved for the data.

**Privacy enforcement.** M1 has one real boundary: model requests. _(Updated for M0.1.)_ The adapter
must build its request body inside `EgressGate.authorizeForProvider` from labelled items only, and
send it with `HttpClient` — which refuses bodies without a matching clearance, and is the only module
allowed to use the network (boundary test). Add an M1 test that a `local_only` message never reaches
a fake cloud provider, even through fallback.

## Decisions to finalise before M1

### Existing ADRs

| ADR                                        | Needed for M1?                              | Recommendation                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001 Single `amosd` + thin clients          | **Yes**                                     | Approve. Refinement: `amos serve` starts the daemon, and `amos chat` talks to it over HTTP. No in-process shortcut, so the CLI and web UI exercise the same API. |
| 004 React + Vite, not Next.js              | **Yes, if the web UI stays in M1** (see D1) | Approve.                                                                                                                                                         |
| 005 OpenAI-compatible adapter first        | **Yes**                                     | Approve, with the provider list chosen from the laptop probe.                                                                                                    |
| 006 Policy in code; model output untrusted | **Yes** (principle)                         | Approve.                                                                                                                                                         |
| 007 bubblewrap, no Docker                  | No (M2)                                     | Defer, pending the laptop's `bwrap` userns result.                                                                                                               |
| 008 Release tarball                        | No (M2.5)                                   | Defer.                                                                                                                                                           |

### New decisions

| #   | Decision                               | Options                                                                                                                                                                | Recommendation                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Scope of M1                            | (a) as planned, CLI + web UI; (b) split into **M1a**: daemon, providers, conversations, tasks, CLI chat; and **M1b**: web UI                                           | **(b)**. The web UI adds the React/Vite dependency tree and the browser-auth problem (D3). Proving the agent core through the CLI first keeps the security-critical part small.                                                                                                                                  |
| D2  | Who may receive `personal` data        | (a) per-provider `allowPersonalData: true` in config, default false; (b) ask on first use and persist; (c) treat the provider you select for chat as approved          | **(a)**. Explicit and auditable. Chat with an unapproved cloud provider fails with a clear message, and local providers are always allowed. Also restrict `privacy.defaultLabel` to `personal`/`local_only` (F2).                                                                                                |
| D3  | How the browser UI authenticates (M1b) | (a) token in a URL (`?token=`, like Jupyter); (b) one-time code printed by `amos serve`, exchanged for an `HttpOnly` `SameSite=Strict` cookie; (c) no auth on loopback | **(b)**. (a) leaks the token into browser history and logs; (c) is unsafe, because any local process or web page could drive the agent. Keep the `Host`/`Origin` checks.                                                                                                                                         |
| D4  | Task ↔ conversation model              | (a) one task per user turn; (b) one long task per conversation                                                                                                         | **(a)**. It gives clean budgets, cancellation and recovery units.                                                                                                                                                                                                                                                |
| D5  | Connect timeout (F4)                   | (a) add `undici` and use its Agent; (b) replace with `firstByteTimeoutMs` + `idleTimeoutMs` via `AbortSignal`                                                          | **(b)**. No new dependency, and it measures what matters on a slow network. Rename the setting before anyone relies on it.                                                                                                                                                                                       |
| D6  | HTTP layer                             | (a) Hono (ADR-001 text); (b) `node:http` + a ~100-line router                                                                                                          | **(b)** for M1a's small API surface: zero dependencies. Revisit for M1b.                                                                                                                                                                                                                                         |
| D7  | Model capability defaults              | (a) hand-written per model by you; (b) a shipped `model-presets.yaml` (conservative values, overridable)                                                               | **(b)**, as data, never as vendor-specific code.                                                                                                                                                                                                                                                                 |
| D8  | Proxy support for provider calls       | (a) none; (b) honour `HTTPS_PROXY` via Node's env-proxy support; (c) explicit `network.proxy` setting                                                                  | **Updated (M0.5): (a) for M1.** The laptop probe reached every M1 endpoint directly, and SEC-01 showed that Node's env-proxy mode would route local-model traffic through the proxy, so the transport now refuses requests while it is on. Never route around a provider's regional restrictions (project rule). |

## Pre-M1 checklist

- [ ] Laptop: LINUX_DEPLOYMENT_CHECKLIST completed, probe results recorded
- [ ] You: provider accounts chosen (from probe results)
- [ ] You: approve or amend ADR-001/004/005/006 and D1–D8
- [ ] You: decide on git email (M0_REVIEW, "Git privacy review")
- [ ] Optional: M0.1 hardening commit (F5, F6, F9, F10, F11), plus the Node 24.22.3 upgrade (F7)
- [x] F1–F4 fixed in M0.1 (no longer M1 work)
