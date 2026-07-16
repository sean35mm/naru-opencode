# Naru user guide

This guide covers installation, day-to-day use, model routing, the optional dashboard, upgrades, migration, troubleshooting, and Naru's safety boundaries.

## Requirements

- [OpenCode](https://opencode.ai) >= 1.17.19.
- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated, for pull-request review workflows.
- Node.js or Bun for every installation that uses `--with-dashboard`; the installer needs one of them to create or merge TUI configuration safely.
- `codebase-memory` and LSP support are optional. Read-only workflows fall back to literal file search when they are unavailable or stale.

## Install and update

Clone Naru and run its transactional installer:

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
./install.sh
```

The installer preflights and stages the complete release before replacing loader paths. Replaced content is retained in a timestamped `.naru-backups/` directory and restored if installation fails.

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

### Custom config path

Use an absolute or relative custom directory:

```sh
./install.sh --dir /path/to/opencode-config
```

The source checkout and target cannot contain one another. The target and its managed loader directories must not be symlinks.

### Optional flags

- `--copy` — copy command and agent Markdown instead of symlinking it.
- `--project` — install into `$PWD/.opencode`.
- `--dir PATH` — install into a custom OpenCode config directory.
- `--with-dashboard` — copy and register the optional TUI dashboard.
- `--migrate-orchestrator` — back up legacy `agents/orchestrator.md`, `agents/minion`, and `plugins/orchestrator-dashboard.js` paths. Without this flag, those paths are untouched.

### Updating

After pulling a new Naru version, rerun the installer with the same location and dashboard flags:

```sh
git pull
./install.sh --with-dashboard
```

Even a symlink install must be rerun because tools, helpers, and plugins are copy-pinned. A `--copy` install is entirely stale until reinstalled. Restart OpenCode after reinstalling so active sessions reload routing and permissions.

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

There are no `/naru/*` aliases. `/naru-review` does not accept `--post`; posting always requires `/naru-review-post` explicitly.

### Select `naru-orchestrator` for implementation

`naru-orchestrator` is a visible primary agent, not a slash command. Select it in the OpenCode UI when you want the Naru Minions implementation workflow. It coordinates investigation, architecture, implementation, debugging, verification, and judgment while remaining unable to edit files itself.

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

Do not use `naru-orchestrator` as a Task target from custom agents. See the [agent integration guide](agent-integration.md) for supported read-only delegation.

### Conditional specialist coverage

Core workflows select specialists by relevant surface rather than launching every specialist. Plan always includes minimal-change and tests; Impact always includes topology and tests/CI; Triage always includes reproduction and codepath; Review always includes its judge and at least one relevant domain specialist. Selected specialists are required. Unselected specialists are recorded as `skipped-not-relevant`, are not retried, and do not degrade the final status. A failed selected specialist can produce a partial or incomplete result; review and review-post retain their immutable snapshot and validated posting boundaries.

## Activity dashboard

Install the dashboard explicitly:

```sh
./install.sh --with-dashboard
```

The installer copies `plugins/naru-minions-dashboard.tsx` and its state helper, then safely updates the top-level `plugin` array in the active `tui.jsonc` or `tui.json`. It prefers an existing `tui.jsonc`, preserves unrelated content, rejects malformed or symlinked TUI configuration, removes exact legacy dashboard registrations from lower-precedence TUI files, and migrates the old dashboard JavaScript file.

In OpenCode's full terminal TUI, the dashboard provides:

- A compact **Naru Activity** section in the standard session sidebar, showing up to four active or recently completed recognized Naru children for the current workflow root.
- `/naru-minions`, which lists all recognized sibling child sessions and lets you navigate into one.
- Status derived from native session and Task state, age since the latest child update, and foreground/background mode.
- Canonical agent name and a `Luna`, `Terra`, `Sol`, `Sol xhigh`, `Sol floor`, or neutral `Routed` classification.
- Provider, model, and variant from Task or child-message metadata. The UI shows `resolving` instead of guessing while metadata is unavailable.
- The delegated Task description. Unrelated OpenCode Task children are omitted.

The persistent card appears only while the standard session sidebar is open. `opencode --mini` does not host full-TUI plugins, so neither the dashboard nor `/naru-minions` is available there.

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

The five Luna-eligible minions produce five Luna aliases. All delegable non-floor roles assigned Terra produce Sol alternatives, currently seventeen aliases. Sol-floor roles and explicit Sol assignments are invoked canonically and receive no generated alternatives. The aliases are internal runtime details: do not invoke them from custom agents or persist them in integrations.

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
- An explicit `/naru-review-post` invocation likewise authorizes its one validated GitHub review posting call without reconfirmation; it does not authorize any other GitHub posting.
- Persistent database writes or migration execution, dependency changes not explicitly requested, destructive or irreversible work, external global configuration outside an exact approved path, billing/security-posture changes, and material scope expansion still require the applicable approval boundary.

### Permission limitations

- Shell-enabled role permissions are intentionally permissive, not a sandbox. They do not inspect script behavior or prevent package scripts and targets from changing Git, files, databases, or external state.
- Direct reads deny known secret patterns, but permission policy is not a complete secret sandbox. Prompt guidance also forbids reading or revealing secrets; trust the selected provider, model, and installed tools as you would any code with repository access.

### GitHub posting boundary

- Validated Naru tools invoke authenticated `gh` without exposing a general shell surface.
- `/naru-review` is dry-run only.
- `/naru-review-post` can post at most one `COMMENT` review for a complete validated snapshot. Identical reruns return `alreadyPosted`; degraded reviews are never posted. It cannot approve, request changes, merge, or create an ordinary issue comment.

### Auto mode

OpenCode auto mode automatically approves only configured `doom_loop` asks. Environment-file and secret reads remain denied. Allowed shell and external-directory access already run without prompting for Debug, Verify, and Implement. The validated review-posting boundary remains in force. Neither auto mode nor permissive runtime access makes repository code, package scripts, targets, secret access, or database-connected commands safe.

## What Naru does not manage

Naru does not modify your personal `AGENTS.md`, `opencode.json`, optional `naru-models.json`, unrelated OpenCode tools or plugins, or external agent-state systems.

## Troubleshooting

### Commands or agents are stale

Rerun `install.sh` after every update. Plugins, tools, and helpers are copy-pinned even when Markdown is symlinked. Restart OpenCode after reinstalling.

### Duplicate or unexpected agent IDs appear

Remove or migrate old nested `commands/naru` and `agents/naru` loader directories. They can coexist with flat current files after a manual upgrade and cause duplicate definitions.

### Routing is disabled

Inspect the `naru-delegate` startup error. Confirm `naru-models.json` is valid schema-v1 or schema-v2 JSON, uses only supported keys and canonical agent IDs, does not downgrade a Sol-floor role, is a regular non-symlinked file, and is at most 64 KiB. An invalid later scope disables dynamic routing for that startup rather than applying a partial policy.

### The orchestrator uses an unexpected model

Check every loaded global and project `naru-models.json` in plugin load order. An explicit `agents.naru-orchestrator` value wins over its built-in Sol assignment. Also rerun the installer so the copy-pinned Naru Delegate plugin and routing helper match the Markdown agents.

### A Luna route is missing

Luna routes exist only for scout, investigate, implement, debug, and verify while the canonical role resolves to Terra. An explicit Sol assignment removes both generated alternatives. If an eligible Terra role still has no Luna route, update OpenCode to at least 1.17.19, reinstall every loaded Naru copy, and restart OpenCode. A stale schema-v1 plugin can preserve Terra/Sol policy but cannot generate Luna aliases.

### A minion still asks before Git, Weaver, Python, or another shell command

Only Debug, Verify, and Implement have Bash and external-directory allows. Rerun the installer with the same location and `--with-dashboard` flags, restart OpenCode, and inspect the intended role. Scout, Investigate, Architect, and Judge correctly deny shell commands. Environment-file reads are denied. Repeated identical calls can prompt only through configured `doom_loop`, not Bash.

### Review commands cannot resolve a pull request

Authenticate `gh` and provide a full PR URL or `OWNER/REPO#NUMBER`. A bare PR number requires the current workspace to resolve to the intended GitHub repository.

### The dashboard is missing

Reinstall with `--with-dashboard`, verify the TSX plugin is registered in the active TUI config, restart OpenCode, and use the full terminal TUI with the standard sidebar open. The dashboard does not run under `--mini`.

### Dashboard installation rejects TUI configuration

Fix malformed JSON/JSONC or replace a symlinked TUI configuration with a regular file. The installer refuses to rewrite malformed or symlinked configuration rather than risking unrelated settings.
