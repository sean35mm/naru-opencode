# Naru for OpenCode

Multi-agent workflows for [OpenCode](https://opencode.ai).

- **Core** — read-only workflows for planning, impact analysis, triage, and PR review.
- **naru-orchestrator + naru-minions** — task decomposition, investigation, architecture, implementation, debugging, verification, and judgment.

Built by [Naru Labs](https://github.com/sean35mm).

## Commands

```
/naru-plan          <feature | bug | issue/PR | file | subsystem>   -> production-safe plan
/naru-impact        <change | PR | diff | file | subsystem>         -> blast-radius / risk report
/naru-triage        <bug | stack trace | failing test | symptom>    -> evidence-based diagnosis
/naru-review        <PR url | owner/repo#number | number>           -> thorough PR review (dry run)
/naru-review-post   <PR url | owner/repo#number | number>           -> post one comment-only review
/naru-minions       (optional dashboard)                            -> open detailed Naru child-session activity
```

`/naru-review` no longer accepts `--post`; use `/naru-review-post` explicitly.

Core workflows are **read-only**. Select the `naru-orchestrator` primary agent to use the model-routed minion workflow. Its implementation minion can edit files only after approved delegation; the implement, debug, and verify minions may run narrowly allowlisted routine checks without individual prompts.

## How it works

Core has a three-layer fan-out:

```
/naru-<workflow>      command     thin entry point (commands/naru-<workflow>.md)
   │
   ▼
naru-<workflow>       agent       hidden orchestrator (agents/naru-<workflow>.md)
   │
   ├── naru-<workflow>-<role>     hidden specialists, one concern each
   └── naru-<workflow>-judge      hidden judge, synthesizes one answer
```

All Core agents are `hidden: true`; users enter through the flat slash commands. The general layer adds the visible primary agent `naru-orchestrator` and hidden `naru-minion-*` workers.

### Model routing

`plugins/naru-delegate.js` centrally routes all 35 Naru agents while preserving OpenCode's native Task permission, cancellation, retry, background-job, and child-session behavior.

- **Fast:** `openai/gpt-5.6-terra-fast`, variant `high`.
- **Deep:** `openai/gpt-5.6-sol-fast`, variant `high`.
- Architecture, risk, data, security, integration, and judge roles have a Deep floor.
- Other roles use Fast by default. Authorized orchestrators may invoke a hidden Deep route for high-risk, ambiguous, conflicting, or context-limited work; Deep roles cannot be downgraded.

Generated Deep routes exist only in OpenCode's runtime configuration. They do not add more agent files or bypass the exact Task allowlists in the Naru orchestrators.

To replace the two central profiles, create `naru-models.json` beside your installed `commands/`, `agents/`, `tools/`, and `plugins/` directories:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "fast": { "model": "provider/fast-model", "variant": "high" },
    "deep": { "model": "provider/deep-model", "variant": "high" }
  },
  "agents": {
    "naru-minion-implement": "deep"
  }
}
```

The optional file also accepts sparse exact-agent overrides through an `agents` object with values `fast` or `deep`. Deep-floor roles cannot be downgraded. The file must be a regular, non-symlinked file no larger than 64 KiB. Naru never creates, overwrites, or migrates it.

When both global and project Naru Delegate plugins are installed, profiles and agent overrides merge in OpenCode load order; sparse project values replace matching global values without resetting the rest. An invalid later configuration disables dynamic routing for that startup, removes generated routes, and restores the original agent definitions.

### Activity dashboard

Install the optional dashboard with `./install.sh --with-dashboard`. In OpenCode's full terminal TUI, it adds a compact **Naru Activity** section to the session sidebar and registers `/naru-minions` as the detailed child-session view.

The sidebar shows up to four active or recently completed Naru children for the current workflow root, including:

- Status derived from native session and Task state, age since the latest child update, and foreground/background mode.
- Canonical agent name and Fast, Deep-floor, Deep-override, Deep-escalation, or neutral Routed classification.
- The provider, model, and variant recorded by the Task and child messages. It displays `resolving` until execution metadata is available rather than guessing from routing defaults.
- The delegated task description. Unrelated OpenCode Task children are intentionally omitted.

Run `/naru-minions` from a workflow root or child session to inspect all recognized sibling children and navigate into one. The persistent card is visible only while the standard session sidebar is open. OpenCode `--mini` does not host full-TUI plugins, so the dashboard and command are unavailable there.

## Safety model

- **Core is read-only.** No edits, writes, commits, pushes, dependency installs, migrations, or arbitrary command execution.
- **Generic implement edits only through approved delegation.** Select `naru-orchestrator` when you want the general implementation workflow.
- **Routine checks are frictionless for execution minions.** Implement, debug, and verify share an ordered least-privilege shell policy that allows narrow test/lint/typecheck/check/build families, common direct test/build tools, and only `git status`, `git rev-parse`, and `git merge-base` through the shell. The validated `naru-git-read` tool provides their broader read-only Git access. These allowed commands execute repository code and can have hidden side effects. Arbitrary package-manager, package-exec, and Git commands are not broadly allowed. Scout, investigate, architect, and judge remain shell-denied, while debug/verify remain edit-denied.
- **Matched sensitive operations remain gated.** The ordered lexical rules classify recognized dependency changes, Git mutations, migrations, schema/database writes, mutation/output flags, and redirects as `ask`; clearly destructive filesystem/system commands are denied. OpenCode evaluates commands extracted from compound commands and pipelines independently, so a composition made entirely from allowed commands is also allowed. Execution minions are instructed to issue one routine command per shell call and avoid composition, but this is an instruction-level safeguard, not something enforced by wildcard permission. In interactive mode, approval should cover the exact command, purpose, working directory, and impact. Auto mode or a persisted always approval may execute an `ask` command without a per-invocation prompt.
- **Permission matching is lexical, not a sandbox.** Package scripts and Make targets are opaque indirection, so inspecting the relevant manifest or target before every otherwise allowed invocation is mandatory. Matching does not verify executable identity through `PATH`; mixed-case mutation names and hidden script or target bodies remain lexical limitations. This is not a database sandbox, and neither an allow match nor auto/always approval proves a command safe.
- **Validated tools call authenticated `gh` internally.** `/naru-review` is a dry run. `/naru-review-post` posts at most one `COMMENT`-only review for a complete validated snapshot; identical reruns return `alreadyPosted`, and degraded reviews are never posted. It cannot approve, request changes, merge, or create ordinary issue comments.
- **No absolute secret isolation.** Direct agent reads deny common environment-file names, and the validated Git/GitHub tools reject additional secret-like paths such as private keys. Arbitrarily named secrets, other installed tools, and previously indexed graph content cannot be identified perfectly. Trust your provider, model, and installed tools as you would trust any code with repository access.
- **OpenCode auto mode auto-approves `ask` prompts.** Explicit denies and the validated posting boundary still apply, but the shell policy is not a complete sandbox. Do not use auto mode with execution minions unless you accept permission-gated commands running without an interactive prompt.

## Requirements

- [OpenCode](https://opencode.ai) >= 1.17.18
- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated, for review workflows
- `codebase-memory` / LSP are optional; workflows fall back to file search when unavailable
- Every `--with-dashboard` installation requires Node.js or Bun to safely create or merge its TUI registration.
- `naru-minion-implement` retains a matching Terra Fast High frontmatter pin as an upgrade fallback for installations that have not refreshed the copy-pinned plugin yet.

## Install

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
./install.sh
```

