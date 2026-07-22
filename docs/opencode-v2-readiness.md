# OpenCode v2 readiness notes

Status: investigation snapshot from 2026-07-22.

These notes capture the v2-adjacent OpenCode changes that are most likely to affect Naru. The public `v2` branch was not fetchable from this environment, so this pass used upstream `dev` source files and public issue/docs signals for the still-experimental background-subagent work.

## Upstream source areas reviewed

- `packages/opencode/src/tool/task.ts`: native Task schema, `background`, `task_id`, depth checks, child session creation, metadata, background promotion, foreground cancellation, and synthetic completion injection.
- `packages/core/src/background-job.ts`: in-process job registry, status model, start/extend/wait/promote/cancel lifecycle, and explicit non-durability comments.
- `packages/opencode/src/background/job.ts`: OpenCode package-level wrapper around the core background job service.
- `packages/opencode/src/effect/runtime-flags.ts`: experimental feature flags, including `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`, event system, workspaces, Scout, LSP tool, native LLM, and parallel search flags.
- `packages/opencode/src/agent/subagent-permissions.ts`: child permission derivation and inheritance semantics.
- Public OpenCode docs/issues around experimental flags, task status visibility, and interrupt/cancel behavior.

This was not a full local clone because direct `git clone` to GitHub was blocked by the environment's CONNECT tunnel. Treat this as a daily-source audit checklist rather than a pinned release analysis.

## What changed upstream

OpenCode's `task` tool now has a native `background` boolean. When the experimental runtime flag is enabled, `background=true` starts a subagent asynchronously and returns a running `<task>` result instead of blocking the parent turn. Foreground remains the default behavior.

The task implementation now supports resuming an existing subagent session with `task_id`. If that session already has a running background job, OpenCode extends the existing job by queueing additional prompt work after the previous tail finishes.

When a background job completes or errors, OpenCode prompts the parent session with a synthetic `<task id="childSession" state="completed|error">` result. The model is therefore notified through another parent assistant turn, not by a separate durable event stream.

The implementation still enforces `subagent_depth`, deriving depth from the parent-session chain and failing when the current depth is at or above `cfg.subagent_depth ?? 1`. Naru's current minimum of `2` therefore remains relevant for the existing root-to-specialist topology.

OpenCode now derives child-session permissions from the parent session and the target subagent, then adds fail-closed denials for `todowrite`, `task`, and configured experimental primary tools unless the child explicitly has those permissions. This is directionally aligned with Naru's current fail-closed minion model.

The background job registry is process-local and explicitly non-durable. A restart or owner-scope closure loses job status and interrupts live work unless OpenCode adds a separate durable ownership slice later.

The background path is still experimental in the observed source: `background=true` fails unless `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` or broad `OPENCODE_EXPERIMENTAL` enables it. Treat it as unstable until OpenCode v2 documents and releases the final contract.

## Direct Naru compatibility impact

### Good news

- Naru already treats native OpenCode Task permissions and child sessions as the authority. Naru Delegate exposes routes without replacing those primitives.
- The scheduler plugin already recognizes both `background` and `run_in_background` as non-foreground Task arguments, so it should not misclassify native background tasks as blocking foreground work.
- Naru already requires `subagent_depth >= 2`, matching OpenCode's upstream depth check for Naru's current two-level dispatch topology.
- Generated Naru aliases clone canonical permissions, which should work with OpenCode's child permission derivation as long as OpenCode preserves the agent-file permission schema.
- Naru already rejects `task_id` for Naru routes in Delegate, which avoids accidental resume/state-smearing while the upstream semantics are young.

### Main risks

1. **Completion observability is synthetic and asynchronous.** OpenCode injects background results into the parent by starting another prompt with synthetic text. Naru Scheduler currently cannot authoritatively prove background completion or correlate all background lifecycle transitions across processes.
2. **Cancellation semantics may diverge.** Foreground interruption cancels the child and background job in the observed code path, but native background jobs are intentionally detached after launch. Naru should not assume parent interruption cancels background work.
3. **Result injection can race the active parent session.** A finished background task can trigger another parent prompt while the user or parent agent has moved on, which may affect model/variant continuity and final-response discipline.
4. **`task_id` resume changes the delegation model.** Naru's existing guidance says external agents should not use `task_id`; v2 makes resume a first-class capability, so Naru needs explicit policy for whether orchestrator-owned background jobs may be resumed, steered, or sealed.
5. **Native background jobs overlap with Naru Scheduler.** OpenCode may provide enough native parallelism that parts of Naru's prompt-level rolling cohorts become redundant, but Protocol 3 still adds claims, admission tokens, quality gates, and final-candidate checks that native background dispatch does not provide.
6. **Experimental flag surfaces may churn.** OpenCode already has adjacent experimental flags for event system, workspaces, native LLM, Scout, LSP, and parallel execution. Any of these can change hook metadata, built-in agents, or concurrency behavior that Naru currently treats as stable.

