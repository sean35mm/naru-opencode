---
title: Naru development guide
description: Detailed architecture, invariants, extension, testing, and release reference.
---

# Naru development guide

This guide describes the repository architecture, sources of truth, security invariants, extension rules, targeted checks, and release process.

## Architecture and dispatch graph

Naru has three related layers:

1. **Native skills.** Four Markdown skills in `skills/` are discovered on demand for planning, impact analysis, triage, and review guidance.
2. **Canonical agents.** Eight Markdown agents in `agents/` define prompts, modes, visibility, and permissions: the selected orchestrator and seven minions.
3. **Runtime plugins and validated tools.** Naru Delegate applies central model routing, validated Git/GitHub tools expose narrow read-only or posting operations, the optional process-local scheduler validates Protocol 3 declarations and native Task admissions, and the optional TUI displays child and scheduler activity.

The agent dispatch surface is fixed and explicit:

```text
naru-plan, naru-impact, naru-triage, naru-review -> on-demand guidance
naru-orchestrator -> scout, investigate, architect, implement, debug, verify, judge
naru-orchestrator -> validated posting tool (only on a current explicit natural-language post request)
```

The visible primary `naru-orchestrator` delegates only to the seven `naru-minion-*` roles. Skills and adaptive lenses are optional, not a workflow-agent topology. Review is dry-run by default; only an explicit current natural-language post request to the directly selected orchestrator may use the validated posting tool.

Dispatch authorization is fixed, but adaptive lenses are optional and selected only when useful. Skills do not require specialist fan-out, a judge, retries, status bookkeeping, or fixed phases. Review remains dry-run against an immutable GitHub snapshot; only a directly selected `naru-orchestrator` acting on a current explicit user post request may submit one validated `COMMENT`-only payload.

OpenCode's native Task implementation remains responsible for permission evaluation, cancellation, retries, background work, and child-session handling. Naru Delegate mutates runtime agent configuration; it does not create sessions itself.

## Source-of-truth map

| Concern | Source of truth |
| --- | --- |
| Public skill inventory and guidance | `skills/naru-*/SKILL.md` |
| Canonical agent prompt, visibility, mode, and permissions | `agents/naru-*.md` |
| Native skill permission and trust boundary | Skill frontmatter and exact agent `permission.skill` maps |
| Canonical eight-agent inventory | `NARU_AGENT_IDS` in `tools/naru-lib/model-routing.mjs`, checked against agent files |
| Exact orchestrator-to-minion edges | `NARU_DISPATCH_GRAPH`, checked against the orchestrator Task allowlist |
| Luna/Terra/Sol profiles and built-in assignments | `DEFAULT_MODEL_PROFILES` and `DEFAULT_AGENT_ASSIGNMENTS` |
| Luna-eligible minions | `LUNA_ELIGIBLE_ROLES` |
| Non-downgradeable roles | `SOL_FLOOR_ROLES` |
| Generated Sol-xhigh child aliases | `MANAGED_SOL_XHIGH_ALIASES` and the direct-root gate in `plugins/naru-delegate.js` |
| Runtime routing/config parsing and aliases | `tools/naru-lib/model-routing.mjs` |
| Plugin loading, scope merge, rollback, and Task resume guard | `plugins/naru-delegate.js` |
| Git and GitHub validation | `tools/naru-git-read.js`, `tools/naru-github-read.js`, `tools/naru-github-post-review.js`, and `tools/naru-lib/` |
| Dashboard state classification | `plugins/naru-minions-dashboard-state.mjs` |
| Dashboard UI and command registration | `plugins/naru-minions-dashboard.tsx` |
| TUI config rewrite | `scripts/merge-tui-config.mjs` |
| Runtime mode parsing and bounded defaults | `tools/naru-lib/scheduler-config.mjs`, `naru-runtime.example.json` |
| Protocol 3 schemas, state reduction, tokens, journal, and telemetry | `tools/naru-lib/scheduler-*.mjs` |
| Scheduler tool operations and native Task admission hook | `tools/naru-scheduler.js`, `plugins/naru-scheduler.js` |
| Local evaluation schema and dry-run scorer | `tools/naru-lib/evaluation.mjs`, `scripts/naru-live-eval.mjs` |
| Installed file inventory and migration behavior | `install.sh` |

Documentation describes these contracts but does not replace them.

## Routing and configuration lifecycle

Naru Delegate loads `naru-models.json` beside its installed plugin. The file is optional, limited to 64 KiB, and must be a regular non-symlinked file. Parsing rejects unknown top-level/profile fields, unknown canonical agents, invalid model identifiers, invalid profile names, static Luna assignments, and attempts to downgrade a Sol-floor role.

