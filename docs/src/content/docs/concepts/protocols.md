---
title: Scheduling protocols
description: Prompt-level rolling cohorts by default, with optional local Protocol 3 admission gates.
---

Naru uses Protocol 2 when the scheduler is off. Protocol 3 is selected only in `observe` or `enforce` mode. Both preserve scoped ownership and native Task dispatch. Automatic runs use a combined ten-child pool; a current explicit user request may raise it to fifty. Shared mode permits up to ten writers only when scheduler claims are pairwise disjoint and every writer acquires exact Weaver ownership before editing. Higher writer counts require clean isolated mode with one writer per Naru-owned worktree.

## Protocol 2: rolling cohorts

```mermaid
flowchart LR
  A["Capture immutable baselines"]:::gate
  B["Start independent writer"]:::write
  C{"Safe writer slot?"}:::gate
  D["Start another independent writer"]:::write
  E["Await terminal reports"]:::read
  F{"Contained and no drift?"}:::gate
  G["Freeze and drain cohort"]:::danger
  H["Writer-free candidate"]:::artifact

  A --> B --> C
  C -->|yes| D
  C -->|no| E
  D --> E
  E --> F
  F -->|yes| C
  F -->|no| G
  C --> H

  classDef read fill:#d3ece5,stroke:#2f8f78,color:#123a31
  classDef write fill:#ffe4bd,stroke:#b8760f,color:#4a2c00
  classDef gate fill:#e8eaf0,stroke:#8f96a5,color:#22252e
  classDef danger fill:#ffdcd6,stroke:#c0392b,color:#4a120c
  classDef artifact fill:#f5f6fa,stroke:#5f6675,color:#14161d
```

<ul class="naru-legend">
  <li data-kind="read">Read-only</li>
  <li data-kind="write">Writes files</li>
  <li data-kind="danger">Blocked</li>
</ul>

**Walkthrough:** Protocol 2 is a prompt-level compatibility workflow. Each writer receives immutable run and cohort baselines, an item dispatch observation, and active-peer claims. At most ten independent writers share the workspace when scheduler claims are pairwise disjoint and every writer acquires its exact Weaver claims before editing. A contained terminal report is provisional; uncertainty, overlap, or drift freezes refills and drains active work. Isolated worktree mutations remain root-orchestrator-only, use hook-suppressed tool-owned Git operations, serialize per run, update metadata atomically, and attempt rollback on integration failure; they are path-contained recovery tooling, not a general sandbox or protection from unrelated external workspace mutation.

## Protocol 3: admissions and quality gates

Admission is a request-and-response exchange, so it reads more clearly as a sequence than as a flow. The three branches below are the only three outcomes.

```mermaid
sequenceDiagram
  autonumber
  participant O as Orchestrator
  participant S as Local scheduler
  participant T as Native Task
  participant A as Artifacts

  O->>S: Declare DAG, revision, lane, target, claims
  S-->>O: Fresh admission token, one Task marker
  O->>S: Admission check

  alt Admitted
    S-->>O: Admitted
    O->>T: Run Task with the single marker
    T-->>A: Correlated terminal artifact
  else observe — fails open
    S-->>O: Record incident, permit anyway
    O->>T: Run Task with the single marker
    T-->>A: Correlated terminal artifact
  else enforce — fails closed
    S-->>O: Refuse admission
    Note over O,T: Task never runs — Protocol 2 is refused
  end

  A->>A: Quiescent candidate artifact
  A->>A: Verification shard artifacts
  A->>A: Judgment artifact
  Note over S,A: Correlation is not proof that reports are truthful<br/>or that Git state is unchanged
```

**Walkthrough:** Protocol 3 binds a fresh token to a declared work item, revision, lane, target, claims, and one Task marker. Artifacts correlate reports and the exact candidate. In `observe`, failed admission checks record incidents and fail open; in `enforce`, they fail closed and Protocol 2 is refused. Correlation is not proof that source reports are truthful or that Git state is unchanged.

## Candidate verification

```mermaid
flowchart LR
  A["All writers terminal"]:::gate

  subgraph gates["TWO GATES — either one blocks"]
    direction TB
    C{"Cohort delta<br/>contained?"}:::gate
    G{"Final state<br/>unchanged?"}:::gate
  end

  B["Capture writer-free candidate"]:::artifact
  D["Run Verify shards<br/>within run budgets"]:::read
  E["Complete shard manifest"]:::artifact
  F["Judge exact candidate"]:::read
  H["Permit serialized next phase"]:::gate
  X["Block and reconcile"]:::danger

  A --> B --> C
  C -->|no| X
  C -->|yes| D --> E --> F --> G
  G -->|no| X
  G -->|yes| H

  style gates fill:none,stroke:#8f96a5,stroke-dasharray:2 3,color:#8f96a5

  classDef read fill:#d3ece5,stroke:#2f8f78,color:#123a31
  classDef gate fill:#e8eaf0,stroke:#8f96a5,color:#22252e
  classDef danger fill:#ffdcd6,stroke:#c0392b,color:#4a120c
  classDef artifact fill:#f5f6fa,stroke:#5f6675,color:#14161d
```

<ul class="naru-legend">
  <li data-kind="read">Read-only</li>
  <li data-kind="danger">Blocked</li>
</ul>

**Walkthrough:** final verification starts only after writers drain. Verify shards cover the exact candidate and may share read-only source paths but not mutable runtime resources. A Judge receives the complete shard manifest, then the coordinator compares a final checkpoint to the judged candidate. Any later change invalidates the verification and judgment.

See [scheduler modes](/naru-opencode/runtime/scheduler-modes/) and [limitations](/naru-opencode/reference/limitations/) before relying on runtime gates.
