# Naru development guide

This guide describes the repository architecture, sources of truth, security invariants, extension rules, targeted checks, and release process.

## Architecture and dispatch graph

Naru has three related layers:

1. **Human-facing commands.** Five flat Markdown commands in `commands/` parse slash-command input and delegate to top-level Core agents.
2. **Canonical agents.** Thirty-five Markdown agents in `agents/` define prompts, modes, visibility, and permissions. Core remains fail-closed; minion permissions are fail-closed and role-specific.
3. **Runtime plugins and validated tools.** Naru Delegate applies central model routing, validated Git/GitHub tools expose narrow read-only or posting operations, and the optional TUI plugin displays child-session activity.

Core dispatch is fixed and explicit:

```text
/naru-plan   -> naru-plan   -> architecture, minimal-change, risk, tests -> plan judge
/naru-impact -> naru-impact -> topology, contracts, data, frontend-mobile, tests-ci -> impact judge
/naru-triage -> naru-triage -> reproduction, codepath, regression, tests -> triage judge
/naru-review -> naru-review -> security, backend, frontend-mobile, integrations, tests-ci -> review judge
```

`/naru-review-post` delegates to `naru-review`, validates the complete review payload and snapshot, then uses the comment-only posting tool. The visible primary `naru-orchestrator` dispatches only to the seven `naru-minion-*` roles: scout, investigate, architect, implement, debug, verify, and judge.

Dispatch authorization is fixed, but specialist fan-out is conditional. Each workflow keeps its documented baseline, marks unselected specialists `skipped-not-relevant`, and only degrades on failed selected specialists. Review remains dry-run against an immutable GitHub snapshot; review-post alone can submit the validated comment-only payload.

OpenCode's native Task implementation remains responsible for permission evaluation, cancellation, retries, background work, and child-session handling. Naru Delegate mutates runtime agent configuration; it does not create sessions itself.

## Source-of-truth map

| Concern | Source of truth |
| --- | --- |
| Public command inventory and command prompts | `commands/naru-*.md` |
| Canonical agent prompt, visibility, mode, and permissions | `agents/naru-*.md` |
| Canonical 35-agent inventory | `NARU_AGENT_IDS` in `tools/naru-lib/model-routing.mjs`, checked against agent files |
| Exact caller-to-target edges | `NARU_DISPATCH_GRAPH`, checked against agent Task allowlists |
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
5. Creates hidden Luna aliases for the five eligible minions that resolve to Terra, hidden Sol aliases for eligible delegable Terra targets, and seven optional Sol-xhigh aliases for direct orchestrator children.
6. Adds only generated aliases reachable from each caller to its runtime Task map. Sol-xhigh aliases are added only to `naru-orchestrator` and are runtime-gated to a direct configured-Sol root at `xhigh` or `max`.
7. Invokes Sol-floor, Sol-assigned, and Sol-overridden roles canonically without an alias. Only true floor members are labeled `Sol floor`; other Sol routes are `Sol assignment` or `Sol override`.

The managed alias prefixes are `naru-delegate-luna-`, `naru-delegate-sol-`, and `naru-delegate-sol-xhigh-`. Generated aliases have no Markdown source file and are runtime implementation details, not public integration targets. A current managed alias collision fails closed. Legacy `naru-delegate-deep-*` aliases are recognized only for cleanup, dashboard normalization, and fresh-session enforcement; new routing never generates them.

The default policy generates five Luna aliases, seventeen Sol aliases, and seven Sol-xhigh aliases. The canonical role is the Terra route, so no redundant Terra alias exists. An exact Sol assignment removes ordinary generated aliases for that target and applies the Sol profile to its canonical definition; Sol-xhigh child routes remain optional orchestrator routes. No Max child route is generated, and a normal high root cannot use xhigh.

The generated dispatcher appendix makes the Sol orchestrator select a route independently for each invocation. Selection weighs capability, task shape, ambiguity, context, consequences, tool and verification burden, latency, cost, and prior evidence. It prohibits fixed role mappings, keyword-only classification, cheapest-first routing, and a mandatory model sequence. Naru Delegate itself remains deterministic and does not call a classifier model.