Schema v2 names profiles `luna`, `terra`, and `sol`, while static exact-agent assignments accept only `terra|sol`. Schema-v1 `fast|deep` profiles and assignments normalize to Terra/Sol before policy resolution or cross-scope merging. Keeping Luna out of static assignments preserves it as a per-invocation orchestrator choice.

Routing resolution for each agent is:

1. Parsed exact-agent override.
2. Built-in exact-agent default assignment.
3. Sol-floor membership.
4. Terra fallback.

The current built-in assignment makes `naru-orchestrator` Sol while leaving it outside `SOL_FLOOR_ROLES`, so an explicit Terra override remains valid. All three default profiles use variant `high`.

The plugin is deterministic routing infrastructure. It does not inspect task semantics or call a classifier model. Dispatchers, especially the default Sol-powered `naru-orchestrator`, receive generated route guidance and choose the model profile from the task packet and available evidence.

At config application time, routing:

1. Validates every canonical source agent before mutation.
2. Clones source definitions and applies the selected profile.
3. Validates every dispatcher's exact fail-closed Task map against `NARU_DISPATCH_GRAPH`.
4. Appends one generated routing policy section to dispatchers.
5. Creates hidden model aliases only for eligible canonical agent routes.
6. Adds only generated aliases reachable from the selected orchestrator to its runtime Task map.
7. Invokes Sol-floor, Sol-assigned, and Sol-overridden roles canonically without an alias. Only true floor members are labeled `Sol floor`; other Sol routes are `Sol assignment` or `Sol override`.

The managed alias prefixes are `naru-delegate-luna-`, `naru-delegate-sol-`, and `naru-delegate-sol-xhigh-`. Generated aliases have no Markdown source file and are runtime implementation details, not public integration targets. A current managed alias collision fails closed. Legacy `naru-delegate-deep-*` aliases are recognized only for cleanup, dashboard normalization, and fresh-session enforcement; new routing never generates them.

The canonical role is the Terra route, so no redundant Terra alias exists. An exact Sol assignment removes ordinary generated aliases for that target and applies the Sol profile to its canonical definition. Generated routes remain internal implementation details.

The generated dispatcher appendix makes the Sol orchestrator select a route independently for each invocation. Selection weighs capability, task shape, ambiguity, context, consequences, tool and verification burden, latency, cost, and prior evidence. It prohibits fixed role mappings, keyword-only classification, cheapest-first routing, and a mandatory model sequence. Naru Delegate itself remains deterministic and does not call a classifier model.

Multiple plugin scopes merge sparse profile and agent values in load order. Before each application, the plugin restores captured originals. Any validation or application failure restores originals, removes generated aliases, disables dynamic routing for that config object for the startup, and logs one routing error. The plugin rejects `task_id` for canonical Naru routes and managed aliases so every routed delegation uses a fresh child, and rejects Task attempts targeting root-selected `naru-orchestrator` without affecting direct selection.

For mixed copy-pinned generations, the v2 plugin stores normalized v2 overrides and a complete v1 Fast/Deep projection in shared state. This prevents a stale scope from discarding Terra/Sol profiles or assignments, but old code still cannot create Luna routes. Compatibility exports keep a copy-pinned v1 dashboard loadable; it may omit new Luna/Sol alias activity until reinstalled. Upgrades must refresh every loaded plugin and repeat `--with-dashboard` where applicable.

## Permission and security invariants