Default global install symlinks Markdown command/agent files into `~/.config/opencode`. Use `--project` for `$PWD/.opencode`, or `--dir PATH` for a custom config directory.

Flags:

- `--copy` — copy Markdown files instead of symlinking.
- `--project` — install into `$PWD/.opencode`; invoke the installer from the target project when the Naru clone is elsewhere.
- `--dir PATH` — install into a custom OpenCode config directory.
- `--with-dashboard` — install and register the optional live Activity sidebar (`plugins/naru-minions-dashboard.tsx`, copy-pinned) in the active `tui.jsonc` or `tui.json`.
- `--migrate-orchestrator` — back up legacy user paths `agents/orchestrator.md`, `agents/minion`, and `plugins/orchestrator-dashboard.js`. Without this flag those legacy paths are never touched.

Tools, helpers, Naru Delegate, and the dashboard plugin are always copy-pinned, even in symlink mode. Rerun `./install.sh` after `git pull` to update them. A copied old install is stale until reinstalled.

The installer preflights and stages the complete release before replacing loader paths. Replaced files are retained in a timestamped backup and restored if installation fails. With `--with-dashboard`, it preserves unrelated TUI config content, prefers an existing `tui.jsonc`, rejects malformed config, and migrates the old dashboard JS file and exact legacy registration.

There are no `/naru/*` aliases; use the flat `/naru-plan`, `/naru-impact`, etc.