## Exact Naru treatment map

| Naru area | Current relevant code/docs | v2 treatment needed | Priority |
| --- | --- | --- | --- |
| Delegate Task hook | `plugins/naru-delegate.js` rejects `task_id`, checks `subagent_depth`, and manages routing aliases. | Keep fresh-session default, but add capability-aware checks for native `background` parameter presence, final `task_id` semantics, and any renamed metadata fields. Decide if only `naru-orchestrator` may opt into background while external custom-agent integrations remain fresh-only. | High |
| Scheduler Task admission hook | `plugins/naru-scheduler.js` consumes admission markers in `tool.execute.before` and already detects `background`/`run_in_background`. | Split foreground and background admission records. Store `jobId`, child `sessionId`, background flag, and task metadata when available. Add incidents for missing `jobId`, orphaned completion, duplicate completion, and resumed jobs without ownership. | High |
| Scheduler token registry | `tools/naru-lib/scheduler-token.mjs` binds one Task call ID to one admission token. | Add optional native-background binding fields without weakening existing replay checks: `nativeJobId`, `childSessionID`, `background`, `resumeOf`, and `completionObservedAt`. | High |
| Scheduler state reducer | `tools/naru-lib/scheduler-state.mjs` models active admissions and terminal/evidence artifacts. | Add a background lifecycle projection or companion reducer so active admissions can remain active across parent turns until correlated completion evidence arrives. Do not let a running background writer count as complete merely because Task returned `<task state="running">`. | High |
| Scheduler telemetry/dashboard | `tools/naru-lib/scheduler-telemetry.mjs`, `plugins/naru-minions-dashboard-state.mjs`, and `plugins/naru-minions-dashboard.tsx` already show native active/background-ish task rows. | Promote background records to first-class telemetry: running/updated/completed/error/cancelled/orphaned, started age, owner work item, claims, and whether completion evidence has been consumed. | Medium |
| Orchestrator prompt | `agents/naru-orchestrator.md` already permits background read-only children outside `foreground`/`off`. | Tighten v2-native background instructions: launch only independent shards, never poll, never duplicate touched paths/topics, never final-answer from a running task, and reconcile synthetic `<task>` results before dependent decisions. Add explicit “resume only when Naru owns the job id” policy if resume is enabled. | High |
| Minion prompts | `agents/naru-minion-*.md` currently prohibit Task delegation for minions. | Keep minions non-delegating. Add only report fields if background correlation becomes required, so minions echo child session/job metadata but cannot manage jobs. | Medium |
| Installer/config | `install.sh`, `scripts/merge-opencode-config.mjs`, docs, and tests manage `subagent_depth`. | Do not auto-enable `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`. Add docs-only opt-in until v2 stable. If OpenCode adds config-file support for background mode, merge it transactionally only behind an explicit installer flag. | Medium |
| Live evaluation | `scripts/naru-live-eval.mjs`, `tools/naru-lib/opencode-live-evaluation.mjs`, `tests/fixtures/live-evals.json`. | Add daily v2 capture cases for native background launch, synthetic completion, parent interruption, resume, and process restart/orphan behavior. | Medium |
| Documentation | README, user guide, development guide, scheduler runtime docs. | Add a “v2 watch” section and mark all native background support as experimental/observe-first until released. Keep current foreground compatibility docs intact. | Low |

## Capabilities v2 may unlock for Naru