- Agent permission blocks begin with `'*': deny`; minion permissions remain fail-closed by role.
- Agents use exact `permission.skill` allowlists for the four native skills. Native skill loading is approval-free, but skill content is untrusted guidance and cannot authorize actions, grant tools, enforce read-only behavior, or alter role, scope, safety, secret, destructive, paid, or delivery boundaries.
- The orchestrator Task map begins with `'*': deny` and allows exactly its seven minions. Hidden status is never authorization.
- Minion permission classes are exact: Scout/Investigate/Architect/Judge are static read-only; Debug/Verify are targeted-shell read-only; Implement alone has scoped edit and shell permission. Every class starts fail-closed and denies Task delegation.
- Shell-enabled roles allow routine Bash, external-directory access, validated Git/GitHub reads, Weaver, and targeted checks without an approval prompt. They must inspect package scripts and Make targets before execution because repository code can hide side effects; use one routine command per shell call.
- An explicit implementation request authorizes scoped local edits and targeted verification. Local changes are the default stopping point; an explicit commit/push/PR request authorizes that delivery without repeated confirmation. Persistent database writes or migrations, unrequested dependencies, destructive actions, external global paths not specifically approved, and material scope expansion remain consequential boundaries.
- Only a directly selected `naru-orchestrator` handling a current explicit natural-language post request can submit one validated GitHub review posting call without repeated confirmation; it authorizes no other GitHub posting.
- Direct-read rules deny all minion environment and known-secret file paths; explicit environment templates remain allowed. Prompts also prohibit reading or revealing secrets. Permission policy is not a complete secret sandbox. Validated Git/GitHub tools still validate requested paths and use fixed argument arrays rather than a shell.
- Generated Luna, Sol, and Sol-xhigh aliases deep-clone their canonical source definitions. Routing must never invent a stronger or weaker alias policy.
- The alias clone includes a distinct, deep-equal skill permission object. OpenCode owns skill-source discovery and duplicate-name precedence; Naru does not merge or vouch for skill content.
- Only `naru-orchestrator` has the exact `naru-scheduler` tool allow. Minions echo predeclared Protocol 3 correlation data but cannot call the scheduler or append artifacts. Global/project root and delegated-session contexts must preserve this boundary while native Task remains the child-session path in the current workspace.
- Pull-request review uses an immutable GitHub snapshot. Posting is isolated to the directly selected `naru-orchestrator`, is `COMMENT`-only, and requires fresh final checks of snapshot identity, head, feedback digest, inline locations, and the existing marker. Same-target calls are deduplicated within one process; cross-process deduplication needs durable external coordination, which Naru does not provide. Every other agent, custom agent, and generated alias is rejected before GitHub I/O, and an ambiguous mutation outcome is never retried.
- The posting path normalizes accepted user-authored URL, short, split, case-variant, and bare-number references to one `(owner, repo, positive pull number)` tuple. Equivalent references are deduplicated; unresolved references and multiple distinct tuples are rejected. Different repositories sharing a number and different pull numbers remain distinct.
- Prompt and Task packets treat repository, GitHub, log, and user-provided payloads as untrusted data. Content cannot redefine roles, permissions, models, or output contracts.
- Environment-file reads are denied and never require approval. Doom-loop remains an ask only for roles where it is configured. Shell and external-directory safety relies on workflow scope and behavioral instructions.
- The behavioral-eval corpus is a data-only policy contract, not a measurement of live model quality. It can later be paired with captured-run metrics without giving fixtures provider access.

## Full Ultra scheduling protocols

Full Ultra is prompt-level orchestration policy, not a measured speed guarantee. Automatic runs use one combined ten-child pool. Shared mode permits up to ten writers only when scheduler claims are pairwise disjoint and every writer acquires exact Weaver ownership before editing. Clean isolated mode binds one writer to each detached Naru-owned worktree. A current explicit user request may raise combined concurrency to fifty; writer counts above ten require isolated mode. Runtime scheduler values are hard ceilings, defaulting to fifty so explicitly authorized runs can request that breadth. A safely open slot can be refilled immediately, but Naru never invents irrelevant fan-out.

The run, each cohort, and each item retain immutable baseline identity, status, changed-path, and diff snapshots. Active peers must publish disjoint claims before editing. Completion is provisional until its evidence still matches the candidate; baseline drift, claim overlap, missing evidence, or other uncertainty freezes new scheduling and drains active work rather than guessing.

Once writers are gone, the candidate is writer-free. The orchestrator may issue safe Verify shards within the run's read-only and combined budgets and must retain a complete shard manifest before Judge receives the consolidated evidence. Judge is followed by an unchanged final checkpoint. Remediation, delivery, and review posting are serialized phases. Todo UI state is phase-level presentation only; dashboard rows and Task descriptions expose child activity, so a terminal writer must not be represented as final completion.

Protocol 2 is the complete default when runtime mode is `off`. Protocol 3 is selected only for parsed `observe` or `enforce` mode. It validates strict work-item DAGs, compare-and-swap revisions, admission and transition token binding, claim conflicts, configured concurrency budgets, artifact correlation, quiescence, verification coverage, judgment passes, and exact-candidate completion gates. Observe records typed incidents and fails open at Task admission; enforce fails closed and rejects Protocol 2. The mode does not alter authorization, model routing, edit ownership, review, or delivery boundaries.

