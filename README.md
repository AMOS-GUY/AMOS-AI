# AMOS AI

A personal, local-first, tool-using AI workstation agent. Primary target: Linux Mint; portable to
macOS and Windows.

**Status:** M0 (development foundation) implemented. There is **no AI agent yet** — the code today
is configuration, logging, core types, storage and environment tooling. See
[docs/STATUS.md](docs/STATUS.md).

- [Architecture](docs/ARCHITECTURE.md) · [Roadmap & acceptance criteria](docs/ROADMAP.md) ·
  [Security & threat model](docs/THREAT_MODEL.md) · [Decision log](docs/DECISIONS.md)

> This repository is public. Never commit API keys, personal configuration, notes or runtime data.
> `npm run check` includes a secret scan.

## Requirements

- **Node.js 24.18 or newer (24 LTS line).** npm comes with it. Nothing else is required to develop.
- Optional: git (used by later milestones), Python 3 (document workers, M4), bubblewrap on Linux
  (command sandboxing, M2).

## Setup

### Windows (current development machine)

```bash
git clone https://github.com/AMOS-GUY/AMOS-AI.git
cd AMOS-AI
npm ci
npm run check
```

### WSL2 (recommended for Linux-like development)

Install Ubuntu 24.04 in WSL2 (`wsl --install -d Ubuntu-24.04`, needs admin rights). Keep the repo
inside the Linux filesystem (`~/src/AMOS-AI`), not under `/mnt/c` or `/mnt/e` — it is much faster and
file permissions behave like Linux. Install Node with nvm or the official tarball, then run the same
commands as above.

### Linux Mint (target laptop)

Mint's apt Node.js is too old. Install the official Node 24 binary for your user, no root needed:

```bash
# 1. Download node-v24.X.Y-linux-x64.tar.xz from nodejs.org (or a mirror you trust)
#    and check it against the published SHASUMS256.txt.
# 2. Unpack it into your home directory:
mkdir -p ~/.local/opt
tar -xJf node-v24.X.Y-linux-x64.tar.xz -C ~/.local/opt
# 3. Add it to PATH (replace X.Y with the version you downloaded), then open a new terminal:
echo 'export PATH="$HOME/.local/opt/node-v24.X.Y-linux-x64/bin:$PATH"' >> ~/.bashrc
```

If the npm registry is slow, `npm ci --registry=https://registry.npmmirror.com` uses a mirror.
Later milestones ship a self-contained release tarball so the laptop never needs npm
(ARCHITECTURE §12).

## Commands

| Command                       | What it does                                                             |
| ----------------------------- | ------------------------------------------------------------------------ |
| `npm run check`               | typecheck + lint + tests + secret scan + build (run before every commit) |
| `npm test`                    | tests only (`npm run test:watch` to watch)                               |
| `npm run format`              | apply Biome formatting and safe fixes                                    |
| `npm run doctor`              | `amos doctor`: read-only environment check, no network                   |
| `npm run amos -- paths`       | where AMOS keeps config, data and logs on this OS                        |
| `npm run amos -- config show` | effective configuration (secret values never printed)                    |
| `npm run probe`               | network reachability report — **run this on the laptop**                 |

## Configuration

AMOS works with no configuration. To customise, copy
[config/config.example.yaml](config/config.example.yaml) to the config directory shown by
`amos paths` as `config.yaml`. API keys go in `secrets.env` in the same directory (see
[config/secrets.env.example](config/secrets.env.example)); on Linux/macOS it must be `chmod 600`.
Environment variables `AMOS_LOG_LEVEL`, `AMOS_LOG_FILE`, `AMOS_OFFLINE`, `AMOS_PORT` override settings
for one run; `AMOS_CONFIG_DIR`, `AMOS_DATA_DIR`, `AMOS_STATE_DIR` relocate the directories.

## Troubleshooting

- `error [CONFIG_INVALID]` — the message lists each bad setting by path (e.g. `server.host`).
  Unknown keys are rejected on purpose, so check spelling.
- `error [SECRET_FILE_INSECURE]` — run the `chmod 600 …` command the hint prints.
- `amos doctor` prints `FAIL` lines with the reason; it never changes anything.
- Logs: JSON lines in the log directory from `amos paths` (`amos.log`, rotated at 5 MiB).
