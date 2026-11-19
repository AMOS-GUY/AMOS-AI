# AMOS AI — Development status

_Last updated: 2026-11-20_

## Current phase

**Architecture proposal — awaiting owner approval.** No code has been written. M0 starts after approval.

| Milestone              | State                      |
| ---------------------- | -------------------------- |
| Architecture & plans   | Drafted, awaiting approval |
| M0 Foundation          | Not started                |
| M1 Core agent          | Not started                |
| M2 Tool execution      | Not started                |
| M2.5 Laptop checkpoint | Not started                |
| M3 Skills & MCP        | Not started                |
| M4 Knowledge           | Not started                |
| M5 Remote              | Not started                |
| M6 Reliability         | Not started                |

## Environment findings (dev machine, checked 2026-11-20)

| Item              | Finding                                      | Consequence                                                                                   |
| ----------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| OS                | Windows 11 Pro                               | —                                                                                             |
| WSL2              | **Not installed**                            | Owner decides whether to install Ubuntu 24.04; until then Linux checks run in GitHub Actions. |
| Node.js           | v24.18.0                                     | Fine for AMOS; below REA's minimum (24.22.1) — upgrade before M3.                             |
| npm               | 11.16.0                                      | Use npm workspaces.                                                                           |
| pnpm              | not installed                                | Not needed.                                                                                   |
| Python            | 3.14.7                                       | Mint ships an older Python; workers must target the laptop's version.                         |
| git               | 2.55.0                                       | —                                                                                             |
| GitHub CLI (`gh`) | not installed                                | PRs opened via the web UI unless the owner installs it.                                       |
| Repository        | `AMOS-GUY/AMOS-AI` exists, **public**, empty | No secrets or personal data may be committed.                                                 |

## Target laptop (not yet inspected)

To record during M0: Mint version, kernel, CPU model, free disk, Python version, whether bubblewrap
works unprivileged, and the connectivity probe results.

## Open decisions for the owner

1. Approve / amend the architecture and roadmap.
2. Which model provider accounts exist or can be created (Alibaba Cloud Model Studio, DeepSeek, other)?
3. Install WSL2 now, or develop on Windows + CI until later?
4. Is the public repository intended, or should it be private (it limits what can go in docs)?

## Verified results log

_None yet._ Each entry will state what was run, where (Windows / CI / laptop), and the outcome.

## Known limitations

- All provider endpoint/feature details in the architecture are from documentation and memory; none
  are verified from the target network yet.
