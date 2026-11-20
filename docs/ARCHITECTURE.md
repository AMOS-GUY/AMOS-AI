# AMOS AI — Architecture (v0.1, proposal)

Status: **proposal, M0 implemented.** Sections describe the target design; what exists in code today is marked ✅ in §4 and tracked in [STATUS.md](STATUS.md).
Companion documents: [ROADMAP.md](ROADMAP.md) · [STATUS.md](STATUS.md) · [THREAT_MODEL.md](THREAT_MODEL.md) · [DECISIONS.md](DECISIONS.md)

---

## 1. Vision analysis

AMOS AI is a **single-user, local-first, tool-using agent** that runs as a background service on a
Linux Mint laptop and is driven from a local web UI, a CLI, and later a private remote dashboard.

Three properties shape every design decision:

1. **It acts, not just talks.** Once it can write files and run commands, the model's output is an
   _untrusted proposal_ and the surrounding code is the security boundary. The LLM is never trusted
   to enforce policy.
2. **It lives on an unreliable, restricted network.** Model APIs, npm, GitHub, Docker Hub and model
   registries may be slow, blocked or intermittently unavailable on the target. Every external
   dependency needs a timeout, a clear failure message and, where possible, a local alternative.
3. **It must tell the truth about results.** A task is "done" only when a tool produced evidence
   (exit codes, test output, a file that exists). The system records evidence separately from the
   model's narration so the UI can show what was actually verified.

The vision spans ~18 capability areas. Built all at once it would collapse. The architecture is
therefore a **small, stable core** (agent loop + providers + policy + tools + storage) with
everything else — coding, academic, research, REA, knowledge, remote — added as **skills, tools or
MCP servers** on top of that core.

## 2. Key technical risks

| #   | Risk                                                                                                                                                                                                       | Impact                          | Mitigation                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | **Model provider availability on the target network** — a provider reachable from the Windows dev box (via VPN) may be blocked or slow from the laptop. Some providers do not serve mainland China at all. | Agent unusable                  | Provider abstraction with ordered fallbacks; **connectivity probe run on the laptop in M0** before committing to a provider; local Ollama fallback.                                              |
| R2  | **Prompt injection → harmful actions.** Files, web pages, repos and MCP tool descriptions can contain instructions.                                                                                        | Data loss, data exfiltration    | Policy enforced in code, never by the model; taint tracking raises approval requirements once untrusted content is in context; no auto-approve for destructive/egress actions. See THREAT_MODEL. |
| R3  | **Private data sent to cloud models.** Every file the agent reads goes into a prompt, i.e. to the provider.                                                                                                | Privacy breach                  | Labels with a conservative default (unclassified = `local_only`), explicit per-provider `allowPersonalData`, and one egress gate + transport that every outbound body must pass (M0.1, §10).     |
| R4  | **Local models are weak on this hardware.** i7-11th gen, 16 GB RAM, no discrete GPU → realistically 3–8B quantised models at a few tokens/s; small models call tools unreliably.                           | Offline mode disappoints        | Treat local models as _degraded mode_ (chat, summarise, simple tools), not a full replacement. Measure on the laptop before promising anything.                                                  |
| R5  | **Native dependencies fail to install** (prebuilt binaries are downloaded from GitHub at install time, which is unreliable on the target).                                                                 | Can't install/update            | Zero native npm dependencies in the core: use Node's built-in `node:sqlite`; build a self-contained release tarball on the dev machine and copy it over.                                         |
| R6  | **Dev environment ≠ target.** WSL2 Ubuntu is not Linux Mint, and the dev box has a VPN.                                                                                                                    | "Works on my machine"           | CI on Linux, explicit laptop test checklist per milestone (§16), offline/blocked-network tests.                                                                                                  |
| R7  | **Destructive file operations.**                                                                                                                                                                           | Data loss                       | Backups before every modification, delete = move to AMOS trash, permanent purge only by the owner.                                                                                               |
| R8  | **Remote access exposes the machine.**                                                                                                                                                                     | Full compromise                 | Postponed to M5; never public; authenticated overlay network only; agent API stays bound to localhost.                                                                                           |
| R9  | **Cost runaway / infinite loops.**                                                                                                                                                                         | Money, time                     | Per-task step, token, time and spend budgets; usage ledger; kill switch.                                                                                                                         |
| R10 | **Public GitHub repository.** The repo `AMOS-GUY/AMOS-AI` is public.                                                                                                                                       | Secrets or personal data leaked | `.gitignore` for all runtime data, secret scan in `npm test`, no personal notes/config in the repo, examples only.                                                                               |
| R11 | **Scope creep / single developer.**                                                                                                                                                                        | Never finishes                  | Strict milestones with acceptance criteria; postpone list (§7).                                                                                                                                  |
| R12 | **Toolchain drift.** REA needs Node ≥ 24.22.1; the dev box has 24.18. Mint's apt Node is far older.                                                                                                        | Integration breaks              | Pin Node version in `.nvmrc` + `engines`; install Node from the official tarball (or a mirror) on the laptop, not apt.                                                                           |

## 3. Proposed architecture

