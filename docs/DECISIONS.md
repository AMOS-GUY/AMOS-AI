# Architecture decision log

Each entry: context → decision → consequences. Status: _proposed_ until the owner approves;
_adopted (M0)_ means it is implemented and the owner can still overturn it.

## ADR-001 Single local service (`amosd`) + thin clients — proposed

No microservices, broker or containers. One Node process owns state and side effects; web UI and CLI
are clients over localhost HTTP + SSE. Simpler to secure, deploy and debug on one laptop.

## ADR-002 TypeScript on Node 24 LTS; root package now, `web/` workspace in M1 — adopted (M0)

Matches the owner's preference, the MCP SDK and REA. _Revised during M0:_ the original "two
workspaces (`apps/server`, `apps/web`)" layout was replaced by "the repository root is the server
package; `web/` is added as an npm workspace in M1". With no UI yet, a workspace layout added
configuration without benefit, and this layout means no code moves when the UI arrives.

## ADR-003 SQLite via built-in `node:sqlite` — adopted (M0), with a caveat

Avoids native addons whose prebuilt binaries download from GitHub at install time.
_Verified on Windows / Node 24.18.0:_ SQLite 3.53.1 bundled, FTS5, JSON functions, STRICT tables,
WAL, read-only second connection, transactions, BigInt reads, Unicode (Chinese) paths — see
`src/storage/storage.test.ts`. No experimental warning is printed.
_Caveat:_ the Node 24 docs mark `node:sqlite` as Stability 1.2 (release candidate), so its API may
still change between Node releases. Mitigation: only `src/storage/` imports it, and the compatibility
tests run on every platform; if it breaks, `better-sqlite3` is the fallback (at the cost of a native
addon). Not yet verified on Linux.

## ADR-004 Static React + Vite UI, not Next.js — proposed

`amosd` is the backend; SSR isn't needed; static files deploy offline.

## ADR-005 OpenAI-compatible adapter first — proposed

Covers Qwen (Model Studio compatible mode), DeepSeek and Ollama with one adapter. Internal message
format stays vendor-neutral. Capabilities per model are config data (`src/core/provider.ts`).

## ADR-006 Policy enforced in code; model output is untrusted — proposed

See THREAT_MODEL.md. Non-negotiable.

## ADR-007 No Docker requirement; bubblewrap for Linux sandboxing — proposed

Docker needs a root-equivalent daemon and registry access. Revisit per skill if needed.

## ADR-008 Release tarball built on dev machine — proposed

Target network makes `npm install` unreliable. Zero native deps make one tarball portable.
_M0 evidence:_ production dependencies are two pure-JavaScript packages (`yaml`, `zod`, both with no
dependencies of their own); the built CLI runs after `npm ci --omit=dev`.

## ADR-009 TypeScript 7 with erasable-only syntax; Node runs `.ts` directly — adopted (M0)

`tsc` (7.0.2) type-checks and emits `dist/`; Node 24 strips types natively, so `node src/cli/main.ts`
and `node scripts/*.ts` run without a build step or a loader dependency (no tsx/ts-node).
Consequences: `erasableSyntaxOnly` forbids enums, namespaces and parameter properties (we use
`as const` unions instead), imports use `.ts` extensions (rewritten to `.js` on emit).
TypeScript 7 ships per-platform native binaries via npm optional dependencies — a dev-only concern,
since the release tarball contains compiled JS.

## ADR-010 Biome for lint + format; Vitest for tests — adopted (M0)

One dev dependency instead of ESLint + Prettier + plugins. `complexity/useLiteralKeys` is disabled
because it conflicts with TypeScript's `noPropertyAccessFromIndexSignature`, which we keep (it
makes reads of unknown keys visible as `obj["key"]`).

## ADR-011 Layered configuration: defaults < `config.yaml` < `AMOS_*` env; secrets separate — adopted (M0)

YAML because the owner edits it by hand and comments matter. Every object is strict (typos are
errors), duplicate keys are errors, and secret-looking keys are rejected with a pointer to
`secrets.env`. Only an explicit list of env vars is read. Secrets come from the environment or a
`secrets.env` file that must be owner-only on POSIX (refused otherwise, like ssh does).
Windows ACLs are not checked — a documented limitation of development on Windows.

## ADR-012 Privacy labels with a single egress gate — adopted (M0), revised (M0.1)

