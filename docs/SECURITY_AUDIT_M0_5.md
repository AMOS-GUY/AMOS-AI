# Security audit — M0.5 (2026-11-21)

## Methodology

- **Scope:** every source file in `src/` and `scripts/`, the CI workflow, `package.json`,
  `package-lock.json` and `.npmrc`, plus the security-relevant docs (ARCHITECTURE §8–§12,
  THREAT_MODEL, DECISIONS).
- **Method:** read the code; for each suspected weakness, write an experiment or test that shows
  whether it is real before calling it a finding. Fixes get a regression test and a mutation check
  (break the fix, confirm the test fails, restore).
- **Environment:** the Windows 11 dev PC, Node 24.18.0. **This audit could not execute anything on
  Linux.** POSIX-specific behaviour is covered by tests that passed in Ubuntu CI (inferred from step
  results) and by your own laptop run (reported in the brief — see
  [LINUX_VALIDATION.md](LINUX_VALIDATION.md)).
- **Severity scale:**

  | Level         | Meaning                                                                   |
  | ------------- | ------------------------------------------------------------------------- |
  | Critical      | Exploitable now, with serious impact                                      |
  | High          | Likely to leak data or allow unauthorised action once the feature is used |
  | Medium        | Realistic configuration can defeat a stated guarantee                     |
  | Low           | Defence-in-depth gap                                                      |
  | Informational | Documented limitation or residual risk                                    |

## Summary

| Severity      | Count | Status                                                                 |
| ------------- | ----- | ---------------------------------------------------------------------- |
| Critical      | 0     | —                                                                      |
| High          | 0     | —                                                                      |
| Medium        | 1     | fixed (SEC-01)                                                         |
| Low           | 4     | 2 fixed (SEC-03, SEC-04), 2 open with recommendations (SEC-02, SEC-06) |
| Informational | 8     | 1 fixed (SEC-05), 1 hardened (SEC-08), 6 accepted/documented           |

No finding was hidden, and no claim below is made without the evidence listed. "Fixed" means
fixed and tested on Windows, with Linux behaviour unchanged by design.

## Findings

### SEC-01 — Node env-proxy mode routes loopback traffic through a proxy · Medium · **Fixed** (`f3bc307`)

- **What:** Node 24 has opt-in support for `HTTP_PROXY`/`HTTPS_PROXY` (`NODE_USE_ENV_PROXY=1` or
  `--use-env-proxy`). When it is on, Node tunnels **even plain-http requests to `127.0.0.1`**
  through the proxy.
- **Why it matters:** traffic to a local model (Ollama), including `local_only` data, could pass
  through a proxy process in plain text. If `HTTP_PROXY` points to another machine, that data leaves
  the laptop. "Offline mode = loopback only" would no longer hold. Proxy and VPN tools are common on
  the target network, so this configuration is realistic.
- **Evidence:** a loopback experiment with a fake proxy and a fake model server (now
  `tests/env-proxy.test.ts`):
  - with `HTTP_PROXY` only, the request goes direct (0 proxy contacts);
  - with `NODE_USE_ENV_PROXY=1` added, the proxy received `CONNECT 127.0.0.1:<port>` and the model
    server received nothing;
  - with `NO_PROXY=localhost,127.0.0.1` added, the request goes direct again.
- **Fix:** `src/net/http.ts` refuses every request while env-proxy mode is on, with `NETWORK`,
  `details.cause = ENV_PROXY_UNSUPPORTED` and a hint. The check reads real process state on each
  request and is not a constructor option. `amos doctor` shows `[FAIL] proxy`. The probe script warns
  that its results would describe the proxy route.
- **Why refuse rather than parse `NO_PROXY`:** reimplementing Node's `NO_PROXY` matching is
  error-prone, and proxy support is an open owner decision (M1_READINESS D8). The laptop reached
  every M1-relevant endpoint directly (PROVIDER_STRATEGY), so refusing costs nothing today.
- **Tests:**
  - `tests/env-proxy.test.ts` — 4 cases, including a control that proves the leak path is real on
    this Node;
  - `src/net/http-hardening.test.ts`;
  - `src/cli/doctor-hygiene.test.ts`.
  - Mutation (refusal removed): 3 tests fail.