One long-running Node.js process, **`amosd`**, owns all state and all side effects. Clients (web
UI, CLI, later the remote dashboard) talk to it over a localhost HTTP API with Server-Sent Events
(SSE) for streaming. No microservices, no message broker, no containers required.

```
 ┌────────────┐  ┌────────────┐  ┌──────────────────────┐
 │  Web UI    │  │  amos CLI  │  │ Remote dashboard (M5)│
 │ React+Vite │  │            │  │  via Tailscale/SSH   │
 └─────┬──────┘  └─────┬──────┘  └──────────┬───────────┘
       │  HTTP + SSE, 127.0.0.1 only, bearer token        │
 ┌─────▼───────────────▼─────────────────────▼───────────┐
 │                         amosd                          │
 │  ┌──────────┐   ┌──────────────┐   ┌───────────────┐   │
 │  │ API/Auth │──▶│ Task runner  │──▶│  Agent loop   │   │
 │  └──────────┘   │ queue, cancel│   │ plan→act→check│   │
 │                 └──────────────┘   └───┬───────┬───┘   │
 │        ┌───────────────────────────────┘       │       │
 │  ┌─────▼──────────┐   ┌────────────────────────▼────┐  │
 │  │ Model router   │   │ Tool executor               │  │
 │  │ providers,     │   │  schema check → POLICY →    │  │
 │  │ retry/fallback │   │  approval → backup → run →  │  │
 │  └─────┬──────────┘   │  audit                      │  │
 │        │              └──┬─────────┬─────────┬──────┘  │
 │        │      built-in tools   skills      MCP client  │
 │  ┌─────▼──────────────────────────────────────────────┐│
 │  │ Storage: SQLite (conversations, tasks, approvals,  ││
 │  │ audit log, usage, memory) + backup store + config  ││
 │  └────────────────────────────────────────────────────┘│
 └──────┬───────────────────────────────┬─────────────────┘
        │ HTTPS                          │ stdio / subprocess
 ┌──────▼──────────────┐       ┌─────────▼────────────────┐
 │ Model providers     │       │ MCP servers (REA, …),     │
 │ Qwen, DeepSeek,     │       │ Python workers (M4),      │
 │ Ollama (local), …   │       │ sandboxed shell commands  │
 └─────────────────────┘       └──────────────────────────┘
```

### Core flows

**Task lifecycle.** Tasks are observable state machines. Every transition is persisted (with
timestamp and reason) _before_ the next side effect, so a crash or reboot always leaves an
inspectable record.

| State               | Meaning                                                                            | Terminal? |
| ------------------- | ---------------------------------------------------------------------------------- | --------- |
| `queued`            | Accepted, waiting for a runner slot                                                | no        |
| `running`           | Agent loop active                                                                  | no        |
| `awaiting_approval` | Paused on an owner decision; survives restarts                                     | no        |
| `interrupted`       | Was `running` when `amosd` stopped/crashed or the network/provider failed mid-step | no        |
| `completed`         | Finished; final report written                                                     | yes       |
| `failed`            | Stopped by an error or exhausted budget; report says why                           | yes       |
| `cancelled`         | Stopped by the owner or the kill switch                                            | yes       |

Allowed transitions (enforced by `core/task.ts`, implemented and tested in M0):

```
queued            → running | cancelled
running           → awaiting_approval | interrupted | completed | failed | cancelled
awaiting_approval → running | cancelled | failed
interrupted       → queued (resume) | failed | cancelled
```

**Recovery.** At startup, every task found in `running` is moved to `interrupted` (never silently
resumed). An interrupted task is _recoverable_ only if its last completed step is recorded and no tool
call was in flight with unknown outcome; otherwise resuming requires owner confirmation, because a
half-finished write or command may need inspection first. Resume = back to `queued`, replaying the
persisted conversation, not re-running completed tool calls.

**Agent loop** (per task):

1. Build context: system prompt, active skill instructions, conversation, relevant memory, tool list.
2. Call the model through the router (streaming).
3. If the model requests tool calls → send each through the tool executor (which may pause the task
   for approval) → append results (marked as untrusted data) → go to 1.
4. If no tool calls → produce a **final report** with three sections: _done & verified_ (linked to
   tool evidence), _done but unverified_, _not done / failed_.
5. Stop early on budget exhaustion (max steps, tokens, wall time, spend) or cancellation, and say so.

**Verification rule.** The executor records every tool result (exit code, stdout/stderr tail, files
touched). The final report is rendered with this evidence beside it; a claim like "tests pass" with no
test run in the evidence list is flagged as unverified in the UI.

## 4. Directory structure

The **repository root is the server package** (`amosd` + `amos` CLI) and plain folders mark module
boundaries. The web UI arrives in M1 as one npm workspace (`web/`) nested under the root, so no
existing code has to move. Split into more packages only for a concrete reason.

Folders marked ✅ exist after M0; the rest are created by the milestone shown.

