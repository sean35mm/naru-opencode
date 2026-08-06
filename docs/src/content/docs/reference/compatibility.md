---
title: Compatibility policy and evidence
description: The 0.1.0 release target, feature prerequisites, exclusions, and evidence boundary.
---

## Release target

The 0.1.0 compatibility policy sets both the OpenCode floor and current target to **1.18.4**. The initial platform targets are **macOS arm64** and **Ubuntu x64**, and **Node 24** is the runtime target for everything Naru ships.

**Bun 1.3.9** is a target for one thing only: the transport smoke test (`npm run test:bun`). Nothing else in Naru requires Bun, and the test skips itself when Bun is unavailable.

Naru's topology is one root orchestrator with depth-1 leaf subagents, so it needs `subagent_depth` of at least `1` — OpenCode's default.

Git is a prerequisite for the Git-backed tools (`naru-git-read`, `naru-worktree`). GitHub reading and review posting additionally require authenticated `gh`. No Git or `gh` version floor has been established; evidence may record the exact versions observed without turning them into support claims.

| Surface | Policy |
| --- | --- |
| Naru agents, tools, and skills | OpenCode 1.18.4 or later; Node 24; depth-1 topology |
| Transport smoke test | Bun 1.3.9; skipped when Bun is absent |
| Git-backed tools | `git` on `PATH`; no version floor |
| GitHub read and review posting | Authenticated `gh`; no version floor |
| Native Windows | Unsupported and unclaimed for 0.1.0 |
| WSL | Unsupported and unclaimed for 0.1.0 |

Compatibility checks are provider-free. They do not run a model command, inspect provider authentication, or call a provider.

## Runtime sources

Naru runs plain `.js` and `.mjs` directly. There is no TypeScript source tree, build step, runtime TypeScript loader, or bundler, so the files in the checkout are the files that execute. Runtime validators are part of the shipped code rather than a compile-time guarantee.

## What counts as evidence

The policy above is a release target, not a claim that the matrix has passed. `node tools/naru-doctor.js --json` reports local install and config health, and `scripts/naru-compat-smoke.mjs` records sanitized observations and bounded check outcomes. Both are local signals: they do **not** qualify the release.

Browser, native-Windows, WSL, curl-bootstrap, and package-registry-install surfaces remain excluded or unclaimed until separately evidenced.

Successful CI on macOS arm64 and Ubuntu x64 will establish the release matrix later. Until those runs exist, this page makes no matrix-success claim.
