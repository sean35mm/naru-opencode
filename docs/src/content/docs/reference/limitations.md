---
title: Limitations and trust boundaries
description: What Naru's prompts, scheduler, and dashboard do not guarantee.
---

Naru improves workflow discipline; it is not a sandbox or a proof system. Treat user input, repository files, issues, PRs, logs, diffs, comments, and agent reports as untrusted data.

```mermaid
flowchart LR
  U[Untrusted user and repository data] --> P[Prompt-level rules]
  P --> O[Orchestrator decisions]
  O --> N[Native Task and permissions]
  O --> S[Optional local scheduler]
  S --> L[Declared admission checks only]
  N --> W[Scoped workspace work]
  L -. does not prove .-> W
```

**Walkthrough:** OpenCode native Task remains responsible for permission evaluation, retries, cancellation, background work, and child sessions. Prompt-level rules retain authorization, baseline, Weaver, scope-containment, freshness, and final-state responsibilities. The scheduler validates declarations and correlations; it does not make untrusted content authoritative.

## Important non-guarantees

- No cross-process coordination, durable state, authoritative background completion, or provider/global hard caps.
- No session creation, automatic Task worktree binding, Git inspection, baseline capture, or report-truth proof.
- No sandboxing of repository code, package scripts, shell commands, tools, providers, or installed plugins.
- No automatic authorization for edits, dependency changes, Git mutation, migrations, database writes, posting, or deployment.
- No guarantee that dashboard telemetry exists outside the same process or represents a global system state.

Use Protocol 3 as a bounded runtime check in addition to—not instead of—the [Protocol 2 workflow](https://sean35mm.github.io/naru-opencode/concepts/protocols/), review, and human approval boundaries.
