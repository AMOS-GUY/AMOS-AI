# Architecture decision log

Each entry: context → decision → consequences. Status: *proposed* until the owner approves.

## ADR-001 Single local service (`amosd`) + thin clients — proposed
No microservices, broker or containers. One Node process owns state and side effects; web UI and CLI
are clients over localhost HTTP + SSE. Simpler to secure, deploy and debug on one laptop.

## ADR-002 TypeScript on Node 24 LTS, npm workspaces — proposed
Matches the owner's preference, MCP SDK and REA. Two workspaces (`apps/server`, `apps/web`) to start.

## ADR-003 SQLite via built-in `node:sqlite` — proposed
Avoids native addons whose prebuilt binaries download from GitHub at install time. Accessed only
through a repository layer so it can be swapped for `better-sqlite3` if the built-in module proves
inadequate. To verify in M0: API stability on the pinned Node version and FTS5 availability.

## ADR-004 Static React + Vite UI, not Next.js — proposed
`amosd` is the backend; SSR isn't needed; static files deploy offline.

## ADR-005 OpenAI-compatible adapter first — proposed
Covers Qwen (Model Studio compatible mode), DeepSeek and Ollama with one adapter. Internal message
format stays vendor-neutral.

## ADR-006 Policy enforced in code; model output is untrusted — proposed
See THREAT_MODEL.md. Non-negotiable.

## ADR-007 No Docker requirement; bubblewrap for Linux sandboxing — proposed
Docker needs a root-equivalent daemon and registry access. Revisit per skill if needed.

## ADR-008 Release tarball built on dev machine — proposed
Target network makes `npm install` unreliable. Zero native deps make one tarball portable.
