---
title: Scheduling protocols
description: Prompt-level rolling cohorts by default, with optional local Protocol 3 admission gates.
---

Naru uses Protocol 2 when the scheduler is off. Protocol 3 is selected only in `observe` or `enforce` mode. Both preserve scoped ownership and native Task dispatch. Automatic runs use a combined ten-child pool; a current explicit user request may raise it to fifty. Shared mode permits up to ten writers only when scheduler claims are pairwise disjoint and every writer acquires exact Weaver ownership before editing. Higher writer counts require clean isolated mode with one writer per Naru-owned worktree.

## Protocol 2: rolling cohorts

```mermaid
flowchart LR
  A[Capture immutable baselines] --> B[Start independent writer]
  B --> C{Safe writer slot?}
  C -->|yes| D[Start another independent writer]
  C -->|no| E[Await terminal reports]
  D --> E
  E --> F{Contained and no drift?}
  F -->|yes| C
  F -->|no| G[Freeze and drain cohort]
  C --> H[Writer-free candidate]
```

**Walkthrough:** Protocol 2 is a prompt-level compatibility workflow. Each writer receives immutable run and cohort baselines, an item dispatch observation, and active-peer claims. At most ten independent writers share the workspace when scheduler claims are pairwise disjoint and every writer acquires its exact Weaver claims before editing. A contained terminal report is provisional; uncertainty, overlap, or drift freezes refills and drains active work. Isolated worktree mutations remain root-orchestrator-only, use hook-suppressed tool-owned Git operations, serialize per run, update metadata atomically, and attempt rollback on integration failure; they are path-contained recovery tooling, not a general sandbox or protection from unrelated external workspace mutation.

## Protocol 3: admissions and quality gates

```mermaid
flowchart TD
  A[Declare DAG and revision] --> B[Request admission token]
  B --> C[Task with one marker]
  C --> D{Observe or enforce check}
  D -->|admitted| E[Append correlated terminal artifact]
  D -->|observe incident| E
  D -->|enforce refusal| X[Do not run Task]
  E --> F[Quiescent candidate artifact]
  F --> G[Verification shard artifacts]
  G --> H[Judgment artifact]
  H --> I[Verification, judgment, completion gates]
```

**Walkthrough:** Protocol 3 binds a fresh token to a declared work item, revision, lane, target, claims, and one Task marker. Artifacts correlate reports and the exact candidate. In `observe`, failed admission checks record incidents and fail open; in `enforce`, they fail closed and Protocol 2 is refused. Correlation is not proof that source reports are truthful or that Git state is unchanged.

## Candidate verification

```mermaid
flowchart LR
  A[All writers terminal] --> B[Capture writer-free candidate]
  B --> C{Cohort delta contained?}
  C -->|no| X[Block and reconcile]
  C -->|yes| D[Run Verify shards within run budgets]
  D --> E[Complete shard manifest]
  E --> F[Judge exact candidate]
  F --> G{Final state unchanged?}
  G -->|no| X
  G -->|yes| H[Permit serialized next phase]
```

**Walkthrough:** final verification starts only after writers drain. Verify shards cover the exact candidate and may share read-only source paths but not mutable runtime resources. A Judge receives the complete shard manifest, then the coordinator compares a final checkpoint to the judged candidate. Any later change invalidates the verification and judgment.

See [scheduler modes](https://sean35mm.github.io/naru-opencode/runtime/scheduler-modes/) and [limitations](https://sean35mm.github.io/naru-opencode/reference/limitations/) before relying on runtime gates.