- **Residual risk:** a future Node version could turn env-proxy mode on by default or add another
  switch. The control test would then flag the changed behaviour, but only if `NODE_USE_ENV_PROXY`
  is the switch. Re-check on Node upgrades.

### SEC-02 — Parent of the data directory is not checked · Low · **Open**

- **What:** `ensurePrivateDir` verifies the data/log directory itself (owner, `0700`) but not its
  parent. If the parent is writable by other users _without_ the sticky bit (e.g.
  `AMOS_DATA_DIR=/shared/amos` with `/shared` at `0777`), another user could rename the directory
  and substitute their own between AMOS's check and SQLite creating a `-wal` file.
- **Evidence:** code reading (`src/platform/private-fs.ts`). Not exploitable with the default XDG
  paths (`~/.local/share`) or `/tmp` (sticky).
- **Recommendation:** in M1, when AMOS first stores real data, also refuse a parent that is
  other-writable and not sticky, as ssh does for path components. I didn't fix it tonight: the fix
  can only be tested on POSIX, and this PC cannot run it.

### SEC-03 — `amos doctor` passed the full environment to helper programs · Low · **Fixed** (`f3bc307`)

- **What:** `execFileSync` without `env` inherits `process.env`. `git --version`, `python3 --version`
  and `bwrap --version` received every variable, including API keys such as `DEEPSEEK_API_KEY`.
- **Fix:** `childEnv()` passes only an allowlist: `PATH`, `HOME`, locale, temp vars, and the
  variables Windows needs to start a program.
- **Tests:** `doctor-hygiene.test.ts` checks the allowlist. The wiring into `execFileSync` is covered
  by review only: tool lookup still worked on Windows with the reduced environment (doctor output
  unchanged).

### SEC-04 — Credentials and query strings accepted in provider `baseUrl` · Low · **Fixed** (`f3bc307`)

- **What:** `https://user:pass@host/v1` and `https://host/v1?key=…` passed validation, and
  `amos config show` printed them verbatim. Log lines would too, in M1.
- **Evidence:** a validation run before the fix accepted all three forms.
- **Fix:**
  - The schema rejects username/password, query string and fragment, with messages pointing to
    `apiKeyEnv`.
  - The transport separately refuses URLs with embedded credentials.
  - Neither message repeats the credential.
- **Tests:** `url-hygiene.test.ts`, `http-hardening.test.ts`. Mutations: 2 caught.

### SEC-05 — Two different loopback definitions · Informational · **Fixed** (`f3bc307`)

- **What:** the config schema accepted only `localhost`, `127.0.0.1` and `[::1]` as local; the
  transport accepted all of `127.0.0.0/8`. Not exploitable (config was the stricter one), but a
  correctness hazard.
- **Fix:** one function, `src/core/loopback.ts`, used by both. A test asserts they share it.

### SEC-06 — GitHub Actions pinned by tag, not commit SHA · Low · **Open (owner choice)**

- **What:** `actions/checkout@v7` and `actions/setup-node@v7` are mutable tags. A compromised tag
  could run code in CI.
- **Already mitigating:** `permissions: contents: read`, `persist-credentials: false`, no secrets
  used in CI, no `pull_request_target`.
- **Recommendation:** pin to full commit SHAs (with a comment naming the version) and update them
  deliberately. Not done tonight, because it means choosing and verifying specific SHAs, and the
  workflow cannot be re-run without a push.

### SEC-07 — The egress gate trusts the body builder; GET URLs can carry data · Informational · Accepted

- **What:** `authorizeForProvider` cannot stop AMOS code from smuggling undeclared data into the
  body through the `build` closure. The transport lets `GET` without a clearance through, so data
  could be encoded in a URL.
- **Recommendation:** these are code-review rules for M1 (recorded in M1_LAUNCH_GATE).
  - Provider adapters build bodies only from `contents`.
  - No provider call uses `GET` with data.
  - Consider making a `GET` URL's query string require a clearance once adapters exist.

### SEC-08 — Dependency lifecycle scripts · Informational · **Hardened** (`f3bc307`)