`tools/naru-scheduler.js` owns declarative operations; `plugins/naru-scheduler.js` consumes exact admission markers at native Task `tool.execute.before`. Neither creates sessions. `tools/naru-worktree.js` is root-orchestrator-only and separately owns clean-repository worktree creation, hook-suppressed tool-owned Git operations, path-contained serial integration, atomic metadata updates, final aggregate application, crash recovery from local run metadata, and post-finalization cleanup. Integration failures attempt rollback; unrelated external workspace mutation is outside its protection. The scheduler registry, bounded digest-linked journal, and telemetry are process-local and non-durable. They cannot provide authoritative background completion, cross-process coordination, report truth, provider hard caps, or a general sandbox. Prompt-level baseline, Weaver, containment, freshness, workspace binding, and final-state checks therefore remain mandatory.

Configuration defaults to `off`; `naru-runtime.example.json` is copied but never activated automatically. Runtime JSON is regular, non-symlinked, at most 64 KiB. Protocol defaults bound manifests at 256 KiB, work items at 32 KiB, tokens at 16 KiB, artifacts at 64 KiB, work items at 256, and admission/transition lifetimes at five minutes. The journal retains 64 roots, 256 entries per root, and 4 KiB sanitized metadata per entry.

## Dashboard and TUI architecture

The dashboard is opt-in and consists of two copy-pinned files:

- `naru-minions-dashboard-state.mjs` normalizes Task metadata, canonicalizes managed aliases, resolves status precedence, and classifies routes from configured agent profiles without guessing unknown metadata.
- `naru-minions-dashboard.tsx` is an external OpenTUI/Solid plugin. It registers `/naru-minions`, subscribes to native session/message events, queries root children and message metadata, renders a sidebar slot, and opens a navigation dialog.

Rows are limited to recognized canonical Naru agents or managed aliases. Model text comes from Task or child-message metadata, not routing assumptions. Terminal Task state outranks stale native active state. The compact sidebar conservatively bounds every rendered line while retaining status text and symbols, counts, up to four active or recently terminal rows, and an overflow hint. `/naru-minions` remains a native filterable `DialogSelect`: each compact fixed table-like option has one aligned status/agent/age/task title bounded to 61 characters, labeled route/mode/model/short-session metadata, and the full session ID as its navigation value. Loading, empty, and unavailable states use selectable-looking sentinels that render through filtering but never navigate.

When scheduler telemetry exists for the same process-local root, the dashboard adds mode, item counts, local budget pressure, quality-gate status, oldest blocked work, and a maximum of eight evidenced actor groups. It hides the surface when no telemetry exists and labels limits process-local rather than implying durable, global, cross-process, background, or provider enforcement.

`scripts/merge-tui-config.mjs` performs the installer-facing JSON/JSONC update. It rewrites only the top-level plugin registration while preserving unrelated content, prefers `tui.jsonc`, removes exact legacy registrations from other active config files, and rejects malformed inputs.

## Installer invariants

`install.sh` maintains an explicit inventory; new runtime files are not installed merely because they exist in the repository.

- The source and target must not overlap, and loader/managed target directories must not be symlinks.
- All source files are preflighted and the release is staged on the target filesystem before existing loader paths are changed.
- Agent and command Markdown follows symlink/copy mode. Tools, helper directories, runtime/evaluation assets, and plugins are always copied.
- Existing managed destinations and migrations move to timestamped backups. A failed transaction removes newly installed paths and restores backups.
- Healthy manifest-owned legacy commands and workflow agents are retired on reinstall; modified or unowned paths are preserved and reported unless a reviewed preview explicitly replaces them.
- Dashboard registration requires Node.js or Bun, rejects symlinked or malformed TUI config, and is idempotent.
- Naru's selected-orchestrator-to-seven-minion design is depth-1-compatible. `--configure-subagent-depth` is a deprecated accepted no-op for migration compatibility.
- The installer preserves `naru-models.json` and unrelated OpenCode content.
- The installer replaces only managed Naru definitions; it does not mutate global non-Naru agents to add skill access. Refresh every loaded install scope and restart OpenCode after changing the canonical skill contract.
- The deprecated depth flag is accepted as a no-op for migration compatibility and does not change configuration.

When changing installed inventory, update the install plan and its fixture inventory together.

## Local evaluation harness

`evaluation.mjs` validates bounded captured summaries and scores only the supplied deterministic fields: useful delegation or justified skip, concurrency/elapsed/child budgets, remediation, best-of-2 behavior, checks, and typed incidents. Evaluation manifests must explicitly state that prompts, code, and diffs are omitted; sensitive or raw source/patch fields are rejected. The manifest is limited to 256 KiB and 128 cases, and each sanitized journal to 128 entries.