```
AMOS-AI/
├── package.json            # ✅ scripts: build, typecheck, lint, test, check, secret-scan, doctor
├── .nvmrc                  # ✅ pinned Node major
├── tsconfig.json           # ✅ strict; tsconfig.build.json emits dist/
├── biome.json              # ✅ lint + format
├── src/
│   ├── core/               # ✅ pure types + rules: errors, ids, task states, privacy gate, provider capabilities, permissions
│   ├── config/             # ✅ schema, defaults, layered loading, env vars, secrets, platform paths
│   ├── logging/            # ✅ structured JSON logger, redaction, file sink
│   ├── storage/            # ✅ node:sqlite wrapper (private files, temp_store=MEMORY) + migrations (repositories in M1)
│   ├── platform/           # ✅ M0.1 owner-only directories/files (POSIX permission model)
│   ├── net/                # ✅ M0.1 the single HTTP transport: enforced timeouts, cleared bodies only
│   ├── cli/                # ✅ `amos` command: doctor, paths, config show
│   ├── providers/          #    M1 ModelProvider adapters, router, retry, usage
│   ├── agent/              #    M1 agent loop, task runner
│   ├── api/                #    M1 HTTP routes, SSE, auth
│   ├── policy/             #    M2 permission engine, path guard, command classifier, approvals
│   ├── tools/              #    M2 built-in tools
│   ├── skills/             #    M3 skill loader + registry
│   └── mcp/                #    M3 MCP client bridge
├── web/                    #    M1 React + Vite UI (npm workspace)
├── skills/                 # bundled skills (SKILL.md + skill.yaml), e.g. coding/, academic/
├── python/                 # optional document-processing workers (M4), JSON over stdio
├── config/                 # config.example.yaml — never real secrets
├── scripts/                # probe-connectivity, secret-scan, package-release, doctor
├── deploy/                 # systemd/ (M6), launchd/ (later)
├── tests/                  # integration + e2e (unit tests live next to source as *.test.ts)
└── docs/                   # this documentation
```

Runtime data never lives in the repo. It goes to platform directories:

