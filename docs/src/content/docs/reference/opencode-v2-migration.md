---
title: OpenCode v2 migration plan
description: What Naru must carry across to OpenCode v2, and what it no longer has to.
---

> **Research snapshot: August 4, 2026**, pinned to the OpenCode `v2` branch at [`28d784b`](https://github.com/anomalyco/opencode/tree/28d784b83a413c5d4c306de7ba1a229462e40a6b). Provisional until revalidated against a released public API. This page does not claim v2 compatibility or predict a release date.

## The migration got much smaller

Naru's v-next simplification deleted most of what would have needed migrating.
The Protocol 3 scheduler was coupled to the v1 `task` tool's
`tool.execute.before` hook via an admission marker smuggled through the Task
description. The delegate plugin mutated OpenCode's live agent config to inject
hidden model aliases. The dashboard was a bespoke TUI plugin. All three were the
deepest v1 couplings Naru had, and all three are gone.

What remains to migrate:

- **Agent definitions** — already plain OpenCode agent markdown with permission
  frontmatter and static `model:` fields. v2's agent-level model configuration is
  what these already assume, so this should be close to a no-op.
- **Five custom tools** — `naru-git-read`, `naru-github-read`,
  `naru-github-post-review`, `naru-worktree`, plus `naru-doctor`. These depend on
  the custom-tool calling convention and its input-schema validation.
- **One worktree adapter** — the only component with real platform overlap.

There are no plugins left, so the plugin API surface no longer matters to Naru.

## Architectural boundary

**OpenCode owns execution; Naru owns policy.**

OpenCode owns sessions, subagent execution, cancellation, permission evaluation,
project copies, and transport. Naru owns which walls exist and where: who may
edit, what needs a checkpoint, and what evidence completion requires.

The lesson from the v-next simplification is that this boundary was previously
drawn in the wrong place. Naru had reimplemented scheduling, admission control,
and telemetry — all of it process-local, non-durable, and off by default. Do not
rebuild any of that against v2.

## Build now

Keep policy in prompts and enforcement in permissions. The orchestrator decides
fan-out at reasoning time; there is no scheduler, no mode matrix, and no
child-count contract to preserve across the migration. The only durable runtime
settings are `implementation.workspaceMode` and a `maxConcurrentWriters` brake.

## Avoid now

Do not build a background job or session store, a workflow DSL or TUI, a durable
scheduler, another low-level worktree implementation, or any new coupling to the
v1 `task` tool internals. Each duplicates likely platform ownership or re-creates
what was just removed.

## Current v2 substrate and gaps

The pinned v2 source already provides foreground and background subagents backed
by child sessions, agent-level model configuration, durable session inputs with
managed restart continuity, typed Effect and Promise plugin/client APIs, and a
Git-backed project-copy worktree primitive.

Open gaps: the Job registry is intentionally process-local; parent/child subagent
completion across restart is unresolved; no durable workflow or DAG scheduler has
merged; the subagent tool has no resume argument; parent permission inheritance is
incomplete; and APIs are still moving.

Only the last two matter to Naru now. **Permission inheritance is the critical
one** — Naru's entire safety model rests on the permission frontmatter being
enforced, especially that only `naru-writer` holds `edit`. Verify that first.

## Migration triggers and stages

Start only after OpenCode publishes a stable v2 release and public API. Then, in
reversible stages:

1. **Freeze evidence.** Pin the released version and add compatibility fixtures
   for the public surfaces Naru uses.
2. **Verify permissions first.** Confirm parent-to-child permission inheritance
   and denial behavior, and that a non-writer agent genuinely cannot edit. If this
   does not hold, stop — nothing else is worth migrating until it does.
3. **Port the custom tools.** Map the five tools onto the v2 tool convention,
   preserving input validation and the comment-only posting constraint.
4. **Confirm agent routing.** Per-agent model selection, overrides, and
   unavailable-model failures, using the static `model:` frontmatter.
5. **Migrate worktrees last.** Replace `naru-worktree` with the native
   project-copy primitive only once containment, integration, and rollback are at
   least equivalent.
6. **Retain fallback** until the v2 path passes the supported matrix.

## Upstream watchlist

Merged code beats open proposals. Recheck at migration time.

| Upstream item | Snapshot status | Still relevant? |
| --- | --- | --- |
| [`v2` branch](https://github.com/anomalyco/opencode/tree/v2) | Source under evaluation | Yes — authoritative surface |
| [Issue #36349](https://github.com/anomalyco/opencode/issues/36349) | Open issue | Yes — restart-safe parent completion |
| [PR #36530](https://github.com/anomalyco/opencode/pull/36530) | Merged | Yes — background completion UI |
| [PR #34947](https://github.com/anomalyco/opencode/pull/34947) | Open proposal | Yes — dispatch controls |
| [PR #38954](https://github.com/anomalyco/opencode/pull/38954) | Open proposal | Yes — child cap |
| [PR #29789](https://github.com/anomalyco/opencode/pull/29789) | Open proposal | No — Naru no longer has a workflow engine to reconcile |
| [PR #40327](https://github.com/anomalyco/opencode/pull/40327) | Open proposal | No — no plugins remain |
| [PR #35935](https://github.com/anomalyco/opencode/pull/35935) | Open proposal | No — no telemetry surface remains |
| [Issue #34359](https://github.com/anomalyco/opencode/issues/34359) | Open issue | No — no TUI surface remains |

## Release-day revalidation

- [ ] Pin the released version, public API, and source revisions.
- [ ] Run compatibility fixtures without provider credentials.
- [ ] **Confirm only `naru-writer` can edit, and that read-only agents cannot shell out.**
- [ ] Confirm parent-to-child permission inheritance and denial behavior.
- [ ] Confirm per-agent model routing and unavailable-model failures.
- [ ] Confirm the posting tool still cannot approve, request changes, or merge.
- [ ] Validate project-copy containment, integration, cleanup, and rollback.
- [ ] Confirm cancellation reaches child work and reports a terminal state.
- [ ] Exercise fallback to the prior adapter without changing agent identifiers.
- [ ] Recheck every watchlist item and drop assumptions that did not merge.
