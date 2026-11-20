# Provider strategy for M1 (2026-11-21)

A recommendation based on the laptop's actual connectivity probe ([LINUX_VALIDATION.md](LINUX_VALIDATION.md))
and the code that exists after M0.5. No API keys were created and no authenticated request was
made, so everything below about _authenticated_ use is unverified.

## Connectivity profile (laptop, no VPN)

| Endpoint                              | Result  | What it does and doesn't prove                                                                                            |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek API                          | 401     | Reachable and TLS works; authenticated use, latency under load and model list unverified                                  |
| Alibaba Model Studio (China region)   | 401     | Same                                                                                                                      |
| Alibaba Model Studio (international)  | 401     | Same; the account region decides which endpoint applies                                                                   |
| Local Ollama                          | 200     | Running and reachable on loopback                                                                                         |
| Ollama registry                       | 404     | Answers; model pulls likely work (unverified)                                                                             |
| ModelScope                            | 302     | Answers; an alternative source for model files                                                                            |
| Hugging Face                          | timeout | Not usable directly; don't depend on it                                                                                   |
| Anthropic API                         | 403     | Answers but denies access from this network. Not a usable provider here; AMOS does not route around regional restrictions |
| npm / npmmirror / GitHub / nodejs.org | 200     | Development and updates work directly                                                                                     |
| pypi.org                              | timeout | Use the TUNA mirror for Python workers (M4)                                                                               |
| TUNA PyPI mirror                      | 200     | Works                                                                                                                     |
| Tailscale control                     | 302     | Answers; relevant for M5 only                                                                                             |