`scripts/naru-live-eval.mjs` supports deterministic local `--manifest <path> --dry-run` scoring, which is free, and provider-free contract preparation. The separately gated `--live` form requires exact reviewed confirmations for the contract, fixtures, provider, model, repetitions, timeouts, and spend. The current local adapter intentionally fails closed before starting OpenCode or making a provider request because runtime-byte binding and provider-enforced budgets are unavailable. Live output remains sanitized and bounded; it does not upload artifacts or claim a benchmark or live pilot ran.

## Extension rules and reserved identifiers

Keep extensions explicit and fail-closed:

1. Add a canonical `agents/naru-<name>.md` with the correct mode, visibility, secret policy, and least-privilege role class. Do not copy Implement shell/edit permission to a role that does not require it.
2. Add its ID to `NARU_AGENT_IDS`.
3. If another Naru agent may call it, add the exact edge to `NARU_DISPATCH_GRAPH` and the caller's exact Task permission map. Do not use broad `naru-*` allows.
4. Add it to `SOL_FLOOR_ROLES` only when downgrade must be prohibited. A preferred default that users may override belongs in `DEFAULT_AGENT_ASSIGNMENTS` instead.
5. Update the installer inventory, config-policy expected inventory, relevant prompt contracts, and routing tests.
6. If it is public, add a deliberate skill entry point and update user documentation. Internal agents should remain hidden.

Reserved identifiers and contracts:

- `naru-delegate-luna-*`, `naru-delegate-sol-*`, and `naru-delegate-sol-xhigh-*` are reserved for generated model routes. The legacy `naru-delegate-deep-*` prefix remains reserved for cleanup compatibility. Do not create files, custom agents, or user integrations with these prefixes.
- Canonical `naru-*` IDs listed in `NARU_AGENT_IDS` are centrally routed and guarded against `task_id` resume.
- The public skills are `naru-plan`, `naru-impact`, `naru-triage`, and `naru-review`; retired slash commands are not current entry points.
- `naru-orchestrator` is root-selected and must fail closed when targeted through Task.
- `naru-minion-*`, specialists, and judges are internal implementation details, not public integration targets.
- The routing marker, schema version, managed alias prefix, dashboard plugin ID, and exact TUI registration path are compatibility contracts. Change them only with migration and targeted coverage.

## Canonical local checks

After installing the repository dependencies, the canonical root checks are:

```sh
npm test
npm run test:bun
npm run test:installer
```

After installing the documentation dependencies, build the docs with:

```sh
npm --prefix docs run build
```

## Targeted checks

Run the smallest relevant check for the changed area:

```sh
node --test tests/model-routing.test.mjs
node --test tests/behavioral-evals.test.mjs
node --test tests/evaluation.test.mjs
node --test tests/live-evaluation.test.mjs
node tests/config-policy.test.mjs
node tests/prompt-contracts.test.mjs
node --test tests/scheduler-protocol.test.mjs
node --test tests/scheduler-runtime.test.mjs
node --test tests/scheduler-telemetry.test.mjs
node --test tests/dashboard-contract.test.mjs
node --test tests/merge-tui-config.test.mjs
node --test tests/github-tools.test.mjs
node --test tests/bun-transport.test.mjs
node --test tests/worktree.test.mjs
sh tests/install.test.sh
git diff --check
```

Routing changes normally require the model-routing, config-policy, and prompt-contract checks. Scheduler changes require the narrow protocol/runtime/telemetry checks. Dashboard changes require dashboard and merge-config checks. Installer inventory or migration changes require `tests/install.test.sh`. Evaluation changes require `tests/evaluation.test.mjs`. Tool changes require the relevant Node tool tests.

Inspect any script or target before execution and do not run database-connected or mutation-capable checks merely because a command name appears routine.

## Release checklist

1. Confirm the four-skill and eight-agent inventories are intentional and the orchestrator Task map allows only its seven minions.
2. Confirm model defaults, v1 normalization/projection, exact assignments, Sol floors, canonical Terra/Sol invocation, and override behavior are covered.
3. Confirm no agent accidentally gained model frontmatter; only the implementation fallback pin should remain.
4. Review permission blocks for exact skill allowlists, the orchestrator's exact minion targets, role-specific minion permissions, shell/edit boundaries, secret guidance, and posting boundaries.
5. Verify README and the three guides match public skills, installer flags, routing behavior, scheduler modes, evaluation limits, dashboard support, and safety limitations.
6. Run the targeted checks for every touched subsystem and `git diff --check`; record any checks not run.
7. Exercise the installer test when release inventory, migration, dashboard registration, or copy/symlink behavior changed.
8. Review the complete diff for generated files, local paths, secrets, stale identifiers, and unintended user-configuration changes.
9. Prepare release notes that call out user-visible routing, installation, migration, permission, or command changes without claiming unverified automation.