Four labels (`public` < `personal` < `local_only` < `secret`); the most restrictive wins.
_M0.1 revision:_ the M0 `checkEgress(label, destination, { destinationApproved })` API was removed.
It let any caller assert that a destination was approved, which is a bypass. It is replaced by
`decideEgress(label, recipient)` (pure) plus the `EgressGate`, whose provider policy comes only from
config (ADR-016, ADR-017).

## ADR-013 Minimum Node version = the version actually tested (24.18.0) — adopted (M0)

`import.meta.main` needs 24.2+, and `node:sqlite` is release candidate stability, so `engines`,
`amos doctor` and `.nvmrc` claim only what was run. Raise it when a newer version is tested (REA will
need ≥ 24.22.1 in M3).

## ADR-014 Connectivity probe sends no credentials — adopted (M0)

The probe uses unauthenticated GETs; any HTTP status (even 401) proves reachability. Listing models
with a real key was dropped from M0: it would require handling keys in a diagnostic script, and
reachability is the question M0 needs answered.

## ADR-015 Unclassified data is `local_only`; `public` is never a default — adopted (M0.1)

AMOS will handle private documents, source code and personal information. Treating anything
unclassified as shareable would make every forgotten label a leak, so the default is the most
restrictive label that still lets local work happen. Consequences:

- Until you label directories (`privacy.directories`) or opt in to `defaultLabel: personal`, nothing
  unclassified reaches a cloud provider.
- `public` is rejected as a default, with an explanatory error.
- Empty label sets are errors, and unknown labels fail closed.
- Lowering a label needs an explicit owner reclassification with a reason; `secret` can never be
  lowered.
- Duplicate directory entries are rejected, since order-dependent labels could be a silent
  downgrade.

How nested directories resolve (most specific vs most restrictive) is decided with the M2 path guard.

## ADR-016 Every provider must declare `privacy.allowPersonalData` — adopted (M0.1)

Implements M1_READINESS D2 option (a). There is no default: a missing or non-boolean value is a
config error, and the decision function only grants on `=== true`. `false` means public data only.
`local_only` data also needs `location: local`, which the schema already restricts to loopback URLs.
Known limit: a "local" endpoint that is itself a proxy to a cloud service cannot be detected.
Configuring it as `local` is the owner's responsibility (documented in the example config).

## ADR-017 One HTTP transport; bodies only via egress clearances — adopted (M0.1)

`src/net/http.ts` is the only module that calls `fetch` or imports networking modules;
`tests/boundaries.test.ts` fails otherwise. The transport:

- sends a request body only when it carries a genuine `EgressClearance` (a `WeakSet`-registered
  object holding the serialised body) for the same URL origin;
- refuses redirects, which could re-send a body elsewhere;
- allows only `GET` without a clearance.

The gate also refuses bodies containing registered secret values. Threat-model scope: mistakes and
injected instructions, not deliberately malicious AMOS code.

## ADR-018 Timeouts: headers / idle / total; no connect timeout — adopted (M0.1)

Node's built-in `fetch` (undici inside Node) has no public per-request connect timeout. Offering one
would need the `undici` package as a dependency (M1_READINESS D5 option a). Instead (option b),
`connectTimeoutMs` was removed, and a config that still uses it gets an explicit error. It is
replaced by three `AbortController`-based timeouts that the transport really enforces, each tested
against a loopback server:

- `headersTimeoutMs` — until response headers arrive; includes DNS, connect and TLS.
- `idleTimeoutMs` — longest silence between body chunks.
- `requestTimeoutMs` — the whole exchange.

Error codes: `NETWORK_TIMEOUT` (with `phase`), `NETWORK_CANCELLED`, `NETWORK_OFFLINE` and `NETWORK`.

## ADR-019 Private storage: the directory is the boundary — adopted (M0.1)

Sensitive files (database, logs, later backups) live in owner-owned `0700` directories. The
directory is what stops other users reading, creating or swapping files, and it also closes the race
between file creation and `chmod`. Files are kept `0600` as defence in depth.

- SQLite gives its `-wal`/`-shm`/`-journal` files the database file's mode.
- `temp_store = MEMORY` keeps temporary data out of `/tmp`.
- An existing directory open to others is **refused** rather than `chmod`-ed, because it may be a
  folder you chose.
- Symlinked data files are refused.
- Windows relies on profile ACLs, so these checks don't run there.