|                           | Linux (XDG)            | macOS                                 | Windows (dev only)          |
| ------------------------- | ---------------------- | ------------------------------------- | --------------------------- |
| Config                    | `~/.config/amos/`      | `~/Library/Application Support/amos/` | `%APPDATA%\amos\`           |
| Data (DB, backups, trash) | `~/.local/share/amos/` | same as config                        | `%LOCALAPPDATA%\amos\`      |
| Logs                      | `~/.local/state/amos/` | `~/Library/Logs/amos/`                | `%LOCALAPPDATA%\amos\logs\` |

## 5. Technology evaluation

| Technology                            | Verdict                                    | Reasoning                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **TypeScript + Node.js**              | **Adopt** (Node 24 LTS, pinned)            | Good fit for I/O-heavy orchestration; same language as MCP SDK and REA; runs on Linux/macOS/Windows.                                                                                                                                                                                                                                                                                                   |
| **SQLite**                            | **Adopt via built-in `node:sqlite`**       | Single file, zero ops. Using Node's built-in module avoids native addons (`better-sqlite3` downloads prebuilt binaries at install, risky on the target network). Wrapped behind a small repository layer so it can be swapped. **M0 finding:** works on Node 24.18 / Windows (SQLite 3.53.1, FTS5, JSON, STRICT, WAL), but Node 24 marks the module _release candidate_ (Stability 1.2) — see ADR-003. |
| **React**                             | **Adopt** (with Vite)                      | Mature, well known. Vite builds static files that `amosd` serves.                                                                                                                                                                                                                                                                                                                                      |
| **Next.js**                           | **Reject for now**                         | Server rendering, its own server runtime and routing conventions add weight we don't need; the backend is `amosd`. A static SPA is simpler to deploy offline.                                                                                                                                                                                                                                          |
| **HTTP framework**                    | **Hono** (or Node `http` if it stays tiny) | Small, no native deps, portable. Streaming via SSE instead of WebSockets: one direction, works through proxies, no extra library.                                                                                                                                                                                                                                                                      |
| **zod**                               | **Adopt**                                  | Runtime validation for config, API input and tool arguments; generates JSON Schema for tool definitions.                                                                                                                                                                                                                                                                                               |
| **MCP** (`@modelcontextprotocol/sdk`) | **Adopt in M3**                            | Standard way to plug in REA and other tool servers. AMOS acts as an MCP _client_.                                                                                                                                                                                                                                                                                                                      |
| **Playwright**                        | **Postpone to M3, use system browser**     | Its default browser download comes from a CDN that may be unreliable on the target; point it at the installed Chromium/Chrome instead.                                                                                                                                                                                                                                                                 |
| **Ollama**                            | **Adopt as optional local provider**       | OpenAI-compatible endpoint, easy model management. Model pulls may be slow on the target network; plan to transfer model files manually if needed.                                                                                                                                                                                                                                                     |
| **Python**                            | **Adopt narrowly in M4**                   | Best ecosystem for PDF/DOCX/PPTX extraction. Run as isolated subprocess workers, not as a second server.                                                                                                                                                                                                                                                                                               |
| **Docker**                            | **Not required**                           | Adds a daemon, root-equivalent group, and registry dependency. Use `bubblewrap` for command sandboxing on Linux; revisit Docker only if a skill truly needs it.                                                                                                                                                                                                                                        |
| **systemd**                           | **Adopt in M6** (user service)             | Native to Mint; restart-on-failure, logs via journald. launchd plist later for macOS.                                                                                                                                                                                                                                                                                                                  |
| **Tailscale**                         | **Evaluate in M5**                         | Easiest secure overlay, but its coordination/relay servers may be unreliable from the target network; compare with self-hosted Headscale, or SSH over a reachable relay. Decide with real measurements.                                                                                                                                                                                                |
| **RustDesk**                          | **Evaluate in M5**                         | For remote _desktop_ only, separate from the agent; self-hosted relay preferred.                                                                                                                                                                                                                                                                                                                       |
| **Lint/format**                       | **Biome**                                  | One tool for lint + format, fast; fewer dependencies than ESLint + Prettier + plugins.                                                                                                                                                                                                                                                                                                                 |
| **Tests**                             | **Vitest**                                 | Fast, TypeScript-native.                                                                                                                                                                                                                                                                                                                                                                               |
| **Package manager**                   | **npm** (already installed)                | pnpm would be one more tool to install on the laptop for no essential gain.                                                                                                                                                                                                                                                                                                                            |

Dependency rule: every new runtime dependency is recorded in [DECISIONS.md](DECISIONS.md) with a
reason. Native addons in the core require an explicit decision.

## 6. Minimum viable agent (MVA)

The MVA is the end of **M2**: the smallest thing that is genuinely useful _and_ safe.

- Web chat UI and CLI talking to `amosd` on localhost.
- One OpenAI-compatible provider adapter configured for at least one China-accessible provider plus
  Ollama; streaming; fallback between them.
- Persistent conversations and tasks in SQLite.
- Agent loop with tool calling, budgets and cancellation.
- Tools: `fs.list`, `fs.read`, `fs.search`, `fs.write` (with backup), `fs.move_to_trash`,
  `shell.run` (allowlisted dev commands, no shell interpolation).
- Permission engine with authorised directories, approval prompts in UI/CLI, audit log, kill switch.
- Final reports separating verified from unverified results.

That is enough to do real coding and file tasks inside one project folder.

## 7. Postponed (and why)

| Postponed                         | Until                                                 | Reason                                                                                                        |
| --------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Knowledge base / embeddings / RAG | M4                                                    | Needs stable tools, storage and egress labels first; embedding model choice depends on provider availability. |
| Document parsing (PDF/DOCX/PPTX)  | M4 (basic text extraction may come earlier as a tool) | Needs the Python worker design.                                                                               |
| Browser automation                | M3                                                    | High prompt-injection exposure; needs taint tracking in place.                                                |
| REA integration                   | M3, after MCP client works                            | Explicit owner instruction; REA is an MCP server, so it plugs in once MCP exists.                             |
| Remote access, notifications      | M5                                                    | Largest attack surface; must come after auth and audit are proven.                                            |
| Desktop/GUI automation            | Post-M6                                               | Fragile, high risk, low priority.                                                                             |
| OS keychain integration           | M6                                                    | 0600 secrets file is adequate initially.                                                                      |
| Multi-agent / sub-agents          | Post-M6                                               | Unnecessary complexity before a single agent is reliable.                                                     |
| macOS packaging                   | When a Mac exists                                     | Architecture keeps it possible (§12); no Mac needed to develop.                                               |

## 8. Provider abstraction

All model access goes through one internal interface. The rest of the system never sees vendor
request formats.

```ts
interface ModelProvider {
  readonly id: string; // "deepseek", "dashscope", "ollama", …
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  capabilities(model: string): ModelCapabilities;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
  healthCheck(signal?: AbortSignal): Promise<HealthStatus>;
}

interface ModelCapabilities {
  streaming: "full" | "text_only" | "none";
  toolCalling: "native" | "none";
  parallelToolCalls: boolean;
  structuredOutput: "json_schema" | "json_object" | "none";
  vision: boolean;
  reasoningOutput: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  location: "local" | "cloud"; // used by the privacy gate (R3, §10)
}

type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string } // e.g. models that expose thinking
  | { type: "tool_call"; id: string; name: string; argumentsJson: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedTokens?: number }
  | { type: "done"; stopReason: "end" | "tool_calls" | "length" | "content_filter" }
  | { type: "error"; error: ProviderError };

type ProviderErrorKind =
  | "network"
  | "timeout"
  | "rate_limited"
  | "auth"
  | "quota"
  | "invalid_request"
  | "content_filter"
  | "server"
  | "unavailable";