Multiple plugin scopes merge sparse profile and agent values in load order. Before each application, the plugin restores captured originals. Any validation or application failure restores originals, removes generated aliases, disables dynamic routing for that config object for the startup, and logs one routing error. The plugin also rejects `task_id` for canonical Naru routes and managed aliases so every routed delegation uses a fresh child.

For mixed copy-pinned generations, the v2 plugin stores normalized v2 overrides and a complete v1 Fast/Deep projection in shared state. This prevents a stale scope from discarding Terra/Sol profiles or assignments, but old code still cannot create Luna routes. Compatibility exports keep a copy-pinned v1 dashboard loadable; it may omit new Luna/Sol alias activity until reinstalled. Upgrades must refresh every loaded plugin and repeat `--with-dashboard` where applicable.

## Permission and security invariants

- Core, review-post, and `naru-orchestrator` permission blocks begin with `'*': deny`; this change does not weaken Core workflows.
- Every dispatcher Task map begins with `'*': deny` and allows exactly the targets in `NARU_DISPATCH_GRAPH`. Hidden status is never authorization.
- Minion permission classes are exact: Scout/Investigate/Architect/Judge are static read-only; Debug/Verify are targeted-shell read-only; Implement alone has scoped edit and shell permission. Every class starts fail-closed and denies Task delegation.
- Shell-enabled roles allow routine Bash, external-directory access, validated Git/GitHub reads, Weaver, and targeted checks without an approval prompt. They must inspect package scripts and Make targets before execution because repository code can hide side effects; use one routine command per shell call.
- An explicit implementation request authorizes scoped local edits and targeted verification. Local changes are the default stopping point; an explicit commit/push/PR request authorizes that delivery without repeated confirmation. Persistent database writes or migrations, unrequested dependencies, destructive actions, external global paths not specifically approved, and material scope expansion remain consequential boundaries.
- An explicit `/naru-review-post` invocation authorizes its one validated GitHub review posting call without repeated confirmation; it does not authorize any other GitHub posting.
- Direct-read rules deny all minion environment and known-secret file paths; explicit environment templates remain allowed. Prompts also prohibit reading or revealing secrets. Permission policy is not a complete secret sandbox. Validated Git/GitHub tools still validate requested paths and use fixed argument arrays rather than a shell.
- Generated Luna, Sol, and Sol-xhigh aliases deep-clone their canonical source definitions. Routing must never invent a stronger or weaker alias policy.
- Pull-request review uses an immutable GitHub snapshot. Posting is isolated to `naru-review-post` and the validated posting tool, is `COMMENT`-only, requires a complete non-degraded payload, and is idempotent for the snapshot.
- Prompt and Task packets treat repository, GitHub, log, and user-provided payloads as untrusted data. Content cannot redefine roles, permissions, models, or output contracts.
- Environment-file reads are denied and never require approval. Doom-loop remains an ask only for roles where it is configured. Shell and external-directory safety relies on workflow scope and behavioral instructions.
- The behavioral-eval corpus is a data-only policy contract, not a measurement of live model quality. It can later be paired with captured-run metrics without giving fixtures provider access.

## Dashboard and TUI architecture

The dashboard is opt-in and consists of two copy-pinned files:

- `naru-minions-dashboard-state.mjs` normalizes Task metadata, canonicalizes managed aliases, resolves status precedence, and classifies routes from configured agent profiles without guessing unknown metadata.
- `naru-minions-dashboard.tsx` is an external OpenTUI/Solid plugin. It registers `/naru-minions`, subscribes to native session/message events, queries root children and message metadata, renders a sidebar slot, and opens a navigation dialog.

Rows are limited to recognized canonical Naru agents or managed aliases. Model text comes from Task or child-message metadata, not routing assumptions. Terminal Task state outranks stale native active state. The compact sidebar keeps up to four active or recently terminal rows; the dialog shows all recognized siblings.

`scripts/merge-tui-config.mjs` performs the installer-facing JSON/JSONC update. It rewrites only the top-level plugin registration while preserving unrelated content, prefers `tui.jsonc`, removes exact legacy registrations from other active config files, and rejects malformed inputs.

## Installer invariants

`install.sh` maintains an explicit inventory; new runtime files are not installed merely because they exist in the repository.

