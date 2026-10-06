---
title: Compatibility
description: Supported OpenCode, Node, and platform targets, and what the compatibility evidence does and does not show.
---

| Surface | Policy |
| --- | --- |
| OpenCode | 2.0.15 is the tested build. Install and doctor also accept later 2.0.x patch releases (`>= 2.0.15, < 2.1`) as candidates; prereleases and other versions are refused. |
| Node | 24 |
| Platforms | macOS arm64 and Ubuntu x64 |
| Git-backed tools | `git` on `PATH`; no version floor |
| GitHub reads and review posting | Authenticated `gh`; no version floor |
| Bun transport test | `npm run test:bun` needs Bun 1.3.9; the Node suite skips Bun-specific assertions without it |
| Native Windows, WSL | Unsupported and unclaimed |

OpenCode 1.x is not supported. Naru 0.9.0 was the last release with the v1 installer.

The version check at install time is a prerequisite, not a runtime test and not evidence that your provider or account works.

## Compatibility smoke

From a built checkout, against a separately installed OpenCode 2.0.15:

```sh
npm run build
node .naru-build/scripts/naru-compat-smoke.mjs \
  --profile native-v2 --opencode /absolute/path/to/opencode \
  --source .naru-build --json
```

The smoke requires exactly 2.0.15. In a disposable private HOME and XDG tree it dry-runs and applies the install, sets a synthetic worker, runs `naru doctor`, and starts a private OpenCode server with a synthetic model source to confirm the config, agents, plugin, skills, and `/naru` command are registered. It uses no external provider, credentials, or account.

The capability smoke (macOS only, loopback-only network sandbox) goes further: it loads the plugin in a real 2.0.15 host and exercises the four tools, per-session working directory, skill loading, the managed command, and the strict posting tool's rejection of worker callers. That caller check is separate from workers' allow-all shell permissions:

```sh
node .naru-build/scripts/naru-native-capabilities-smoke.mjs /absolute/path/to/opencode
```

CI runs the compatibility smoke on Ubuntu x64 and both smokes on macOS arm64 against pinned, integrity-checked 2.0.15 binaries. The release workflow runs the compatibility smoke on both platforms against the exact release archive before publishing. Passing either smoke shows the package installs and registers on that host; it does not show that a real model performs well or that a given account has access.

## Runtime sources

Runtime and test sources are `.ts` and `.mts`. `npm run build` type-checks and emits `.js` and `.mjs` into `.naru-build/`; installs, tests, and release archives run that output with no TypeScript loader. Runtime validators stay authoritative at external boundaries.