```

**Adapters**

1. **`openai-compatible`** — first and most important. Alibaba Cloud Model Studio (Qwen, via its
   OpenAI-compatible mode), DeepSeek, Ollama (`/v1`), and most other China-available providers expose
   this format. One adapter + per-provider config (base URL, headers, quirks) covers them.
2. **`anthropic`** — optional, _disabled by default on the target_. Only enabled where the service is
   legitimately available to the user; the router never routes around regional restrictions.
3. Further native adapters only when an OpenAI-compatible mode is missing a needed feature.

Exact endpoints, model names and features are **verified by the M0 connectivity probe on the
laptop**, not assumed from documentation.

**Capability differences are first-class.** Providers and even models of one provider differ, and the
agent must adapt instead of assuming:

| Dimension         | Variation seen across providers                                      | How AMOS handles it                                                                                                                         |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool calling      | native / native but unreliable / none                                | `toolCalling: "native" \| "none"`; tool-using tasks only route to `native` models. A prompted-JSON fallback is a later option, not assumed. |
| Streaming         | full / text only (tool calls arrive whole) / none                    | Adapter normalises to `StreamEvent`s; non-streaming responses become one burst.                                                             |
| Structured output | JSON schema / JSON mode only / none                                  | `structuredOutput: "json_schema" \| "json_object" \| "none"`; callers validate with zod regardless and retry once on invalid output.        |
| Context limits    | 8k → 1M tokens; output limits differ                                 | Per-model `contextWindow` and `maxOutputTokens` drive context budgeting.                                                                    |
| Reasoning output  | separate reasoning stream / none                                     | `reasoning_delta` events, never fed back to the model unless the provider requires it.                                                      |
| Retry behaviour   | `Retry-After` / rate-limit headers / opaque 5xx; idempotency differs | Per-provider retry policy (max attempts, backoff, which status codes), defaults conservative.                                               |
| Errors            | different codes and bodies                                           | Mapped to one `ProviderErrorKind` set.                                                                                                      |

The capability record is configuration data per model (with sane adapter defaults), not hard-coded
per vendor, so a new China-available provider needs only config. The M0 type for this lives in
`src/core/provider.ts`; no adapter exists until M1.

**Router & profiles.** Configuration defines _profiles_ (e.g. `default`, `coding`, `cheap`,
`offline`), each an ordered list of `provider/model` entries. The router:

- **Retries** retryable errors (`network`, `timeout`, `rate_limited`, `server`) with exponential
  backoff + jitter, honouring `Retry-After`, **only before the first token has streamed**. After
  partial output, it surfaces the error rather than silently duplicating work.
- **Falls back** to the next entry when retries are exhausted or a circuit breaker for a provider is
  open (N consecutive failures → skip it for a cool-down period).
- **Respects privacy:** every candidate passes through the egress gate (§10), which applies each
  provider's own `privacy.allowPersonalData` and location. A fallback to another provider is a new
  egress decision. If no candidate may receive the data, the task stops with a clear message
  instead of leaking it.
- **Never falls back across providers in the middle of an approval-pending tool sequence** without
  re-sending full context, and tells the user which model answered.
- Applies the **timeouts the transport enforces** (`src/net/http.ts`, M0.1): `headersTimeoutMs`
  (until response headers — this includes DNS, connect and TLS; there is no separate connect
  timeout, because built-in `fetch` cannot provide one), `idleTimeoutMs` (silence between body
  chunks, i.e. between streamed tokens) and `requestTimeoutMs` (whole exchange). Timeouts,
  cancellation, offline refusal and transport failures are separate error codes.

**Context management.** Token estimates per model; when near the window: drop old tool outputs
first (keeping a summary line), then summarise older turns with the current model; never drop the
system prompt, safety rules or the user's current request.

**Usage monitoring.** Every call writes a row to `usage` (provider, model, tokens, latency, cost
estimate, outcome). Budgets per task and per day are enforced from this ledger.

**Secrets.** API keys come from environment variables or `~/.config/amos/secrets.env` (mode 0600,
checked at startup). Config files reference keys by name (`apiKeyEnv: DEEPSEEK_API_KEY`), never by
value. Keys are never logged, never sent to the model, and redacted from audit records.

## 9. Tool execution architecture

```ts
interface ToolDefinition<I, O> {
  name: string; // "fs.read", "shell.run", "mcp.rea.analyze_…"
  description: string;
  input: ZodSchema<I>; // → JSON Schema for the model
  effects: Effect[]; // "read" | "write" | "delete" | "exec" | "network" | "egress"
  risk: "low" | "medium" | "high";
  resources(input: I): ResourceRef[]; // paths/hosts/commands touched, for the policy engine
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}
```

**Execution pipeline** (every call, no exceptions):

1. **Parse & validate** arguments against the schema. Invalid → error back to the model.
2. **Resolve resources**: canonicalise paths (`realpath`, symlinks resolved, `..` rejected after
   resolution), parse command argv.
3. **Policy decision** → `allow` | `ask` | `deny` (§10). Deny → error to the model with the reason.
4. **Approval** if `ask`: persist an approval request, set the task to `awaiting_approval`, show it in
   UI/CLI with the exact action (diff for writes, argv + cwd for commands). Approve once / approve for
   this task / deny.
5. **Pre-execution hooks**: backup snapshot for writes/moves; trash move instead of delete.
6. **Execute** with an `AbortSignal`, a timeout, output size caps, and a scrubbed environment (no
   secrets inherited). Shell commands run as a separate process group so cancellation kills children.
7. **Audit**: record input, decision, approver, result summary, duration, files touched.
8. **Return** the result to the model wrapped as untrusted data
   (`<tool_result source="fs.read" trust="untrusted">…</tool_result>`), truncated with a note if large.

**Built-in tools in M2:** `fs.list`, `fs.stat`, `fs.read`, `fs.search`, `fs.write`, `fs.edit`
(exact replace), `fs.move`, `fs.move_to_trash`, `shell.run`, `git.status`, `git.diff`.

**Shell execution.** `shell.run` takes an argv array, not a shell string, and runs without a shell.
A command classifier maps binaries to classes:

| Class                    | Examples                                                   | Default                                               |
| ------------------------ | ---------------------------------------------------------- | ----------------------------------------------------- |
| read-only dev            | `git status/diff/log`, `ls`, `cat`, `node --version`       | allow in workspace                                    |
| build/test               | `npm test`, `npm run build`, `tsc`, `pytest`, `cargo test` | allow in workspace, logged                            |
| package install          | `npm install`, `pip install`                               | ask (network + code execution)                        |
| system                   | `apt`, `sudo`, `systemctl`, `chmod -R`, `mount`            | ask, always shown in full; `sudo` never auto-approved |
| destructive/unknown      | `rm -rf`, `dd`, `mkfs`, anything unclassified              | ask                                                   |
| shell mode (`bash -c …`) | pipes, redirects                                           | ask, high risk                                        |

On Linux, commands run inside **bubblewrap** when available (read-only system, writable workspace
only, optional no-network). Where bubblewrap is unavailable (Windows dev, macOS), the policy is
stricter instead (more `ask`). Sandbox availability is reported by `amos doctor`.

**Backups.** Before any write/move: copy the original into a content-addressed store
(`data/backups/<sha256>`) and add a journal entry (task, path, hash, time). `amos undo <task>`
restores. Retention is configurable; the store is pruned by age/size, never silently while a task
is active.

## 10. Security model (summary)

Full detail and threat analysis in [THREAT_MODEL.md](THREAT_MODEL.md).

**Principals and trust:**

| Source                                                                           | Trust              | Can authorise actions? |
| -------------------------------------------------------------------------------- | ------------------ | ---------------------- |
| Owner via authenticated UI/CLI                                                   | trusted            | yes                    |
| AMOS config files (owner-edited)                                                 | trusted            | defines policy         |
| The model's output                                                               | untrusted proposal | no — only _requests_   |
| File contents, web pages, repo files, tool output, MCP tool descriptions, emails | untrusted data     | never                  |

**Policy engine.** Declarative rules evaluated in code for every tool call:
`(tool, effect, resource, task taint, skill) → allow | ask | deny`. Initial defaults:

| Action                                                                         | Default                                                  |
| ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Read files                                                                     | allow only inside authorised directories; deny elsewhere |
| Create files                                                                   | allow in approved workspaces                             |
| Modify files                                                                   | allow in workspaces **with backup**; ask outside         |
| Delete files                                                                   | ask; executes as move-to-trash                           |
| Permanent purge                                                                | owner-only command, never a model-callable tool          |
| Ordinary dev commands                                                          | allow in workspace, logged                               |
| Package installs                                                               | ask                                                      |
| `sudo` / system changes                                                        | ask, every time, no "remember"                           |
| Secrets (`~/.ssh`, `~/.gnupg`, keyrings, `secrets.env`, `.env*`)               | deny (hard-coded, not overridable by skills)             |
| Sending data externally (non-model network, uploads, messages)                 | ask                                                      |
| Content labelled `local_only` to a cloud model, external tool or remote client | deny (egress gate)                                       |
| Content labelled `secret` to any destination                                   | deny (egress gate)                                       |

**Enforcement lives in the execution layer.** The tool executor is the only code path that performs
side effects, and it calls the policy engine itself. Neither the model's reasoning, nor a
conversational "yes" typed into chat, nor a skill's instructions can bypass it: an approval is a
persisted record bound to one specific pending action (tool + canonical arguments hash), created only
through the authenticated approval API. Chat text is never parsed as approval.

**Privacy classification and the egress gate** (implemented in M0.1 — `src/core/privacy.ts`,
`src/core/egress-gate.ts`, `src/net/http.ts`; ADR-012, ADR-015–017). Every piece of data carries a
label:

| Label        | Meaning                                                       | May be sent to (model providers)                                           |
| ------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `public`     | Public web content, open-source code — only when labelled so  | any enabled provider                                                       |
| `personal`   | Owner data the owner allows to leave the machine              | enabled providers with `privacy.allowPersonalData: true`                   |
| `local_only` | **Default for unclassified data**; directories marked private | enabled providers with `location: local` **and** `allowPersonalData: true` |
| `secret`     | Credentials, keys, tokens                                     | nothing, ever                                                              |

Rules (all fail closed):

- **Unclassified data is `local_only`.** `privacy.defaultLabel` may be `local_only` (default) or
  `personal`; `public` is rejected. Unknown labels are rejected.
- **The most restrictive label wins** when data is combined; combining _no_ labels is an error, so a
  forgotten label cannot turn into "public".
- **Lowering a label** needs an explicit owner reclassification with a reason. `secret` can never be
  lowered.
- **Every provider must declare `privacy.allowPersonalData`** (no default). Disabled providers
  receive nothing.
- **External tools and remote clients** have no data policy yet, so they may receive `public` data
  only (until M3/M5 define one).

Enforcement: the **EgressGate** is built once from validated config (`createEgressGate`). Callers
name a provider and hand over labelled items. The gate computes the label itself, applies the
provider's policy, refuses any body that contains a known secret value (defence in depth against
mislabelled data), and returns an **EgressClearance**: the serialised body bound to the provider's
URL origin, registered in a module-private `WeakSet`. The **HTTP transport** is the only module
allowed to make requests (a test enforces this). It sends a body only when it carries a genuine
clearance for the request's origin, sends nothing but `GET` without one, refuses redirects, and in
offline mode reaches loopback only. It also refuses every request while Node's env-proxy mode is on
(`NODE_USE_ENV_PROXY` / `--use-env-proxy`), because Node would then tunnel even `127.0.0.1` traffic
through `HTTP_PROXY` (M0.5, SEC-01), and it refuses URLs with embedded credentials. What this does not stop is AMOS code that deliberately builds a
body from data it didn't declare to the gate; that contract is kept by review and tests.

**Taint tracking.** When a task has read untrusted content (web page, downloaded file, unfamiliar
repo, MCP output), it becomes _tainted_: medium/high-risk actions that were `allow` become `ask`.
This limits what a prompt injection can do without the owner noticing.

**Kill switch.** `amos stop` (CLI), a UI button, and a signal handler: cancel all tasks, kill all
child process groups, block new tool executions until re-enabled.

**API security.** `amosd` binds to `127.0.0.1` only; every request needs a bearer token stored in the
config dir (0600); `Host`/`Origin` checks block DNS-rebinding and cross-site requests from the browser.

## 11. Skill system

A **skill** packages _instructions + optional scripts + declared requirements_ for a domain
(coding, academic, research, reverse engineering). Skills do not add new security powers.

```
skills/academic/
├── SKILL.md       # frontmatter (name, description) + instructions, loaded only when relevant
├── skill.yaml     # version, required tools, requested permissions, config schema
├── references/    # extra docs loaded on demand
└── scripts/       # optional helpers, executed through shell.run under normal policy
```

- **Format** follows the widely used `SKILL.md` convention so third-party skills (REA ships one) can
  be reused after review.
- **Progressive disclosure:** only each skill's name + description sit in the system prompt; the
  full `SKILL.md` is loaded when the agent (or user) activates it. Keeps context small for weaker
  models.
- **Permissions:** `skill.yaml` _requests_ capabilities (e.g. `network: ["arxiv.org"]`,
  `tools: [shell.run]`). The owner approves at install time; the policy engine still applies to
  every call. A skill can never relax the hard-coded denies.
- **Registry** in SQLite: installed skills, version, enabled flag, approved permissions, content hash
  (changes to a skill's files require re-approval).
- **Bundled skills (M3):** `coding` (the inspect → plan → implement → test → lint → build → review
  workflow from the brief), `academic` (learning-first: explain, quiz, check work rather than hand
  over answers), `research` (sources, citations, verified vs. speculative).

**MCP servers** are configured separately (command, args, env allowlist, working dir) and their tools
appear as `mcp.<server>.<tool>`, defaulting to `ask` until the owner sets per-tool policy. Tool
descriptions from MCP servers are treated as untrusted text.

**REA** (investigated 2026-11-20 from its README): a TypeScript MCP server distributed as the
`rea-agents` npm package (MIT), requiring Node 22.23.4+/24.22.1+/26.12.1+; native analysis needs
Hopper, Ghidra, IDA or Kuna; static JS/Electron analysis needs none; on Linux some features require a
procps-compatible `ps`. Its `setup` command edits agent configs for supported agents — for AMOS we
would register it **manually** as an MCP server instead. Integration plan: M3, after the MCP client
is stable, starting with static JS analysis (no extra engine), under taint and `ask` policy, and only
on software the owner is authorised to analyse.

## 12. Linux Mint deployment

Assumption to verify on the laptop: Linux Mint 22.x (Ubuntu 24.04 base). Everything installs into
the owner's home directory; **no root is needed** except for optional system packages
(bubblewrap, git, python3-venv) that the owner installs with apt.

| Concern                | Strategy                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Packaging** (M2.5)   | `npm run package` (not yet implemented) on the dev machine → `amos-<version>.tar.gz`: compiled JS, production `node_modules`, built web UI (M1+), `deploy/` files, checksum file. No native addons ⇒ one tarball for Linux/macOS/Windows.                                                                                                                                                                                                                  |
| **Dependencies**       | Runtime: Node 24 LTS only (+ optional: git, bubblewrap, Python 3 for M4 workers, Ollama). Install Node from the official tarball (or a trusted mirror) into `~/.local/opt/node` — apt's Node is too old. Production npm deps are bundled in the tarball, so the laptop never needs the npm registry.                                                                                                                                                       |
| **Installation**       | Copy tarball (USB/scp) → verify checksum → unpack into `~/.local/opt/amos/<version>/` → symlink `~/.local/opt/amos/current` → symlink `~/.local/bin/amos` → `amos doctor`.                                                                                                                                                                                                                                                                                 |
| **Configuration**      | `~/.config/amos/config.yaml` (owner-edited, validated at start), `~/.config/amos/secrets.env` (mode 0600), `AMOS_*` environment variables override for one run. `amos config show` prints the effective config with secrets redacted.                                                                                                                                                                                                                      |
| **Data**               | `~/.local/share/amos/` (SQLite DB, backups, trash). Logs in `~/.local/state/amos/logs/`.                                                                                                                                                                                                                                                                                                                                                                   |
| **Backups**            | `amos backup` (M6) uses SQLite's online backup API (`node:sqlite` `backup()`) to write a consistent snapshot, plus a tarball of config (secrets excluded unless asked). Automatic snapshot before every migration and upgrade. Backup files must be written with the same private-file rules as the database (`ensurePrivateFile` in `src/platform/private-fs.ts`, 0600 in a 0700 directory) — a backup is a full copy of the data. Restores tested in M6. |
| **Upgrades**           | Unpack new version beside the old → `amos doctor` with the new binary → stop service → back up DB → switch `current` symlink → start → migrations run (forward-only, each in a transaction) → health check.                                                                                                                                                                                                                                                |
| **Rollback**           | Stop → point `current` at the previous version → restore the pre-upgrade DB snapshot (because migrations are forward-only) → start. Last two versions are kept.                                                                                                                                                                                                                                                                                            |
| **Startup / shutdown** | M6: `systemd --user` unit `amosd.service` (`Restart=on-failure`, `TimeoutStopSec`), optional `loginctl enable-linger`. On SIGTERM: stop accepting work, mark running tasks `interrupted`, kill child process groups, close DB, exit. Until M6: started manually.                                                                                                                                                                                           |
| **Logs**               | JSON lines to stdout (captured by journald under systemd: `journalctl --user -u amosd`) and to a size-rotated file in the state dir. Secrets and document contents are never logged (§ logging policy in `src/logging`).                                                                                                                                                                                                                                   |
| **Health**             | `amos doctor`: Node version, `node:sqlite`, dir permissions, secrets file mode, bubblewrap, git, Python, (M1+) provider reachability, Ollama, disk space.                                                                                                                                                                                                                                                                                                  |

**macOS later:** the same tarball, paths from the platform table (§4), a `launchd` plist instead of
systemd, and a stricter approval policy in place of bubblewrap (macOS has no equivalent we can rely on). No Mac-specific code is needed now
as long as path handling goes through one `platformPaths()` module and process control avoids
Linux-only APIs outside the sandbox adapter.

## 13. How WSL2 helps (and its limits)

**Current state:** WSL is **not installed** on the dev machine (checked 2026-11-20). Installing it is
a system change for the owner to make (`wsl --install -d Ubuntu-24.04`). Until then, development and
tests run natively on Windows, and **GitHub Actions on Ubuntu** (free for public repos) is the
Linux check.

**What WSL2 Ubuntu 24.04 gives us:** same base as Mint 22 (glibc, coreutils, `/proc`, permissions,
symlinks, signals, process groups), bubblewrap, real Linux paths, `systemd` (when enabled) for
testing the service unit, and Linux-native file watching.

**What it does not give us:**

- **Network realism** — it shares the Windows VPN. Every provider "works" from WSL; that says
  nothing about the laptop. We simulate restrictions with a test mode that blocks hosts and an
  offline flag, and rely on the laptop probe.
- Cinnamon desktop, keyring, input methods, sleep/resume, battery, real CPU-only model performance.
- Mint-specific packages/defaults (AppArmor settings, user-namespace restrictions affecting bwrap).

**Rule:** keep the repo inside the WSL filesystem (`~/src/AMOS-AI`), not `/mnt/c` or `/mnt/e`
(slow, and permissions/case behave differently).

## 14–15. Roadmap and acceptance criteria

See [ROADMAP.md](ROADMAP.md).

## 16. What must be tested on the actual Linux laptop

These cannot be proven in WSL or CI:

1. **Provider reachability & latency** from the laptop's real network, without VPN: each candidate
   provider's API, plus npm registry/mirror, GitHub, Ollama model registry, PyPI.
2. **Node install** method and the release tarball unpacking and running.
3. **Local model performance**: tokens/s and RAM use for 3B/7B/8B quantised models; tool-calling
   reliability; behaviour with browser + IDE open on 16 GB.
4. **bubblewrap** works for an unprivileged user (Ubuntu 24.04-based systems may restrict
   unprivileged user namespaces via AppArmor).
5. **systemd user service**: start on boot/login, restart on crash, survive suspend/resume and
   network changes (Wi-Fi switching).
6. **Filesystem edge cases**: Chinese/UTF-8 file names, spaces, symlinks, permissions on real home dir.
7. **Offline mode**: disconnect network mid-task; verify clear errors, queuing, local fallback.
8. **Python workers** with Mint's system Python (venv), document extraction on real course PDFs.
9. **Browser automation** with the installed Chromium/Firefox (M3).
10. **Remote access** solution from outside the laptop's network (M5).
11. **Resource use** at idle (CPU wake-ups, RAM), battery impact.