1. **True non-blocking scout/investigate waves.** The orchestrator can keep refining decomposition while multiple read-only scouts run, reducing over-conservatism without increasing write risk.
2. **Speculative best-of-N planning.** Naru can launch cheap Luna/Terra exploratory variants in background, then ask Sol/Judge to reconcile only the useful reports.
3. **Parallel verification shards after implementation.** Verify can cover independent test surfaces concurrently while the orchestrator prepares final checks, as long as completion is gated on exact-candidate evidence.
4. **Isolated writer farms with native UI visibility.** Naru-owned worktree writers can run as native background jobs while the dashboard shows job IDs, paths, claims, and stale/blocked status.
5. **Adaptive escalation while work is running.** If a background child discovers ambiguity, the orchestrator can send a narrow resume/update to the same child session instead of spawning duplicate context, but only when the job is Naru-owned.
6. **Daily source-drift sentinel.** A small script can diff upstream `dev`/`v2` Task, background-job, runtime-flags, subagent-permission, session-prompt, and server event files and open a “watch” issue/PR when signatures change.
7. **Native event-system bridge.** If OpenCode's experimental event system matures, Naru Scheduler can move from best-effort hook observation to explicit lifecycle events for background job start, promote, output, completion, cancellation, and restart recovery.
8. **Workspace-aware implementation lanes.** If OpenCode workspaces become stable, Naru may be able to map writer claims to native workspace/session boundaries instead of relying only on Naru-created git worktrees.
9. **Less conservative UX without weaker gates.** Native background jobs can make “Full Ultra” feel interactive: launch, continue useful orchestration, show progress, then block only at evidence gates and final candidate selection.

## Recommended preparation branch

Create a separate `opencode-v2-readiness` branch once the v2 API stabilizes, then implement the following in small, reversible slices.

### 1. Runtime capability probe

Add an OpenCode capability detector that records:

- task tool parameter support: `background`, `task_id`, and any renamed status/cancel tools;
- whether background subagents are experimental-gated or stable;
- whether tool hooks expose stable task metadata fields (`sessionId`, `parentSessionId`, `jobId`, `background`);
- whether completion injection emits distinguishable synthetic messages or task metadata events;
- whether process restarts preserve or intentionally orphan background job state;
- whether the event system exposes enough background lifecycle events to replace synthetic-message scraping.

The scheduler should keep current behavior when capability data is absent.

### 2. Background-aware scheduler state

Extend scheduler state with a durable-ish background task record keyed by root session, parent session, child session, job id, target agent, work item, claims, and status. The first version can remain process-local but should make states explicit: `admitted`, `running`, `updated`, `reported`, `completed`, `error`, `cancelled`, `orphaned`, and `unknown`.

### 3. Explicit policy modes

Add runtime config for background native tasks:

- `off`: keep using foreground/rolling-cohort behavior;
- `observe`: allow `background=true`, record incidents on missing metadata or orphaned completion;
- `enforce`: allow only scheduler-admitted background tasks with non-overlapping claims and bounded concurrency.

Default to `off` or `observe` until v2 is released.

### 4. Prompt contract refresh

Update `naru-orchestrator` and minion prompts so background work is used only for independent, non-overlapping read-only investigation or isolated writer shards. Prompts should explicitly prohibit polling loops, duplicate work, final claims before completion evidence is observed, and user-visible “done” language while any required background job is still running.

### 5. Tests and fixtures

Add fixtures that simulate native background task hooks:

- background Task before-hook with admission token;
- immediate running result with `jobId`/child `sessionId`;
- synthetic completion message injected into the parent;
- cancellation/error/orphaned completion;
- resumed task with `task_id`;
- concurrent background tasks with overlapping and non-overlapping claims;
- foreground task promoted to background through `waitForPromotion`;
- process restart or registry loss while child session artifacts remain in OpenCode history.

### 6. Documentation and migration

Document that Naru works on current OpenCode releases with foreground Task semantics, and that v2 background support is opt-in until the native lifecycle contract is stable. Keep `subagent_depth: 2` guidance unless the final v2 release changes the default or nesting semantics.

## Daily v2 watch checklist

For each daily check until v2 ships:

1. Check whether a public `v2` branch/tag exists and compare it to `dev`.
2. Re-read upstream `task.ts`, `background-job.ts`, `runtime-flags.ts`, `subagent-permissions.ts`, `session/prompt.ts`, server/API routes, and docs generated for experimental flags.
3. Search upstream issues/PRs for `background`, `task_id`, `task_status`, `subagent_depth`, `promote`, `cancel`, `event system`, `workspace`, and `Scout`.
4. Update this file with source-date, behavior changes, and concrete Naru treatment deltas.
5. If a contract stabilizes, move the matching row from “watch” to an implementation issue/branch task.

## Decision recommendation

Do not replace Naru Scheduler with native OpenCode v2 background subagents. Instead, treat native background subagents as a faster execution substrate underneath Naru's existing policy layer. Naru's differentiator should remain typed admission, claim isolation, model-fit routing, evidence gates, and review/posting safety; v2 can reduce conservatism only when Naru can observe enough lifecycle data to prove safe completion.