Consequence for proxy support (D8): every endpoint M1 needs is reachable **directly**. Combined with
SEC-01 (Node's env-proxy mode would route local-model traffic through a proxy), the recommendation
is **no proxy support in M1**, option (a).

## Recommendation

**One adapter, three targets.** DeepSeek, Model Studio's compatible mode and Ollama all speak the
OpenAI-compatible chat API, so M1 implements **one** `openai-compatible` adapter (ADR-005). The
question is the order in which to validate targets with it:

1. **Local Ollama first, as the development and privacy baseline.**
   - Why: no key, no cost, deterministic test target, works in offline mode, and it is the only
     provider that may receive `local_only` data. Unclassified data is `local_only` by default, so
     Ollama is the only provider that can see it without you relabelling anything.
   - Limits: an 11th-gen i7 with 16 GB and no GPU runs roughly 3–8B quantised models at a few
     tokens per second. That figure is an expectation, not measured. Tool calling with small models
     is unreliable. Measure tokens/s and RAM in M1's smoke test before promising anything.
2. **DeepSeek as the first cloud provider.**
   - Why: reachable, OpenAI-compatible, documented tool calling (verify in M1), and a small API
     surface.
   - Needs: your account and key, and your choice of `privacy.allowPersonalData` for it.
3. **Alibaba Model Studio as the second cloud provider** (fallback).
   - Why: reachable in both regions, and it offers Qwen models through the same adapter.
   - Endpoint: choose the one matching your account region (China region:
     `dashscope.aliyuncs.com/compatible-mode/v1`; confirm with your account).

If you only have a Model Studio account, swap 2 and 3; nothing in the design depends on the order.

## Provider abstraction requirements (for M1)

The code M0.1/M0.5 already provides fixes the shape:

```text
labelled items ──▶ runtime.egress.authorizeForProvider(providerId, items, build)
                        │  label check, provider policy, secret scan → EgressClearance
                        ▼
                   httpClientFromConfig(config).request({ url, body: clearance, signal })
                        │  timeouts, offline, no redirects, env-proxy refusal
                        ▼
                   adapter parses the stream → StreamEvent (ARCHITECTURE §8)
```

The adapter must:

- build bodies only from `contents` (SEC-07);
- read the key with `SecretStore.require(apiKeyEnv)` and send it only in `Authorization`;
- never put data in URLs;
- map HTTP and stream errors to `ProviderErrorKind`;
- accumulate tool-call fragments until complete;
- strip reasoning output from history.

Each provider is configuration, not code: `baseUrl`, `apiKeyEnv`, `location`, `privacy` and
`models`.

## Capability metadata

- Per model, in config, using the existing `modelCapabilitiesSchema`. Conservative defaults:
  `toolCalling: none`, `structuredOutput: none`.
- **Recommended (D7):** ship a `model-presets.yaml` data file with conservative values for the
  models you choose, overridable in `config.yaml`. Values come from provider documentation and are
  marked unverified until an M1 smoke test (with your consent, since it costs tokens) confirms
  them.
- The router filters candidate models by task requirements (`meetsRequirements`) before routing.

## Offline mode

`network.offline: true` (or `AMOS_OFFLINE=1`) already makes the transport refuse every non-loopback
request (tested). In M1:

- The router skips cloud providers up front with a clear message, rather than failing request by
  request.
- Local Ollama keeps working.
- If no local model is configured, a task fails immediately with "offline and no local provider".

## Connectivity failures

- **Error kinds:** the transport already separates `NETWORK_TIMEOUT` (with `phase`),
  `NETWORK_CANCELLED`, `NETWORK_OFFLINE` and `NETWORK` (with the errno code).
- **Retry:** only `network`, `timeout`, `rate_limited`, `server` and `unavailable`
  (`isRetryableProviderError`), only before the first streamed byte, with backoff and jitter, and
  honouring `Retry-After`.
- **Circuit breaker:** per provider, so that after N consecutive failures it is skipped for a
  cool-down. Useful when a route degrades, which is common on this network.
- **Timeouts:** defaults are 60 s headers, 120 s idle and 600 s total. Local CPU models may need
  longer headers/idle timeouts for long prompts; measure in M1.

## Provider switching and fallback

- Profiles are ordered lists of `provider/model` (ARCHITECTURE §8).
- A fallback is a **new egress decision**: the next provider gets its own
  `authorizeForProvider` call. Data that one provider may receive is never sent to another one that
  may not.
- Never fall back silently: the task records and reports which provider answered.
- Switching providers by hand mid-conversation re-renders history from the vendor-neutral store,
  not from foreign tool-call ids.

## Usage and spending controls

- Every model call writes a usage ledger row: provider, model, input/output tokens (provider
  reported, else estimated and flagged), latency, outcome.
- Budgets are enforced **before** a request (estimated tokens vs remaining budget) and **after** it
  (actual usage). When a budget is exceeded, the task ends `failed` with reason `budget`; it never
  silently continues.
- Recommended config (owner decides the values):
  - per-task and per-day **token** caps, required for every cloud provider, with conservative
    defaults;
  - money estimates only if you enter prices yourself. **AMOS must not hard-code prices**: they
    change, and a wrong price is worse than none.
- Rate limits: respect `429` with `Retry-After`; the circuit breaker prevents hammering.
- Estimate tokens script-aware: Chinese text uses far more tokens per character than English.

## Deferred

| Deferred                                  | Reason                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| Anthropic                                 | 403 from this network; enable only where the service is available to you |
| OpenAI, Gemini and others                 | not probed; nothing in the design needs them                             |
| Hugging Face downloads                    | timeout; use the Ollama registry or ModelScope                           |
| Embedding providers                       | M4                                                                       |
| Vision, audio                             | not needed for M1                                                        |
| Automatic cost-based routing              | needs real usage data first                                              |
| Proxy support                             | D8; keep the SEC-01 fail-closed rule                                     |
| Capability auto-detection by test prompts | costs tokens; only with explicit consent                                 |

## Owner decisions

1. Which cloud account(s) you have or will create (DeepSeek, Model Studio, both).
2. For each cloud provider, `privacy.allowPersonalData` — `false` keeps it to `public` data only.
3. Token budgets per task and per day.
4. Which local model to pull into Ollama (size vs speed on 16 GB).
5. D8: confirm "no proxy support in M1".
