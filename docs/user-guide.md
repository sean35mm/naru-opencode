---
title: Naru user guide
description: Detailed installation, operation, routing, dashboard, and safety reference.
---

# Naru user guide

This guide covers installation, day-to-day use, model routing, the optional dashboard, upgrades, migration, troubleshooting, and Naru's safety boundaries.

## Requirements

- [OpenCode](https://opencode.ai) >= 1.18.4.
- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated, for pull-request review workflows.
- Node.js or Bun for the safe install preview, ownership manifest, configuration merges, and local doctor.
- `codebase-memory` and LSP support are optional. Read-only workflows fall back to literal file search when they are unavailable or stale.

## Install and update

Clone Naru, preview the safe default install, and apply the same option set:

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
./install.sh
./install.sh --apply
```

Without `--apply`, the installer prints a bounded preview and does not create or remove anything under the target. An apply preflights and stages changed assets before replacement, writes a deterministic schema-v1 `.naru-install.json` ownership manifest, and skips matching assets. Replaced content is retained in a timestamped `.naru-backups/` directory and restored if that transaction fails. It copies the scheduler tool/plugin, doctor, runtime libraries, `naru-runtime.example.json`, and local evaluation script/fixture, but does not create an active runtime configuration or enable scheduling.

The manifest records exact managed roots, source fingerprints, selected options, source version, location mode, and copy/symlink method. If a current managed path is unowned or differs from its last recorded installed fingerprint, apply preserves it and stops. Only a reviewed apply with `--replace-conflicts` replaces and backs up those conflicts. Unrelated files and previously owned paths omitted by a later option set remain untouched.

Naru is compatible with OpenCode's default depth of `1`: the selected orchestrator delegates only to its seven minions. `--configure-subagent-depth` remains accepted as a deprecated no-op for migration compatibility; do not use it in new setup commands.

### Global install

With no location flag, the target is `~/.config/opencode`. Markdown command and agent files are symlinked individually by default. Tools, helper modules, Naru Delegate, and the optional dashboard are always copied so executable plugin code cannot change merely because the source checkout changes.

```sh
./install.sh --apply
```

Use `--copy` if skill and agent Markdown should also be copied:

```sh
./install.sh --apply --copy
```

### Project install

Run the installer from the project that should receive `.opencode` configuration. The Naru checkout can live elsewhere:

```sh
/path/to/naru-opencode/install.sh --apply --project
```

`--project` targets `$PWD/.opencode`, where `$PWD` is the directory from which the installer is invoked.

Project mode installs into `$PWD/.opencode`; OpenCode loads project configuration after global configuration.

### Custom config path

Use an absolute or relative custom directory:

```sh
./install.sh --apply --dir /path/to/opencode-config
```

The source checkout and target cannot contain one another. The target and its managed loader directories must not be symlinks.

`--dir` identifies an installation/config root but cannot make OpenCode load that path.

### Optional flags

- `--preview` — explicitly select the default read-only preview behavior.
- `--apply` — apply the reviewed option set transactionally.
- `--replace-conflicts` — replace or remove only the conflicts shown by that exact install, rollback, or uninstall preview. Without it, install/rollback conflicts block mutation and uninstall preserves modified paths.
- `--copy` — copy skill and agent Markdown instead of symlinking it.
- `--project` — install into `$PWD/.opencode`.
- `--dir PATH` — install into a custom OpenCode config directory.
- `--with-dashboard` — copy and register the optional TUI dashboard.
- `--configure-subagent-depth` — deprecated accepted no-op for migration compatibility.
- `--migrate-orchestrator` — back up legacy `agents/orchestrator.md`, `agents/minion`, and `plugins/orchestrator-dashboard.js` paths. Without this flag, those paths are untouched.
- `--rollback BACKUP_ID` — preview restoration of one explicit receipt-backed transaction. It never guesses the latest backup.
- `--uninstall` — preview removal of manifest-owned assets. Modified assets are preserved by default.
- `--confirm-rollback TOKEN` / `--confirm-uninstall TOKEN` — with `--apply`, require the exact SHA-256 token from the current matching lifecycle preview.

The installer does not change OpenCode depth configuration. The deprecated depth flag is accepted only so older scripts can migrate safely.

Backups are created lazily when install replaces a path. Successful replacement backups also contain a bounded `.naru-transaction.json` receipt; no-op and ordinary first installs still create no backup. Rollback and uninstall move their removed or replaced paths into a new timestamped receipt-backed backup. All backups are retained indefinitely, never consumed by rollback, and never pruned automatically.

Preview a successful transaction by its exact backup directory name, then copy the printed token into an unchanged apply:

```sh
./install.sh --rollback 20260722123456-12345
./install.sh --rollback 20260722123456-12345 --apply \
  --confirm-rollback 'sha256:copy-the-current-preview-token'

./install.sh --uninstall
./install.sh --uninstall --apply \
  --confirm-uninstall 'sha256:copy-the-current-preview-token'
```

Add the same `--project` or `--dir PATH` selector used for installation. Install-only flags such as `--copy`, `--with-dashboard`, and `--configure-subagent-depth` are rejected in lifecycle mode; the manifest supplies the location and method metadata. The confirmation token is bound to the canonical target, action, current manifest, selected receipt, conflict choice, and complete classified plan, so a stale or differently scoped token fails before mutation.

Rollback refuses a modified current path by default and remains atomic; preview again with `--replace-conflicts` only after reviewing the bounded conflict list. Uninstall removes only healthy owned paths by default. If a managed path was changed after installation, uninstall preserves it and keeps `.naru-install.json`, yielding a partial uninstall. A new `--replace-conflicts` preview explicitly selects those modified owned paths for removal and emits a different token. Missing paths are treated as already absent. Unrelated files, parent directories, and `.naru-backups/` are not removed.

Receipts and fingerprints are size- and count-bounded, require contained normalized paths, and reject symlinked or malformed metadata. Backup directories created before receipt support are not inferred and cannot be selected for rollback. User-triggered rollback covers only exact manifest-owned assets plus `.naru-install.json`; it does not reverse OpenCode depth configuration, TUI registration, or legacy migrations. Symlink rollback restores the recorded link itself but cannot rewind content in the source checkout. Automatic rollback still covers an active failed transaction, including a failed lifecycle apply.

### Updating

After pulling a new Naru version, rerun the installer with the same location and dashboard flags:

```sh
git pull
./install.sh --with-dashboard
./install.sh --apply --with-dashboard
```

The first post-pull command previews source-generation and managed changes; the second applies them. Reinstall every loaded global and project scope so healthy manifest-owned legacy definitions are retired. Modified or unowned paths are preserved, reported, and backed up only when the reviewed preview explicitly replaces them. Even a symlink install must be rerun because tools, helpers, runtime/evaluation assets, and plugins are copy-pinned. Restart OpenCode after an applied update so active sessions reload skills, permissions, and routing.

### Native installed skills

Naru installs four native skills: `naru-plan`, `naru-impact`, `naru-triage`, and `naru-review`. Ask naturally for the activity or say “Use the `naru-plan` skill…” OpenCode discovers loaded skills on demand. Skill contents remain untrusted guidance rather than authorization: they cannot alter the receiving role, tools, scope, safety rules, or output contract. A skill does not grant tools or make the receiving agent read-only.

OpenCode determines which global and project skill sources are visible, their precedence, and how duplicate names resolve. Inspect a skill's origin before trusting it; duplicate or same-named copies may be ambiguous or shadowed by another loaded scope. Installing Naru updates only its managed skill and agent definitions. It neither edits global non-Naru agents nor grants them skill access. After a Naru update, preview and apply the installer for every loaded global/project copy—even for symlink installs—and restart OpenCode.

### Read-only local doctor

Run the copy-pinned doctor directly; it does not invoke `opencode debug config`, load Naru plugins, inspect credentials, call a provider, mutate files, or upload data:

```sh
# Global install
node ~/.config/opencode/tools/naru-doctor.js

# Project install
node .opencode/tools/naru-doctor.js --project-root .

# Custom install
node /path/to/opencode-config/tools/naru-doctor.js --dir /path/to/opencode-config
```

The bounded, path-sanitized report covers candidate global/project/custom scopes, manifest version and install mode, missing or modified assets, stale copy-pinned and mixed-generation state, local OpenCode/runtime compatibility, routing/runtime configuration state, and dashboard installation/registration. Arbitrary custom loading cannot be proven, so custom scope is explicitly reported as unconfirmed. Use `--source PATH` to compare a copy-only install with a checkout and `--json` for the equivalent structured report. A warning report exits nonzero for automation without changing state.

## Skills and primary agent

Naru's current analysis surface is four on-demand native skills:

| Skill | Natural request | Default behavior |
| --- | --- | --- |
| `naru-plan` | Ask for a plan or implementation approach | Advisory planning |
| `naru-impact` | Ask for blast-radius or compatibility analysis | Advisory impact analysis |
| `naru-triage` | Ask to diagnose a bug or failure | Advisory diagnosis |
| `naru-review` | Ask for a PR, branch, diff, or file review | Dry-run review |

The five retired `/naru-*` Core slash commands are not current entry points. `/naru-minions` remains the optional dashboard command.

### Select `naru-orchestrator` for implementation

`naru-orchestrator` is a visible primary agent, not a slash command. Select it in the OpenCode UI when you want the Naru Minions implementation workflow or natural-language PR review posting. It coordinates its seven minions—Scout, Investigate, Architect, Implement, Debug, Verify, and Judge—while remaining unable to edit files itself. Adaptive lenses are optional and selected only when useful.

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

Do not use `naru-orchestrator` as a Task target from custom agents. See the [agent integration guide](https://sean35mm.github.io/naru-opencode/agent-integration/) for supported skill guidance.

For review-only language, the orchestrator performs a dry run and never posts. Only a current explicit request such as “post the review” to the directly selected orchestrator authorizes one posting attempt. The target must be in that message or uniquely identified by prior user-authored PR context; ambiguous or missing targets stop for clarification. Every post request runs a fresh review, rejects stale, pasted, incomplete, or degraded results, and passes the validated result unchanged to the dedicated tool once. Before POST, the tool rechecks a fresh final snapshot, head, feedback digest, inline locations, and existing marker. Same-target calls are deduplicated within one process; cross-process deduplication requires durable external coordination, and ambiguous outcomes are never retried. Custom agents cannot post. Mixed implementation or Git delivery completes first; the fresh review and post are the final phase.

The posting path normalizes every accepted user-authored URL, `OWNER/REPO#NUMBER`, split, case-variant, or bare-number reference to one `(owner, repo, positive pull number)` tuple. A bare number is resolved once from the current workspace repository. Equivalent duplicates identify one target; unresolved references or multiple distinct targets stop, including the same number in different repositories or different numbers in one repository.

### Adaptive analysis

Skills and the selected orchestrator may use zero, one, or multiple independent lenses when useful. They do not require specialist fan-out, a judge, retries, status bookkeeping, or fixed workflow phases. Review retains its fresh-snapshot and validated posting boundaries.

An explicit user request for a concrete number of independent or competing analyses overrides the default relevance and best-of-2 limits. For example, asking the selected orchestrator for 50 competing analyses may produce 50 fresh direct read-only child sessions concurrently, followed by synthesis of all terminal reports. The depth setting limits child-of-child nesting; it does not cap direct orchestrator breadth. Safety, provider availability, and configured hard protocol limits still apply and are reported rather than silently reducing the request.

### Full Ultra implementation scheduling

Full Ultra is Naru's parallel implementation protocol. Automatic runs use one combined ten-child pool for read-only and writer children. Same-workspace mode may use up to ten independent writers when the scheduler finds no overlapping paths, mutable contracts, generated artifacts, configuration, lockfiles, or mutable resources and every writer acquires all exact Weaver claims before editing. A conflict produces a zero-edit blocked report and serialized fallback. Clean isolated mode may place one writer in each Naru-owned worktree. A current explicit user request may raise combined concurrency to fifty; more than ten simultaneous writers requires isolated mode. Scheduler budget fields are hard ceilings, and Naru does not invent irrelevant fan-out, claim complete runtime enforcement, or promise a measured speedup.

Every run, cohort, and item carries its baseline. Active-peer claims identify isolated writer scope. A writer's terminal result is provisional until its evidence remains valid; conflicting evidence, a changed baseline, scope uncertainty, or ownership uncertainty freezes and drains the cohort rather than starting more work.

After writers are finished, the candidate must be writer-free. The orchestrator may run safe Verify shards within the run's read-only and combined budgets, records a complete shard manifest, then asks Judge to assess the combined evidence and confirms an unchanged final checkpoint. Remediation, delivery, and review posting stay serialized. Todo status is phase-level presentation, while dashboard rows and Task descriptions report child activity; a terminal writer does not mean the overall implementation is complete.

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

Protocol 3 uses strict manifests, compare-and-swap revisions, one-time admission and transition tokens, and correlated `evidence`, `terminal`, `candidate`, `shard`, `judgment`, and `gate` artifacts. Verification, judgment, and completion gates require the declared exact candidate and bounded coverage. Automatic runs explicitly request ten writer, ten read-only, and ten combined slots, so the combined pool controls actual concurrency. Runtime scheduler ceilings default to fifty for each lane and the combined pool, allowing a current explicit user request to raise the run budget up to fifty. Same-workspace writers remain capped at ten by orchestrator policy; higher writer counts require isolated worktrees. Other limits remain 256 work items, a 256 KiB manifest, 64 KiB artifacts, and five-minute token lifetimes. `maxArtifactBytes` may be configured only from 1 KiB through 256 KiB; runtime configuration itself is limited to 64 KiB and must be regular non-symlinked JSON.

The scheduler plugin intercepts the native Task `tool.execute.before` path; it does not replace Task or grant children scheduler authority. Only `naru-orchestrator` has the exact scheduler tool permission. Runtime state and its digest-linked journal are process-local, memory-only, non-durable, and bounded. Journal metadata redacts prompt, diff, path, directory, secret, token, authorization, command/output/content, and model-like fields; it retains at most 64 roots, 256 entries per root, and 4 KiB metadata per entry.

These gates are not a sandbox. The scheduler does not create sessions, inspect Git, capture or compare baselines, prove report truth, infer model routes, authoritatively observe background completion, coordinate another process, or impose provider/global hard caps. The separate root-orchestrator-only worktree tool performs narrowly validated Git isolation and integration: tool-owned Git operations suppress hooks, mutations are serialized per run, paths are contained, recovery metadata is written atomically, and failures attempt rollback. It can recover a run after a process restart, but it does not protect against unrelated external workspace mutation. Prompt-level authorization, routing, Weaver, scope containment, workspace ownership, freshness, and final-state checks remain required.

## Activity dashboard

Install the dashboard explicitly:

```sh
./install.sh --apply --with-dashboard
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

Naru Delegate centrally routes the eight canonical Naru agents while preserving OpenCode's native Task permissions, cancellation, retry, background-job, and child-session behavior.

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

Generated aliases are internal runtime details: do not invoke them from custom agents or persist them in integrations.

Reinstall all copy-pinned Naru components (including `--with-dashboard` where used) and restart OpenCode after routing updates.

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

On reinstall, the installer retires healthy manifest-owned legacy command and workflow-agent definitions from every loaded global/project scope. The preview reports modified or unowned paths and preserves them unless the reviewed operation explicitly replaces them; backups are created for replaced paths. The dashboard's old `plugins/naru-minions-dashboard.js` file and exact registration are migrated when `--with-dashboard` is used.

### Manual install

Back up old definitions before a manual migration, then copy the current skills and agents into the applicable global or project config root:

```sh
mkdir -p ~/.config/opencode/skills ~/.config/opencode/agents
mkdir -p ~/.config/opencode/tools ~/.config/opencode/plugins
cp -R skills/naru-* ~/.config/opencode/skills/
cp agents/naru-*.md ~/.config/opencode/agents/
cp tools/naru-git-read.js tools/naru-github-read.js tools/naru-github-post-review.js tools/naru-doctor.js tools/package.json ~/.config/opencode/tools/
cp -R tools/naru-lib ~/.config/opencode/tools/
cp plugins/naru-delegate.js ~/.config/opencode/plugins/
```

For a project install, use `.opencode` in place of `~/.config/opencode`. Manual installs do not have a generated ownership manifest, so the doctor reports their lifecycle state as untracked; use the installer for preview, fingerprints, no-op updates, and conflict preservation.

To include the optional runtime and local evaluation assets in a manual install, also copy the scheduler tool/plugin, the complete current `tools/naru-lib` directory, the runtime example, evaluation script, and sanitized fixture while preserving their relative paths. Copy the example to `naru-runtime.json` only when intentionally enabling a mode.

For a manual dashboard install, also copy both dashboard files and add `"./plugins/naru-minions-dashboard.tsx"` to the top-level `plugin` array in the active `tui.jsonc` or `tui.json`. Remove the old dashboard JS file and its exact registrations from every active TUI config before registering the TSX plugin. Restart OpenCode after a manual install.

## Complete safety model

### Skills and scoped implementation

- The four Naru skills provide guidance only; they do not grant tools, enforce read-only behavior, or authorize edits, commands, delivery, or any other action.
- `naru-orchestrator` is the primary implementation coordinator but does not edit directly. Only `naru-minion-implement` can make scoped edits within an approved packet.
- Scout, Investigate, Architect, and Judge are technically read-only static-analysis roles. Debug and Verify are technically read-only but can run targeted Bash checks. Implement is the only scoped edit/shell role. No minion can delegate with Task.
- Generated Luna, Sol, and Sol-xhigh aliases clone the exact permission map of their canonical source role. Selecting a route never strengthens permissions.
- Approval-free native skill loading changes discovery only. Skill guidance cannot authorize an action or bypass any role, tool, scope, secret, destructive, paid, or delivery boundary.

### Role-specific minion permissions

- All minion maps are fail-closed and deny environment and secret file reads; example environment templates remain allowed and may be inspected.
- Debug, Verify, and Implement allow Bash and `external_directory` for routine Git/GitHub reads, Weaver, targeted lint/typecheck/test commands, and ordinary local builds. For those shell-enabled roles, `external_directory` is explicitly `allow` and these operations are unconditionally allowed at runtime; Scout, Investigate, Architect, and Judge cannot run shell or project commands.
- Checks execute repository code and can have hidden side effects. Inspect the relevant manifest or Makefile target before every package script or target; use one routine command per shell call. Permission matching does not validate executable identity through `PATH`.
- A scoped implementation request authorizes local edits and targeted routine verification without another approval question. Local changes are the default stopping point. If the user explicitly requests commit, push, or PR delivery, perform that requested delivery without reconfirmation; do not perform unrequested delivery.
- An explicit current natural-language post request to the directly selected orchestrator authorizes one validated GitHub review posting call without reconfirmation; it does not authorize any other GitHub posting.
- Persistent database writes or migration execution, dependency changes not explicitly requested, destructive or irreversible work, external global configuration outside an exact approved path, billing/security-posture changes, and material scope expansion still require the applicable approval boundary.

### Permission limitations

- Shell-enabled role permissions are intentionally permissive, not a sandbox. They do not inspect script behavior or prevent package scripts and targets from changing Git, files, databases, or external state.
- Direct reads deny known secret patterns, but permission policy is not a complete secret sandbox. Prompt guidance also forbids reading or revealing secrets; trust the selected provider, model, and installed tools as you would any code with repository access.

### GitHub posting boundary

- Validated Naru tools invoke authenticated `gh` without exposing a general shell surface.
- Review is dry-run by default. Only the directly selected `naru-orchestrator` can post at most one `COMMENT` review for an explicit current request, always after a fresh complete review. Identical reruns return `alreadyPosted`; degraded reviews are never posted. Arbitrary and custom agents remain dry-run-only. The tool cannot approve, request changes, merge, or create an ordinary issue comment.

### Auto mode

OpenCode auto mode automatically approves only configured `doom_loop` asks. Environment-file and secret reads remain denied. Allowed shell and external-directory access already run without prompting for Debug, Verify, and Implement. The validated review-posting boundary remains in force. Neither auto mode nor permissive runtime access makes repository code, package scripts, targets, secret access, or database-connected commands safe.

### Permission layers and native Task

Global and project OpenCode configuration can each contribute root-agent and delegated-session policy. Check all four effective contexts after combining installs: root/global, root/project, delegated/global, and delegated/project. In every context, only `naru-orchestrator` should have the exact `naru-scheduler` and `naru-worktree` permissions; minions and custom callers must not. Naru still delegates through native Task; isolated packets bind each writer to an exact external worktree path.

## Local evaluation

The installed evaluator deterministically scores supplied, sanitized captured summaries against bounded budgets and rubrics:

```sh
node scripts/naru-live-eval.mjs --manifest tests/fixtures/live-evals.json --dry-run
```

From an installed config root, use the copy-pinned sample at `scripts/live-evals.example.json` instead. The manifest is limited to 256 KiB and 128 cases; each captured journal is limited to 128 entries and must omit prompts, code, diffs, raw source/patch fields, credentials, and tokens. The output is a local dry-run score plan, and dry-run remains free. The separately gated `--live` form requires exact reviewed confirmations for the contract, fixtures, provider, model, repetitions, timeouts, and spend. The current local adapter intentionally fails closed before starting OpenCode or making a provider request because runtime-byte binding and provider-enforced budgets are unavailable. Its output remains sanitized and bounded; it does not upload artifacts or claim a benchmark or live pilot ran.

## What Naru does not manage

Naru does not modify your personal `AGENTS.md`, optional `naru-models.json` or `naru-runtime.json`, unrelated OpenCode tools or plugins, or external agent-state systems. Preview is the installer default. An applied install modifies only its reviewed managed set; the deprecated depth flag does not change OpenCode configuration.

## Troubleshooting

### Commands or agents are stale

Run the installed doctor with `--source /path/to/naru-opencode` to identify stale copy-pinned or mixed-generation state. Preview `install.sh` with the original options, review any conflicts, then repeat with `--apply`. Plugins, tools, and helpers are copy-pinned even when Markdown is symlinked. Restart OpenCode after an applied update.

If native skill loading is missing, reinstall every loaded Naru scope rather than editing a global non-Naru agent. Confirm the selected skill's origin when duplicate global/project names exist, then restart OpenCode so a new session loads the updated Naru agent definition.

### A Naru child fails at the subagent depth limit

Confirm OpenCode is 1.18.4 or newer and reinstall the loaded Naru scope, then restart OpenCode. Naru's current orchestrator-to-minion design is depth-1-compatible; the deprecated `--configure-subagent-depth` flag does not change configuration.

### Installer reports a managed conflict

`conflict-unowned` means a selected path exists but is absent from the prior ownership manifest. `conflict-modified` means a manifest-owned path changed after installation. Both are preserved and block apply. Inspect the relative paths and keep or move any user work; only add `--replace-conflicts` to the same reviewed `--apply` when replacing and backing up those exact paths is intended.

### Duplicate or unexpected agent IDs appear

Reinstall every loaded global/project scope and review the preview. Healthy manifest-owned legacy definitions are retired; modified or unowned paths are preserved and reported so they can be migrated deliberately.

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
