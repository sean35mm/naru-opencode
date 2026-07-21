---
title: Runtime configuration
description: Configure bounded scheduler behavior with an explicit local JSON file.
---

Copy the installed example only when you intentionally want `observe` or `enforce` mode:

```sh
cp .opencode/naru-runtime.example.json .opencode/naru-runtime.json
```

```mermaid
flowchart TD
  A[naru-runtime.example.json] --> B[Copy to active config path]
  B --> C[Set scheduler.mode]
  C --> D[Validate regular JSON file]
  D --> E[Apply bounded scheduler config]
  E --> F[Restart OpenCode]
```

**Walkthrough:** the example is copied during installation but is not active. The runtime file must be regular, non-symlinked JSON no larger than 64 KiB. Use project-local configuration for the current workspace; changing global configuration needs explicit approval.

## Defaults

| Setting | Default | Bound |
| --- | --- | --- |
| `mode` | `off` | `off`, `observe`, `enforce` |
| `maxConcurrentWriters` | 2 | 1–10 |
| `maxConcurrentReadOnly` | 4 | 0–4 |
| `maxTotalChildren` | 6 | 1–14 |
| `maxJudgePasses` | 3 | 1–3 |
| `maxWorkItems` | 256 | 1–256 |
| `maxArtifactBytes` | 65,536 | 1,024–262,144 |
| token lifetimes | 5 minutes | 1 second–24 hours |

## Isolated implementation

| Setting | Default | Bound |
| --- | --- | --- |
| `implementation.workspaceMode` | `auto` | `auto`, `shared`, `worktree` |
| `implementation.maxConcurrentWriters` | 6 | 1–10 |
| `implementation.maxWritersPerWorktree` | 1 | exactly 1 |
| `implementation.cleanWorkspaceRequired` | `true` | exactly `true` |

`auto` uses one detached Naru-owned worktree per writer only for a clean Git repository. Dirty or unsupported repositories downgrade to the shared two-writer ceiling without prompting. The integration worktree is verified before the aggregate is applied back to the unchanged main workspace; Naru never pushes or leaves delivery commits through this mechanism. Local run metadata supports recovery after a process restart.

`enforce` requires `legacyProtocol2: "reject"`; `observe` may set it to `observe` for explicit Protocol 2 compatibility observation. See [scheduler modes](https://sean35mm.github.io/naru-opencode/runtime/scheduler-modes/) for behavior and [limitations](https://sean35mm.github.io/naru-opencode/reference/limitations/) for the enforcement boundary.