- The source and target must not overlap, and loader/managed target directories must not be symlinks.
- All source files are preflighted and the release is staged on the target filesystem before existing loader paths are changed.
- Agent and command Markdown follows symlink/copy mode. Tools, helper directories, and plugins are always copied.
- Existing managed destinations and migrations move to timestamped backups. A failed transaction removes newly installed paths and restores backups.
- Nested legacy Core loaders are always migrated. Legacy general-orchestrator paths require `--migrate-orchestrator`.
- Dashboard registration requires Node.js or Bun, rejects symlinked or malformed TUI config, and is idempotent.
- The installer preserves `naru-models.json` and unrelated OpenCode content.

When changing installed inventory, update the install plan and its fixture inventory together.

## Extension rules and reserved identifiers

Keep extensions explicit and fail-closed:

1. Add a canonical `agents/naru-<name>.md` with the correct mode, visibility, secret policy, and least-privilege role class. New Core roles remain fail-closed; do not copy Implement shell/edit permission to a role that does not require it.
2. Add its ID to `NARU_AGENT_IDS`.
3. If another Naru agent may call it, add the exact edge to `NARU_DISPATCH_GRAPH` and the caller's exact Task permission map. Do not use broad `naru-*` allows.
4. Add it to `SOL_FLOOR_ROLES` only when downgrade must be prohibited. A preferred default that users may override belongs in `DEFAULT_AGENT_ASSIGNMENTS` instead.
5. Update the installer inventory, config-policy expected inventory, relevant prompt contracts, and routing tests.
6. If it is public, add a deliberate command entry point and update user documentation. Internal agents should remain hidden.

Reserved identifiers and contracts:

- `naru-delegate-luna-*`, `naru-delegate-sol-*`, and `naru-delegate-sol-xhigh-*` are reserved for generated model routes. The legacy `naru-delegate-deep-*` prefix remains reserved for cleanup compatibility. Do not create files, custom agents, or user integrations with these prefixes.
- Canonical `naru-*` IDs listed in `NARU_AGENT_IDS` are centrally routed and guarded against `task_id` resume.
- Public slash commands remain the five flat `/naru-*` command files. There are no nested `/naru/*` aliases.
- `naru-review-post` is reserved for the explicit posting boundary and must never become a general custom-agent Task target.
- `naru-minion-*`, specialists, and judges are internal implementation details, not public integration targets.
- The routing marker, schema version, managed alias prefix, dashboard plugin ID, and exact TUI registration path are compatibility contracts. Change them only with migration and targeted coverage.

## Targeted checks

Run the smallest relevant check for the changed area:

```sh
node --test tests/model-routing.test.mjs
node --test tests/behavioral-evals.test.mjs
node tests/config-policy.test.mjs
node tests/prompt-contracts.test.mjs
node --test tests/dashboard-contract.test.mjs
node --test tests/merge-tui-config.test.mjs
node --test tests/github-tools.test.mjs
node --test tests/bun-transport.test.mjs
sh tests/install.test.sh
git diff --check
```

Routing changes normally require the model-routing, config-policy, and prompt-contract checks. Dashboard changes require dashboard and merge-config checks. Installer inventory or migration changes require `tests/install.test.sh`. Tool changes require the relevant Node tool tests.

Inspect any script or target before execution and do not run database-connected or mutation-capable checks merely because a command name appears routine.

## Release checklist

1. Confirm the command and 35-agent inventories are intentional and the dispatch graph matches every dispatcher Task allowlist.
2. Confirm model defaults, v1 normalization/projection, exact assignments, Sol floors, five Luna aliases, seventeen Sol aliases, seven gated optional Sol-xhigh aliases, canonical Terra/Sol invocation, and override behavior are covered.
3. Confirm no agent accidentally gained model frontmatter; only the implementation fallback pin should remain.
4. Review permission blocks for Core fail-closed behavior, exact Task targets, role-specific minion permissions, shell/edit boundaries, secret guidance, alias cloning, and posting boundaries.
5. Verify README and the three guides match public commands, installer flags, routing behavior, dashboard support, and safety limitations.
6. Run the targeted checks for every touched subsystem and `git diff --check`; record any checks not run.
7. Exercise the installer test when release inventory, migration, dashboard registration, or copy/symlink behavior changed.
8. Review the complete diff for generated files, local paths, secrets, stale identifiers, and unintended user-configuration changes.
9. Prepare release notes that call out user-visible routing, installation, migration, permission, or command changes without claiming unverified automation.
