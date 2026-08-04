---
title: OpenCode v2 migration plan
description: Evidence boundary, ownership split, triggers, and staged plan for a future OpenCode v2 migration.
---

> **Research snapshot: August 4, 2026.** This plan is pinned to the OpenCode `v2` branch at [`28d784b`](https://github.com/anomalyco/opencode/tree/28d784b83a413c5d4c306de7ba1a229462e40a6b). The `2.0` branch at [`7a6ce05`](https://github.com/anomalyco/opencode/tree/7a6ce05d0939826aa6c8e1c481489a713b2d633f) is older exploration, while `beta` at [`f1e517e`](https://github.com/anomalyco/opencode/tree/f1e517e0b513a22ad389f8bbfc4d324b5fb5d63d) is a separate generated release lane. All findings below are provisional until revalidated against a released public API. This page does not claim v2 compatibility or predict a general-availability date.

## Architectural boundary

**OpenCode owns execution; Naru owns orchestration policy and confidence.**

OpenCode should own foreground and background execution, sessions, project copies, permissions, cancellation, and plugin/client transport. Naru should own adaptive routing and decomposition, bounded scheduling policy, ownership and claims, exact-candidate verification, an independent Judge, and remediation and delivery gates.

This split keeps Naru from duplicating platform infrastructure while preserving the policy that makes a run inspectable and trustworthy.

## Current v2 substrate and gaps

The pinned v2 source already provides useful migration targets:

- foreground and background subagents backed by child sessions;
- agent-level model configuration;
- durable session inputs and managed restart continuity;
- typed Effect and Promise plugin and client APIs; and
- a Git-backed project-copy worktree primitive.

These capabilities are not yet a complete Naru runtime:

- the Job registry is intentionally process-local;
- parent/child subagent completion across restart remains unresolved;
- no durable workflow or DAG scheduler has merged into v2;
- the current subagent tool has no resume argument;
- parent permission inheritance is incomplete; and
- APIs are still moving.

## Build now

Keep Naru's policy runtime-neutral. Use a Codex-Ultra-style adaptive coordinator as the behavioral reference: issue tight packets, refill a rolling cohort, prioritize relevant evidence, stop early when confidence is sufficient, and preserve the limits of **10 automatic children** and **50 only when explicitly requested**. Writer ownership, Verify, and an independent Judge remain required.

Borrow the useful parts of Claude-style dynamic workflows—explicit IDs, dependencies, status summaries, and an inspectable run shape—without creating an executable workflow DSL. Protocol and agent identifiers remain compatibility contracts rather than v2 implementation details.

## Avoid now

Do not build:

- a separate background job or session store;
- a Naru workflow DSL or TUI;
- broad Protocol 3 expansion into a durable runtime;
- deeper coupling to the v1 Task implementation; or
- another low-level worktree implementation.

Each would duplicate likely platform ownership or lock policy to a volatile API before release evidence exists.

## Migration triggers and stages

Start implementation only after OpenCode publishes a stable v2 release and public API. Then proceed in reversible stages:

1. **Freeze evidence.** Pin the released version and add exact compatibility fixtures for the public surfaces Naru uses.
2. **Add a thin adapter.** Map Naru policy onto v2 subagent, session, plugin/client, and project-copy capabilities without changing orchestration semantics.
3. **Prove behavioral parity.** Re-run cancellation, restart, permissions, model routing, ownership, verification, and provider-free smoke checks against an unchanged candidate.
4. **Migrate project isolation last.** Replace Naru's current worktree safety only after project-copy containment and integration are at least equivalent and rollback has been exercised.
5. **Evaluate native workflows conditionally.** Adopt a native workflow or DAG engine only if one merges and satisfies Naru's dependency, bounded-concurrency, observability, restart, and confidence requirements. Do not design around an open proposal.
6. **Retain fallback.** Keep the current adapter and rollback path until the v2 path passes the supported matrix and release-day checks.

## Upstream watchlist

Merged code and the pinned branch are stronger evidence than open proposals. Recheck status and source at migration time.

| Upstream item | Snapshot status | Why it matters |
| --- | --- | --- |
| [`v2` branch](https://github.com/anomalyco/opencode/tree/v2) | Current source under evaluation | Authoritative implementation surface for this research snapshot |
| [PR #36530](https://github.com/anomalyco/opencode/pull/36530) | Merged | Background completion UI |
| [Issue #36349](https://github.com/anomalyco/opencode/issues/36349) | Open issue | Restart-safe parent completion |
| [PR #40327](https://github.com/anomalyco/opencode/pull/40327) | Open proposal | Session HTTP middleware |
| [PR #35935](https://github.com/anomalyco/opencode/pull/35935) | Open proposal | Tracing |
| [PR #34947](https://github.com/anomalyco/opencode/pull/34947) | Open proposal | Dispatch controls |
| [PR #29789](https://github.com/anomalyco/opencode/pull/29789) | Open proposal | Dynamic workflows |
| [PR #38954](https://github.com/anomalyco/opencode/pull/38954) | Open proposal | Child cap |
| [Issue #34359](https://github.com/anomalyco/opencode/issues/34359) | Open issue | Client and TUI migration |

An open item is a design signal, not a compatibility promise. If its status changes, inspect the merged implementation rather than relying on the proposal text.

## Release-day revalidation

Before claiming compatibility:

- [ ] Pin the released OpenCode version, public API, and relevant source revisions.
- [ ] Run exact compatibility fixtures without provider credentials or model calls.
- [ ] Verify foreground and background cancellation reaches child work and reports a terminal state.
- [ ] Restart during active child work and confirm parent completion, session continuity, and duplicate prevention.
- [ ] Confirm parent-to-child permission inheritance and denial behavior.
- [ ] Confirm per-agent model routing, overrides, and unavailable-model failures.
- [ ] Validate project-copy path containment, ownership, integration, cleanup, and rollback against an unchanged base.
- [ ] Confirm Verify and Judge inspect the exact candidate after all writers and remediation have stopped.
- [ ] Exercise fallback to the prior runtime adapter without changing public agent or protocol identifiers.
- [ ] Recheck every watchlist item and remove assumptions that did not merge.