### Migration

Old nested Core loader paths (`commands/naru`, `agents/naru`, and old `*.bak.*` backups created by earlier installers) are automatically moved out of the scanned directories into a timestamped backup under `$TARGET/.naru-backups/`. Legacy orchestrator paths are moved only when `--migrate-orchestrator` is passed.

### Manual install

Back up and remove an old `commands/naru` or `agents/naru` installation first; otherwise OpenCode will load both the old nested names and the new flat names. When upgrading a manual dashboard install, also remove `plugins/naru-minions-dashboard.js` and its exact JS registration from every active `tui.json` and `tui.jsonc` before registering the TSX plugin.

```sh
# Global
mkdir -p ~/.config/opencode/commands ~/.config/opencode/agents \
         ~/.config/opencode/tools ~/.config/opencode/plugins
cp commands/naru-*.md ~/.config/opencode/commands/
cp agents/naru-*.md ~/.config/opencode/agents/
cp tools/naru-git-read.js tools/naru-github-read.js tools/naru-github-post-review.js \
      ~/.config/opencode/tools/
cp -R tools/naru-lib ~/.config/opencode/tools/
cp plugins/naru-delegate.js ~/.config/opencode/plugins/
cp plugins/naru-minions-dashboard-state.mjs plugins/naru-minions-dashboard.tsx \
      ~/.config/opencode/plugins/  # optional
# Also add "./plugins/naru-minions-dashboard.tsx" to the top-level "plugin"
# array in the active ~/.config/opencode/tui.jsonc or tui.json.

# Project
mkdir -p .opencode/commands .opencode/agents .opencode/tools .opencode/plugins
# ...same cp pattern...
```

For a project install, make the equivalent plugin entry in `.opencode/tui.jsonc` or `.opencode/tui.json`. Restart OpenCode to pick up commands, agents, and TUI plugins.

## What is not included

Naru does not manage or modify:

- Your personal `AGENTS.md`
- `opencode.json`
- Your optional `naru-models.json` routing override
- Weaver or Herdr state
- Logging, analytics, or formatter plugins
- Unrelated tools already in your `commands/`, `agents/`, `tools/`, or `plugins/` directories

## Repository layout

```
install.sh                         # transactional global/project installer

commands/
  naru-plan.md  naru-impact.md  naru-triage.md  naru-review.md  naru-review-post.md

agents/
  naru-plan.md  naru-impact.md  naru-triage.md  naru-review.md
  naru-plan-architecture.md       naru-plan-minimal-change.md
  naru-plan-risk.md               naru-plan-tests.md
  naru-plan-judge.md
  naru-impact-topology.md         naru-impact-contracts.md
  naru-impact-data.md             naru-impact-frontend-mobile.md
  naru-impact-tests-ci.md         naru-impact-judge.md
  naru-triage-reproduction.md     naru-triage-codepath.md
  naru-triage-regression.md       naru-triage-tests.md
  naru-triage-judge.md
  naru-review-security.md         naru-review-backend.md
  naru-review-frontend-mobile.md  naru-review-integrations.md
  naru-review-tests-ci.md         naru-review-judge.md
  naru-review-post.md
  naru-orchestrator.md
  naru-minion-scout.md            naru-minion-investigate.md
  naru-minion-architect.md        naru-minion-implement.md
  naru-minion-debug.md            naru-minion-verify.md
  naru-minion-judge.md

tools/
  naru-git-read.js  naru-github-read.js  naru-github-post-review.js
  naru-lib/

plugins/
  naru-delegate.js                    # central model routing, installed by default
  naru-minions-dashboard-state.mjs   # dashboard Task/status normalization
  naru-minions-dashboard.tsx         # optional Activity sidebar and detail modal

scripts/
  merge-tui-config.mjs               # safe dashboard registration and migration

tests/
  *.test.mjs  install.test.sh         # routing, policy, dashboard, tools, and installer checks
```

## Customizing

- **Models.** Use one optional `naru-models.json` file to replace Fast/Deep profiles or sparsely upgrade exact roles. Per-file frontmatter is no longer the primary routing mechanism.
- **Add or swap a specialist.** Drop a new `agents/naru-<workflow>-<name>.md` with `mode: subagent`, `hidden: true`, then allow it in the orchestrator's `permission.task` list and add it to the fan-out instructions.
- **Permission blocks are the source of truth.** Each agent's `permission` block defines what it can read and which validated tools it may call.

## License

MIT — see [LICENSE](LICENSE).
