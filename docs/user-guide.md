---
title: Naru user guide
description: Detailed installation, operation, routing, dashboard, and safety reference.
---

# Naru user guide

This guide covers installation, day-to-day use, model routing, the optional dashboard, upgrades, migration, troubleshooting, and Naru's safety boundaries.

## Requirements

- [OpenCode](https://opencode.ai) >= 1.18.4, with an effective top-level `subagent_depth` of at least `2`.
- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated, for pull-request review workflows.
- Node.js or Bun for every installation that uses `--with-dashboard` or `--configure-subagent-depth`; the installer needs one of them to merge configuration safely.
- `codebase-memory` and LSP support are optional. Read-only workflows fall back to literal file search when they are unavailable or stale.

## Install and update

Clone Naru and run its transactional installer:

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
./install.sh
```

The installer preflights and stages the complete release before replacing loader paths. Replaced content is retained in a timestamped `.naru-backups/` directory and restored if installation fails. It copies the scheduler tool/plugin, runtime libraries, `naru-runtime.example.json`, and local evaluation script/fixture, but does not create an active runtime configuration or enable scheduling.

OpenCode 1.18.4 defaults `subagent_depth` to `1` when the top-level key is omitted. Naru requires an effective value of at least `2`, which is the maximum depth used by the current Naru topology. Exactly `2` is recommended: larger values do not enable additional Naru behavior and can allow unrelated agents to recurse further, increasing cost. Explicit integer values above `2` remain valid and are preserved.

### Global install

With no location flag, the target is `~/.config/opencode`. Markdown command and agent files are symlinked individually by default. Tools, helper modules, Naru Delegate, and the optional dashboard are always copied so executable plugin code cannot change merely because the source checkout changes.

```sh
./install.sh
```

Use `--copy` if command and agent Markdown should also be copied:

```sh
./install.sh --copy
```

### Project install

Run the installer from the project that should receive `.opencode` configuration. The Naru checkout can live elsewhere:

```sh
/path/to/naru-opencode/install.sh --project
```

`--project` targets `$PWD/.opencode`, where `$PWD` is the directory from which the installer is invoked.

When depth configuration is explicitly requested, project mode reads or creates `$PWD/opencode.jsonc` or `$PWD/opencode.json`, not a file under `.opencode`. OpenCode merges global configuration first and project configuration later, so a project top-level `subagent_depth` overrides the global value for that project.

### Custom config path

Use an absolute or relative custom directory:

```sh
./install.sh --dir /path/to/opencode-config
```

The source checkout and target cannot contain one another. The target and its managed loader directories must not be symlinks.

`--dir` identifies an installation/config root but cannot make OpenCode load that path. Use `--configure-subagent-depth` with `--dir` only when the same directory is actually part of your OpenCode configuration lookup.

### Optional flags

- `--copy` — copy command and agent Markdown instead of symlinking it.
- `--project` — install into `$PWD/.opencode`.
- `--dir PATH` — install into a custom OpenCode config directory.
- `--with-dashboard` — copy and register the optional TUI dashboard.
- `--configure-subagent-depth` — transactionally create or merge the applicable `opencode.jsonc` or `opencode.json`, setting an absent, `0`, or `1` top-level `subagent_depth` to `2` while preserving values of `2` or more.
- `--migrate-orchestrator` — back up legacy `agents/orchestrator.md`, `agents/minion`, and `plugins/orchestrator-dashboard.js` paths. Without this flag, those paths are untouched.

Without `--configure-subagent-depth`, the installer never changes either OpenCode config file; existing bytes remain untouched. With the flag, it refuses ambiguous `opencode.json` plus `opencode.jsonc`, symlinks, non-regular or oversized files, malformed JSON/JSONC, duplicate `subagent_depth` keys, non-object roots, and invalid depth values before replacing anything. Comments, CRLF, trailing commas, indentation, unrelated keys, and final-newline state are preserved. The prepared config participates in the normal staging, timestamped backup, and rollback transaction. The explicit flag is the authorization; there is no runtime prompt.

### Updating

After pulling a new Naru version, rerun the installer with the same location and dashboard flags:

```sh
git pull
./install.sh --with-dashboard
```

Even a symlink install must be rerun because tools, helpers, runtime/evaluation assets, and plugins are copy-pinned. A `--copy` install is entirely stale until reinstalled. Restart OpenCode after reinstalling or changing `subagent_depth` so active sessions reload routing, permissions, and delegation limits.

## Commands and primary agent

Naru exposes five Core commands and one optional dashboard command:

| Entry point | Purpose | Writes? |
| --- | --- | --- |
| `/naru-plan <target>` | Production-safe implementation plan | No |
| `/naru-impact <target>` | Blast-radius and risk analysis | No |
| `/naru-triage <symptom>` | Evidence-based bug diagnosis | No |
| `/naru-review <PR>` | Dry-run pull-request review | No |
| `/naru-review-post <PR>` | Validated, idempotent, comment-only review post | GitHub comment only |
| `/naru-minions` | Optional child-session activity view | No |

There are no `/naru/*` aliases. `/naru-review` does not accept `--post`. Use `/naru-review-post` for the dedicated command path, or select `naru-orchestrator` and explicitly ask it to post a review.

### Select `naru-orchestrator` for implementation

`naru-orchestrator` is a visible primary agent, not a slash command. Select it in the OpenCode UI when you want the Naru Minions implementation workflow or natural-language PR review posting. It coordinates investigation, architecture, implementation, debugging, verification, and judgment while remaining unable to edit files itself.

You can make it the OpenCode default in your applicable configuration:

```json
{
  "default_agent": "naru-orchestrator"
}
```

Or launch OpenCode with it for one invocation:

```sh
opencode --agent naru-orchestrator
```

Do not use `naru-orchestrator` as a Task target from custom agents. See the [agent integration guide](https://sean35mm.github.io/naru-opencode/agent-integration/) for supported read-only delegation.

For review-only language, the orchestrator runs one fresh canonical `naru-review` dry run and never posts. An explicit current request such as “post the review” authorizes one posting attempt without another confirmation. The target must be in that message or uniquely identified by prior user-authored PR context; ambiguous or missing targets stop for clarification. Every post request runs a fresh review, rejects stale, pasted, incomplete, or degraded results, and passes the validated result unchanged to the dedicated tool once. Mixed implementation or Git delivery completes first; the fresh review and post are the final phase.

Both posting paths normalize every accepted user-authored URL, `OWNER/REPO#NUMBER`, split, case-variant, or bare-number reference to one `(owner, repo, positive pull number)` tuple. A bare number is resolved once from the current workspace repository. Equivalent duplicates identify one target; unresolved references or multiple distinct targets stop, including the same number in different repositories or different numbers in one repository. The wrapper uses the route selected by its generated Naru Delegate policy, while the orchestrator review edge remains canonical-only.

### Conditional specialist coverage

Core workflows select specialists by relevant surface rather than launching every specialist. Plan always includes minimal-change and tests; Impact always includes topology and tests/CI; Triage always includes reproduction and codepath; Review always includes its judge and at least one relevant domain specialist. Selected specialists are required. Unselected specialists are recorded as `skipped-not-relevant`, are not retried, and do not degrade the final status. A failed selected specialist can produce a partial or incomplete result; review and review-post retain their immutable snapshot and validated posting boundaries.

### Full Ultra implementation scheduling

Full Ultra is the orchestrator's implementation scheduling protocol. A clean Git repository may use one detached Naru-owned worktree per writer, with six concurrent writers by default and up to ten when configured. Dirty or unsupported repositories automatically use at most two independent writers in the current workspace. It can also run up to four useful read-only preparation tasks. It proactively fills capacity with distinct useful work but does not invent irrelevant fan-out, claim complete runtime enforcement, or promise a measured speedup.

Every run, cohort, and item carries its baseline. Active-peer claims identify isolated writer scope. A writer's terminal result is provisional until its evidence remains valid; conflicting evidence, a changed baseline, scope uncertainty, or ownership uncertainty freezes and drains the cohort rather than starting more work.

After writers are finished, the candidate must be writer-free. The orchestrator may run up to two safe Verify shards, records a complete shard manifest, then asks Judge to assess the combined evidence and confirms an unchanged final checkpoint. Remediation, delivery, and review posting stay serialized. Todo status is phase-level presentation, while dashboard rows and Task descriptions report child activity; a terminal writer does not mean the overall implementation is complete.

### Adaptive read-only analysis modes

For implementation work, the orchestrator resolves one user preference or defaults to `auto`:

- `auto` proactively fills available read-only capacity with distinct useful lenses, refills from a useful deferred queue, and permits one justified best-of-2 comparison.
- `lean` selects at most one highest-value read-only worker and never uses best-of-2.
- `thorough` may use complementary relevant lenses and at most one best-of-2 pair within the normal caps; it does not launch every lens.
- `foreground` applies `auto` selection but waits for that analysis before proceeding.
- `off` disables only discretionary read-only analysis. Required Implement, final Verify, Judge, and canonical review work remain enabled.

These modes do not change authorization, model eligibility, edit ownership, verification, judgment, scheduler mode, or review posting. For a material task the orchestrator either uses a useful read-only worker or records one bounded reason: `mode-off`, `not-material`, `no-useful-independent-lens`, or `safety-blocked`.

### Optional Protocol 3 runtime

The scheduler is installed but defaults to `off`. To configure a project-local current workspace, copy the installed example to `.opencode/naru-runtime.json` and change only the required fields. Do not modify a global OpenCode configuration without explicit approval.

```sh
cp .opencode/naru-runtime.example.json .opencode/naru-runtime.json
```

The `scheduler.mode` values are:

- `off` — keep complete prompt-level Protocol 2 and retain no scheduler run or journal.
- `observe` — use Protocol 3 state and admission markers, but record typed incidents and fail open when runtime admission validation cannot be satisfied. Protocol 2 can be observed only when `legacyProtocol2` is explicitly `observe`.
- `enforce` — fail closed on incompatible capability, missing or invalid admission, replay, stale revision, claim conflict, expiry, or budget exhaustion. This mode requires `legacyProtocol2: "reject"` and refuses Protocol 2.

Protocol 3 uses strict manifests, compare-and-swap revisions, one-time admission and transition tokens, and correlated `evidence`, `terminal`, `candidate`, `shard`, `judgment`, and `gate` artifacts. Verification, judgment, and completion gates require the declared exact candidate and bounded coverage. Shared defaults are two writers, four read-only children, six total children, and three judge passes. Isolated writer budgets may raise writers to ten and total active children to fourteen. Other limits remain 256 work items, a 256 KiB manifest, 64 KiB artifacts, and five-minute token lifetimes. `maxArtifactBytes` may be configured only from 1 KiB through 256 KiB; runtime configuration itself is limited to 64 KiB and must be regular non-symlinked JSON.

The scheduler plugin intercepts the native Task `tool.execute.before` path; it does not replace Task or grant children scheduler authority. Only `naru-orchestrator` has the exact scheduler tool permission. Runtime state and its digest-linked journal are process-local, memory-only, non-durable, and bounded. Journal metadata redacts prompt, diff, path, directory, secret, token, authorization, command/output/content, and model-like fields; it retains at most 64 roots, 256 entries per root, and 4 KiB metadata per entry.

These gates are not a sandbox. The scheduler does not create sessions, inspect Git, capture or compare baselines, prove report truth, infer model routes, authoritatively observe background completion, coordinate another process, or impose provider/global hard caps. The separate root-only worktree tool performs narrowly validated Git isolation and integration and persists local run metadata for recovery after a process restart. Prompt-level authorization, routing, Weaver, scope containment, workspace ownership, freshness, and final-state checks remain required.

## Activity dashboard

Install the dashboard explicitly:

```sh
./install.sh --with-dashboard
```

The installer copies `plugins/naru-minions-dashboard.tsx` and its state helper, then safely updates the top-level `plugin` array in the active `tui.jsonc` or `tui.json`. It prefers an existing `tui.jsonc`, preserves unrelated content, rejects malformed or symlinked TUI configuration, removes exact legacy dashboard registrations from lower-precedence TUI files, and migrates the old dashboard JavaScript file.

In OpenCode's full terminal TUI, the dashboard provides:

- A compact **Naru Activity** section in the standard session sidebar, with conservatively bounded status, counts, task, routing, and overflow lines for up to four active or recently completed recognized Naru children for the current workflow root.
- `/naru-minions`, a compact fixed table-like `DialogSelect` of all recognized sibling child sessions. Its one-line primary row aligns status, agent, age, and task within a fixed bound; labeled secondary metadata shows route, mode, model, and a visible short session ID. Native filtering and keyboard behavior remain available, and selecting a row navigates with its full session ID.
- Status derived from native session and Task state, age since the latest child update, and foreground/background mode.
- Canonical agent name and a `Luna`, `Terra`, `Sol`, `Sol xhigh`, `Sol floor`, or neutral `Routed` classification.
- Provider, model, and variant from Task or child-message metadata. The UI shows `resolving` instead of guessing while metadata is unavailable.
- The delegated Task description. Unrelated OpenCode Task children are omitted.
- When a process-local scheduler run exists, a separate scheduler summary shows `OBSERVE` or `ENFORCE`, live/pending/blocked counts, local budget pressure, quality-gate progress, the oldest blocked item, and bounded evidenced actors. It is hidden when telemetry is absent and does not represent durable, cross-process, global, or provider state.

The persistent card appears only while the standard session sidebar is open. `opencode --mini` does not host full-TUI plugins, so neither the dashboard nor `/naru-minions` is available there. Dashboard files are copy-pinned: rerun the installer with `--with-dashboard` for every loaded copy and restart OpenCode after dashboard changes.

## Model profiles and overrides

Naru Delegate centrally routes all 35 canonical Naru agents while preserving OpenCode's native Task permissions, cancellation, retry, background-job, and child-session behavior.

Default profiles:

- **Luna:** `openai/gpt-5.6-luna-fast`, variant `high`.
- **Terra:** `openai/gpt-5.6-terra-fast`, variant `high`.
- **Sol:** `openai/gpt-5.6-sol-fast`, variant `high`.

Routing precedence for each canonical agent is:

1. An explicit exact-agent assignment parsed from `naru-models.json`.
2. An explicit built-in default assignment. Currently `naru-orchestrator` is assigned Sol.
3. Membership in the non-downgradeable Sol-floor role set.
4. Terra.

`naru-orchestrator` therefore uses `openai/gpt-5.6-sol-fast` with variant `high` by default, but it is not a Sol-floor role and may be overridden to Terra. True Sol-floor roles cannot be downgraded. A non-floor role assigned or overridden to Sol is invoked through its canonical name and receives no generated model aliases.

For each invocation of scout, investigate, implement, debug, or verify that resolves to Terra, the orchestrator can choose a generated `naru-delegate-luna-*` route, the canonical Terra role, or a generated `naru-delegate-sol-*` route. It selects the model whose strengths best fit the specific assignment by considering capability, task shape, ambiguity, context volume, consequences, tool and verification burden, latency, cost, and prior evidence together. It must not use fixed role mappings, keyword-only classification, cheapest-first routing, or a mandatory model sequence.

### How model selection works

Naru Delegate does not reason about task content. It applies model profiles to runtime agent definitions, creates exact hidden aliases, and appends the available routes and selection policy to dispatcher prompts. The default Sol-powered orchestrator reasons over the complete task packet and chooses a route independently for each invocation.

For example, an implementation minion assigned Terra exposes:

| Route | Model profile |
| --- | --- |
| `naru-delegate-luna-minion-implement` | Luna |
| `naru-minion-implement` | Terra |
| `naru-delegate-sol-minion-implement` | Sol |

The five Luna-eligible minions produce five Luna aliases. All adaptively routed delegable non-floor roles assigned Terra produce Sol alternatives, currently seventeen aliases. Sol-floor roles and explicit Sol assignments are invoked canonically and receive no generated alternatives. The orchestrator's dedicated `naru-review` edge is canonical-only and does not authorize Luna, Sol, or Sol-xhigh review aliases. The aliases are internal runtime details: do not invoke them from custom agents or persist them in integrations.

Naru also creates seven hidden `naru-delegate-sol-xhigh-*` aliases, one for each direct `naru-orchestrator` minion child. They are optional, never required, and are gated by the actual root session: only a direct `naru-orchestrator` root using the configured Sol model at `xhigh` or `max` may invoke them. A normal Sol `high` root cannot use xhigh, and no Max child alias exists. Reinstall all copy-pinned Naru components (including `--with-dashboard` where used) and restart OpenCode before expecting the `Sol xhigh` dashboard label or routes.

Model choice is not a one-way escalation ladder. The orchestrator may start with Sol, choose Luna when speed and capability fit the assignment, retain Terra for balanced work, or reassess to any available profile after incomplete, conflicting, context-limited, or low-confidence evidence.

### Configure `naru-models.json`

Create `naru-models.json` beside the installed `commands/`, `agents/`, `tools/`, and `plugins/` directories. Naru never creates, overwrites, or migrates this file.

To keep the default models but run the orchestrator on Terra:

```json
{
  "schemaVersion": 2,
  "agents": {
    "naru-orchestrator": "terra"
  }
}
```

To replace profiles and sparsely assign another non-floor role to Sol:

```json
{
  "schemaVersion": 2,
  "profiles": {
    "luna": {
      "model": "provider/luna-equivalent",
      "variant": "high"
    },
    "terra": {
      "model": "provider/terra-equivalent",
      "variant": "high"
    },
    "sol": {
      "model": "provider/sol-equivalent",
      "variant": "high"
    }
  },
  "agents": {
    "naru-minion-implement": "sol"
  }
}
```

Schema-v2 profile names are exactly `luna`, `terra`, and `sol`; static agent values are exactly `terra` or `sol`; agent keys must be canonical Naru IDs. Luna cannot be assigned statically because it is a per-invocation orchestrator choice. Profile models use `provider/model` format, and `variant` is optional. The file must be a regular, non-symlinked file no larger than 64 KiB.

Schema-v1 files remain valid. Naru normalizes `profiles.fast` to Terra, `profiles.deep` to Sol, and matching `fast|deep` agent values to `terra|sol` before scopes merge. The v2 plugin also maintains a v1 projection so a stale scope preserves Terra/Sol policy, but a stale plugin cannot generate Luna routes. Reinstall every global and project Naru copy, repeat `--with-dashboard` where previously used, and restart OpenCode before adopting schema v2.

| Schema v1 | Schema v2 |
| --- | --- |
| `profiles.fast` | `profiles.terra` |
| `profiles.deep` | `profiles.sol` |
| Agent value `fast` | Agent value `terra` |
| Agent value `deep` | Agent value `sol` |

There is no v1 equivalent for `profiles.luna`. Luna routes appear only when a v2 plugin is active.

When both global and project Naru Delegate plugins load, sparse profiles and exact-agent assignments merge in OpenCode load order. Later values replace matching earlier values without resetting unrelated values. An invalid later configuration disables dynamic routing for that startup, removes generated routes, and restores original agent definitions.

`agents/naru-minion-implement.md` retains a Terra High frontmatter pin only as an upgrade fallback for installations whose copy-pinned routing plugin has not been refreshed. Do not add a model pin to `naru-orchestrator`; central routing is authoritative.

## Migration and manual install

### Automatic migration

The installer moves old nested Core loader paths `commands/naru`, `agents/naru`, and old `naru.bak.*` backups out of scanned directories into a timestamped backup under the target's `.naru-backups/` directory.

Legacy general-orchestrator paths are migrated only with `--migrate-orchestrator`. The dashboard's old `plugins/naru-minions-dashboard.js` file and exact registration are migrated when `--with-dashboard` is used.

### Manual install

Back up and remove old `commands/naru` and `agents/naru` directories first, or OpenCode will load both old nested IDs and current flat IDs. Copy the current files into the applicable global or project config root:

```sh
mkdir -p ~/.config/opencode/commands ~/.config/opencode/agents
mkdir -p ~/.config/opencode/tools ~/.config/opencode/plugins
cp commands/naru-*.md ~/.config/opencode/commands/
cp agents/naru-*.md ~/.config/opencode/agents/
cp tools/naru-git-read.js tools/naru-github-read.js tools/naru-github-post-review.js ~/.config/opencode/tools/
cp -R tools/naru-lib ~/.config/opencode/tools/
cp plugins/naru-delegate.js ~/.config/opencode/plugins/
```

For a project install, use `.opencode` in place of `~/.config/opencode`.

To include the optional runtime and local evaluation assets in a manual install, also copy the scheduler tool/plugin, the complete current `tools/naru-lib` directory, the runtime example, evaluation script, and sanitized fixture while preserving their relative paths. Copy the example to `naru-runtime.json` only when intentionally enabling a mode.

For a manual dashboard install, also copy both dashboard files and add `"./plugins/naru-minions-dashboard.tsx"` to the top-level `plugin` array in the active `tui.jsonc` or `tui.json`. Remove the old dashboard JS file and its exact registrations from every active TUI config before registering the TSX plugin. Restart OpenCode after a manual install.

## Complete safety model

### Read-only Core and scoped implementation

- Core planning, impact, triage, and dry-run review workflows do not edit files, install dependencies, execute project code, run tests, run migrations, commit, push, or open pull requests.
- `naru-orchestrator` is the primary implementation coordinator but does not edit directly. Only `naru-minion-implement` can make scoped edits within an approved packet.
- Scout, Investigate, Architect, and Judge are technically read-only static-analysis roles. Debug and Verify are technically read-only but can run targeted Bash checks. Implement is the only scoped edit/shell role. No minion can delegate with Task.
- Generated Luna, Sol, and Sol-xhigh aliases clone the exact permission map of their canonical source role. Selecting a route never strengthens permissions.

### Role-specific minion permissions

- All minion maps are fail-closed and deny environment and secret file reads; example environment templates remain allowed and may be inspected.
- Debug, Verify, and Implement allow Bash and `external_directory` for routine Git/GitHub reads, Weaver, targeted lint/typecheck/test commands, and ordinary local builds. For those shell-enabled roles, `external_directory` is explicitly `allow` and these operations are unconditionally allowed at runtime; Scout, Investigate, Architect, and Judge cannot run shell or project commands.
- Checks execute repository code and can have hidden side effects. Inspect the relevant manifest or Makefile target before every package script or target; use one routine command per shell call. Permission matching does not validate executable identity through `PATH`.
- A scoped implementation request authorizes local edits and targeted routine verification without another approval question. Local changes are the default stopping point. If the user explicitly requests commit, push, or PR delivery, perform that requested delivery without reconfirmation; do not perform unrequested delivery.
- An explicit `/naru-review-post` invocation, or an explicit current natural-language post request to the selected orchestrator, authorizes one validated GitHub review posting call without reconfirmation; it does not authorize any other GitHub posting.
- Persistent database writes or migration execution, dependency changes not explicitly requested, destructive or irreversible work, external global configuration outside an exact approved path, billing/security-posture changes, and material scope expansion still require the applicable approval boundary.

### Permission limitations

- Shell-enabled role permissions are intentionally permissive, not a sandbox. They do not inspect script behavior or prevent package scripts and targets from changing Git, files, databases, or external state.
- Direct reads deny known secret patterns, but permission policy is not a complete secret sandbox. Prompt guidance also forbids reading or revealing secrets; trust the selected provider, model, and installed tools as you would any code with repository access.

### GitHub posting boundary

- Validated Naru tools invoke authenticated `gh` without exposing a general shell surface.
- `/naru-review` is dry-run only.
- `/naru-review-post` and the selected `naru-orchestrator` can each post at most one `COMMENT` review per explicit request, always after a fresh complete review. Identical reruns return `alreadyPosted`; degraded reviews are never posted. Arbitrary and custom agents remain dry-run-only. The tool cannot approve, request changes, merge, or create an ordinary issue comment.

### Auto mode

OpenCode auto mode automatically approves only configured `doom_loop` asks. Environment-file and secret reads remain denied. Allowed shell and external-directory access already run without prompting for Debug, Verify, and Implement. The validated review-posting boundary remains in force. Neither auto mode nor permissive runtime access makes repository code, package scripts, targets, secret access, or database-connected commands safe.

### Permission layers and native Task

Global and project OpenCode configuration can each contribute root-agent and delegated-session policy. Check all four effective contexts after combining installs: root/global, root/project, delegated/global, and delegated/project. In every context, only `naru-orchestrator` should have the exact `naru-scheduler` and `naru-worktree` permissions; minions and custom callers must not. Naru still delegates through native Task; isolated packets bind each writer to an exact external worktree path.

## Local evaluation

The installed evaluator deterministically scores supplied, sanitized captured summaries against bounded budgets and rubrics:

```sh
node scripts/naru-live-eval.mjs --manifest tests/fixtures/live-evals.json --dry-run
```

From an installed config root, use the copy-pinned sample at `scripts/live-evals.example.json` instead. The manifest is limited to 256 KiB and 128 cases; each captured journal is limited to 128 entries and must omit prompts, code, diffs, raw source/patch fields, credentials, and tokens. The output is a local dry-run score plan. Despite the script name, there is no live provider/session execution, capture API, upload, or cloud evaluation path; invoking it without `--dry-run` is rejected.

## What Naru does not manage

Naru does not modify your personal `AGENTS.md`, optional `naru-models.json` or `naru-runtime.json`, unrelated OpenCode tools or plugins, or external agent-state systems. By default it also never modifies `opencode.json` or `opencode.jsonc`; only the explicit `--configure-subagent-depth` flag authorizes the bounded transactional merge described above.

## Troubleshooting

### Commands or agents are stale

Rerun `install.sh` after every update. Plugins, tools, and helpers are copy-pinned even when Markdown is symlinked. Restart OpenCode after reinstalling.

### A Naru child fails at the subagent depth limit

Confirm OpenCode is 1.18.4 or newer and inspect the effective top-level `subagent_depth` after global and project precedence is applied. It must be an integer of at least `2`; exactly `2` is recommended. Run the installer for the loaded scope with `--configure-subagent-depth`, or update the applicable config manually, then restart OpenCode. In project mode the file is `opencode.jsonc` or `opencode.json` in the project root, not `.opencode`. For `--dir`, first verify OpenCode actually loads that path. If both JSON and JSONC files exist, remove the ambiguity deliberately before rerunning the installer.

### Duplicate or unexpected agent IDs appear

Remove or migrate old nested `commands/naru` and `agents/naru` loader directories. They can coexist with flat current files after a manual upgrade and cause duplicate definitions.

### Routing is disabled

Inspect the `naru-delegate` startup error. Confirm `naru-models.json` is valid schema-v1 or schema-v2 JSON, uses only supported keys and canonical agent IDs, does not downgrade a Sol-floor role, is a regular non-symlinked file, and is at most 64 KiB. An invalid later scope disables dynamic routing for that startup rather than applying a partial policy.

### The orchestrator uses an unexpected model

Check every loaded global and project `naru-models.json` in plugin load order. An explicit `agents.naru-orchestrator` value wins over its built-in Sol assignment. Also rerun the installer so the copy-pinned Naru Delegate plugin and routing helper match the Markdown agents.

### A Luna route is missing

Luna routes exist only for scout, investigate, implement, debug, and verify while the canonical role resolves to Terra. An explicit Sol assignment removes both generated alternatives. If an eligible Terra role still has no Luna route, update OpenCode to at least 1.18.4, reinstall every loaded Naru copy, and restart OpenCode. A stale schema-v1 plugin can preserve Terra/Sol policy but cannot generate Luna aliases.

### A minion still asks before Git, Weaver, Python, or another shell command

Only Debug, Verify, and Implement have Bash and external-directory allows. Rerun the installer with the same location and `--with-dashboard` flags, restart OpenCode, and inspect the intended role. Scout, Investigate, Architect, and Judge correctly deny shell commands. Environment-file reads are denied. Repeated identical calls can prompt only through configured `doom_loop`, not Bash.

### Review commands cannot resolve a pull request

Authenticate `gh` and provide a full PR URL or `OWNER/REPO#NUMBER`. A bare PR number requires the current workspace to resolve to the intended GitHub repository.

After updating Naru review-posting behavior, rerun the installer for every loaded copy and restart OpenCode. Tools, plugins, and routing helpers are copy-pinned even when Markdown is symlinked.

### The dashboard is missing

Reinstall with `--with-dashboard`, verify the TSX plugin is registered in the active TUI config, restart OpenCode, and use the full terminal TUI with the standard sidebar open. The dashboard does not run under `--mini`.

### Scheduler telemetry is missing

Telemetry appears only for a scheduler run in the same OpenCode process. Confirm `naru-runtime.json` selects `observe` or `enforce`, the scheduler and dashboard were both reinstalled, OpenCode was restarted, and a Protocol 3 run was created. A run in another process or a default-off session is intentionally invisible.

### Dashboard installation rejects TUI configuration

Fix malformed JSON/JSONC or replace a symlinked TUI configuration with a regular file. The installer refuses to rewrite malformed or symlinked configuration rather than risking unrelated settings.