- **Evidence:** `package-lock.json` has no `hasInstallScript` entries, and `npm audit` reports 0
  vulnerabilities (103 packages with integrity hashes).
- **Hardening:** `.npmrc` now has `ignore-scripts=true`. A clean `npm ci` followed by
  `npm run check` in a fresh worktree passed with it set.
- **Residual risk:** the lockfile pins exact versions and hashes, but nothing stops a reviewed
  upgrade from pulling in something bad. Review dependency diffs on upgrades.

### SEC-09 — POSIX permission code verified only indirectly · Informational

- The 15 POSIX-only tests are skipped on Windows. Two things suggest they pass on Linux:
  - they ran in Ubuntu CI (step results for `c7990ad` and `a8001a3`; per-test output needs a
    GitHub sign-in);
  - your laptop run reported 244 passed, 1 skipped at that baseline, which matches.
- This audit added no new POSIX-only tests.

### SEC-10 — No encryption at rest · Informational · Accepted

The database and logs are protected by file permissions only. Full-disk encryption is the
recommended control (THREAT_MODEL, out of scope).

### SEC-11 — `localhost` relies on the OS resolver · Informational

`isLoopbackHost("localhost")` trusts that `localhost` resolves to loopback, which `/etc/hosts`
controls. Only root can change it, and root is out of scope. Prefer `127.0.0.1` in provider config.

### SEC-12 — Windows has no permission checks · Informational · Documented

POSIX modes don't exist on Windows; AMOS relies on profile ACLs. Windows is a development platform
only.

### SEC-13 — Secrets in process memory and environment · Informational

- Secrets read from the environment are visible to the same user via `/proc/<pid>/environ` (Linux).
  This is the same trust boundary as the user account.
- The redactor only knows environment secrets after they are accessed. Values from `secrets.env`
  are registered at load.

## Checked and found sound (no finding)

- **Config:** strict objects, duplicate keys, the loopback-only server binding, `public` rejected as
  a default, the removed `connectTimeoutMs`, and secret-like keys. All re-confirmed by running the
  CLI with temporary directories.
- **Secrets file:** owner and `0600` enforcement on POSIX; parse errors name the line, never its
  content.
- **Logging:**
  - field-name redaction (with token counts kept);
  - content omission;
  - registered-value and token-shape masking;
  - error serialisation masks secrets;
  - a failing sink is isolated.
- **Egress gate:**
  - provider policy comes from config only;
  - strict `=== true`;
  - labels are combined by the gate itself;
  - clearances are frozen, `WeakSet`-registered and bound to an origin;
  - secret scan of raw and JSON-escaped bodies.
- **Transport:**
  - `redirect: "error"`;
  - offline = loopback only;
  - https-only for remote hosts;
  - headers/idle/total timeouts;
  - cancellation;
  - size cap;
  - listener and timer cleanup.
- **Boundaries test:**
  - only `src/net/http.ts` calls `fetch` or imports networking modules;
  - only `src/storage/sqlite.ts` imports `node:sqlite`;
  - only doctor spawns processes.
  - Doctor now imports from `src/net` (the env-proxy check), which the rules allow.
- **CI:** read-only token, `persist-credentials: false`, and no secrets used.
- **Package scripts:** `clean.ts` refuses paths outside the repo. No `pre*`/`post*` or install
  scripts.

## Recommendations for M1

1. **Keep SEC-01's fail-closed rule** until D8 is decided. If proxy support is added later, local
   providers must never use a proxy, whatever `NO_PROXY` says.
2. **Fix SEC-02** when the first real database is created, with a POSIX test, verified on the
   laptop.
3. **Provider adapters:** bodies only via `authorizeForProvider`, no data in URLs, the API key only
   in an `Authorization` header read via `SecretStore.require` (which registers it with the
   redactor).
4. **No tool** beyond an in-memory no-op until the M2 policy engine exists (ADR-006).
5. **Memory and conversation deletion:** SQLite keeps deleted content in free pages and the WAL. Use
   `PRAGMA secure_delete = ON` for tables that hold user content, and checkpoint after deletes (M4,
   but the schema decision starts in M1).
6. **Pin CI actions by SHA** (SEC-06).
