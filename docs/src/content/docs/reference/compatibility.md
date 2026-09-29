---
title: Compatibility policy and evidence
description: Native-v2 prerequisite, historical v1 policy, platform targets, and qualification evidence.
---

## Normal native-v2 prerequisite

Normal `naru install` requires the observed **exact OpenCode 2.0.15** on `PATH` and Node 24. It installs a native Naru package and profile into `~/.config/opencode` or an explicitly selected `--dir PATH`; it does not install the host binary, configure a provider, or start a broker. The exact-version check is not a passed runtime test or evidence of provider entitlement. The normal doctor inspects local package integrity, native registration and managed agents without invoking a live session. A healthy static report does not qualify the release.

From a built source checkout, run the normal packaged qualification against a separately installed exact 2.0.15 executable:

```sh
node .naru-build/scripts/naru-compat-smoke.mjs \
  --profile native-v2 --opencode /absolute/path/to/opencode-2.0.15 \
  --source .naru-build
```

This bounded, provider-free local gate previews and applies the **normal** install in a disposable private HOME/XDG environment, checks doctor and package/agent/plugin registration, and starts a private host with a synthetic model source to inspect native config, agents, plugin, skills, and command routes. It does not test a real account, prove entitlement, exercise every capability, or itself establish a completed macOS arm64 / Ubuntu x64 release matrix. CI has not yet run the normal native-v2 qualification on all targets; do not infer success from the command's existence. Do not emit live config or secrets for diagnostics.

## Historical v1 release target (`--legacy`)

The historical v1 stable compatibility floor is OpenCode **1.18.4**. Builds **1.18.4** and **1.18.28** are tested history, and 1.18.28 is the v1 release target; that table is evidence, not a version allowlist. Any syntactically valid stable release at or above the floor—including a future stable major—may run the same bounded v1 host-contract probe. An unlisted release remains a probe-required candidate until that current local probe passes, and a pass records only local-tested evidence rather than adding the release to tested history or qualifying a release matrix. Versions below the floor, malformed output, and stable-profile prereleases fail precisely. The initial platform targets are **macOS arm64** and **Ubuntu x64**, and **Node 24** is the runtime target.

The dedicated transport test (`npm run test:bun`) requires **Bun 1.3.9** on `PATH`. The Node suite (`npm test`) may skip Bun-specific assertions when Bun is unavailable. Any explicitly requested optional dashboard/Bun compatibility mode also requires Bun.

Naru's topology is one root orchestrator with depth-1 leaf subagents, so it needs `subagent_depth` of at least `1` — OpenCode's default.

Git is a prerequisite for the Git-backed tools (`naru-git-read`, `naru-worktree`). GitHub reading and review posting additionally require authenticated `gh`. No Git or `gh` version floor has been established; evidence may record the exact versions observed without turning them into support claims.

| Surface | Policy |
| --- | --- |
| Normal native Naru | Exact upstream stable 2.0.15 on `PATH`; Node 24; packaged `native-v2` gate, with release matrix not yet established |
| Historical v1 agents, tools, and skills | Explicit `--legacy`: OpenCode >= 1.18.4 after the current bounded host-contract probe; 1.18.4 and 1.18.28 are tested history; Node 24; depth-1 topology |
| Transport smoke test | The Node suite skips Bun-specific assertions; `npm run test:bun` requires Bun 1.3.9 |
| Git-backed tools | `git` on `PATH`; no version floor |
| GitHub read and review posting | Authenticated `gh`; no version floor |
| Native Windows | Unsupported and unclaimed for 0.1.0 |
| WSL | Unsupported and unclaimed for 0.1.0 |

Compatibility checks use no external provider, credentials, or account. The historical v1 stable host-contract probe routes a synthetic model response through a loopback-only fixture so OpenCode's real tool scheduler evaluates the resulting permission request.

## Runtime sources

Naru's authoritative runtime and test sources are `.ts` and `.mts`. `npm run build` type-checks and emits the installed `.js` and `.mjs` runtime names into `.naru-build/`; installs and tests execute that clean output without a runtime TypeScript loader or bundler. Runtime validators remain authoritative at external boundaries rather than relying on compile-time guarantees.

## What counts as evidence

The policy above is a target, not a claim that the matrix has passed. Normal `naru doctor` is static and selects `native-v2`; `naru doctor --legacy` runs the bounded v1 host-contract probe for detected stable OpenCode when the installed CLI supplies its source. The compatibility smoke requires an explicit `native-v2` or `stable` profile; `stable` is the historical v1 check, not the normal install. Version history, a current local probe, and release-matrix qualification are separate evidence: local success does **not** qualify the release. The v1 MCP contract check exercises OpenCode's actual scheduler with a loopback synthetic provider, verifies that expected asks remain pending and expected denies become rejected tool parts, and confirms that the synthetic MCP tool never executes. It does not approve a request or contact a real provider.

Browser, native-Windows, WSL, curl-bootstrap, and package-registry-install surfaces remain excluded or unclaimed until separately evidenced.

Successful CI on macOS arm64 and Ubuntu x64 will establish the release matrix later. Until those runs exist, this page makes no matrix-success claim.
