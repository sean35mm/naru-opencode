---
title: Compatibility policy and evidence
description: The 0.1.0 release target, feature prerequisites, exclusions, and evidence boundary.
---

## Release target

The stable compatibility floor is OpenCode **1.18.4**. Builds **1.18.4** and **1.18.28** are tested history, and 1.18.28 is the current release target; that table is evidence, not a version allowlist. Any syntactically valid stable release at or above the floor—including a future stable major—may run the same bounded host-contract probe. An unlisted release remains a probe-required candidate until that current local probe passes, and a pass records only local-tested evidence rather than adding the release to tested history or qualifying a release matrix. Versions below the floor, malformed output, and stable-profile prereleases fail precisely. The initial platform targets are **macOS arm64** and **Ubuntu x64**, and **Node 24** is the runtime target for everything Naru ships.

The `overhaul/host-agnostic` branch has an isolated exploratory profile for exactly **0.0.0-beta-19425**. It runs only the bounded v2 commands confirmed for that build. Its evidence is marked exploratory and release-ineligible; OpenCode v2 is not stable upstream, and this does not claim full Naru parity. The beta-19271 and beta-19086 records remain historical evidence, not accepted current builds.

The dedicated transport test (`npm run test:bun`) requires **Bun 1.3.9** on `PATH`. The Node suite (`npm test`) may skip Bun-specific assertions when Bun is unavailable. Any explicitly requested optional dashboard/Bun compatibility mode also requires Bun.

Naru's topology is one root orchestrator with depth-1 leaf subagents, so it needs `subagent_depth` of at least `1` — OpenCode's default.

Git is a prerequisite for the Git-backed tools (`naru-git-read`, `naru-worktree`). GitHub reading and review posting additionally require authenticated `gh`. No Git or `gh` version floor has been established; evidence may record the exact versions observed without turning them into support claims.

| Surface | Policy |
| --- | --- |
| Naru agents, tools, and skills | Stable profile: OpenCode >= 1.18.4 after the current bounded host-contract probe; 1.18.4 and 1.18.28 are tested history; Node 24; depth-1 topology |
| OpenCode v2 exploration | Exact beta 0.0.0-beta-19425 only; isolated, bounded, and never release-qualifying |
| Transport smoke test | The Node suite skips Bun-specific assertions; `npm run test:bun` requires Bun 1.3.9 |
| Git-backed tools | `git` on `PATH`; no version floor |
| GitHub read and review posting | Authenticated `gh`; no version floor |
| Native Windows | Unsupported and unclaimed for 0.1.0 |
| WSL | Unsupported and unclaimed for 0.1.0 |

Compatibility checks use no external provider, credentials, or account. The stable host-contract probe routes a synthetic model response through a loopback-only fixture so OpenCode's real tool scheduler evaluates the resulting permission request.

## Runtime sources

Naru's authoritative runtime and test sources are `.ts` and `.mts`. `npm run build` type-checks and emits the installed `.js` and `.mjs` runtime names into `.naru-build/`; installs and tests execute that clean output without a runtime TypeScript loader or bundler. Runtime validators remain authoritative at external boundaries rather than relying on compile-time guarantees.

## What counts as evidence

The policy above is a release target, not a claim that the matrix has passed. `naru doctor` runs the bounded host-contract probe for the detected stable OpenCode; direct internal doctor invocation remains static so the compatibility smoke can inspect it without recursively starting another smoke. The compatibility smoke requires an explicit `stable` or `v2-beta-exploratory` profile and records sanitized observations and bounded check outcomes. Version history, a current local probe, and release-matrix qualification are separate evidence: local success does **not** qualify the release, and exploratory evidence is explicitly ineligible. The MCP contract check exercises OpenCode's actual scheduler with a loopback synthetic provider, verifies that expected asks remain pending and expected denies become rejected tool parts, and confirms that the synthetic MCP tool never executes. It does not approve a request or contact a real provider.

Browser, native-Windows, WSL, curl-bootstrap, and package-registry-install surfaces remain excluded or unclaimed until separately evidenced.

Successful CI on macOS arm64 and Ubuntu x64 will establish the release matrix later. Until those runs exist, this page makes no matrix-success claim.
