---
title: Naru user guide
description: Install Naru, work with the orchestrator, and understand the walls it will not cross.
---

# Naru user guide

Naru is a thin layer over OpenCode. You talk to one agent — `naru-orchestrator` — and it decides how to split the work and who does it. There are no modes to pick, no scheduler to tune, and no workflow to configure.

What Naru adds is a small set of hard mechanical walls at the places where mistakes are expensive, and near-total freedom inside them. The orchestrator is trusted to plan and fan out on its own judgment; it is not trusted to edit your files, run your code, or push anything anywhere.

This guide covers installation, day-to-day use, the walls, the tools, the one configuration file, and troubleshooting.

## Requirements

- [OpenCode](https://opencode.ai) >= 1.18.4.
- Node.js 24 for the install preview, ownership manifest, tools, and local doctor.
- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated, for pull-request workflows.
- `subagent_depth` >= 1. OpenCode's default is 1, which is enough: Naru is one root orchestrator delegating to leaf subagents.
- `codebase-memory` and LSP are optional. Read-only work falls back to literal file search when they are unavailable or stale.

## Install

Clone Naru, review the preview, then apply the same option set:

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
sh install.sh --preview
sh install.sh --apply
```

`--preview` is the default and mutates nothing: it prints a bounded summary of what would change. `--apply` stages and replaces assets transactionally, then writes a deterministic `.naru-install.json` ownership manifest recording managed roots, source fingerprints, selected options, and install method. Matching assets are skipped. Replaced content is retained in a timestamped `.naru-backups/` directory and restored if the transaction fails.

An apply installs four agents, four skills, five tools with their helper library, one plugin (`naru-dispatch`, always copy-pinned), and `naru-runtime.example.json`. It does not create an active `naru-runtime.json`.

Clone, preview, apply is the contributor path. Most users install through the curl bootstrap and the naru CLI instead, which drive the same transactional installer; see the README or the installation guide.

### Where it installs

With no location flag the target is `~/.config/opencode`. Agent and skill Markdown is symlinked individually; tools and helper modules are always copied so executable code cannot change merely because the source checkout moved.

```sh
sh install.sh --apply --copy                      # copy Markdown instead of symlinking
sh install.sh --apply --project                   # install into $PWD/.opencode
sh install.sh --apply --dir /path/to/config-root  # install into a custom config directory
```

`--project` targets `$PWD/.opencode`, where `$PWD` is the directory the installer is invoked from; OpenCode loads project configuration after global configuration. `--dir` identifies a config root but cannot make OpenCode load that path. The source checkout and target may not contain one another, and the target and its managed directories must not be symlinks.

### Flags

| Flag | Effect |
| --- | --- |
| `--preview` | Explicitly select the default read-only preview. |
| `--apply` | Apply the reviewed option set transactionally. |
| `--copy` | Copy agent and skill Markdown instead of symlinking it. |
| `--project` | Install into `$PWD/.opencode`. |
| `--dir PATH` | Install into a custom OpenCode config directory. |
| `--replace-conflicts` | Replace only the conflicts shown by that exact preview. |
| `--uninstall` | Preview removal of manifest-owned assets. |
| `--rollback ID` | Preview restoration of one explicit receipt-backed transaction. |
| `--with-dashboard` | Deprecated accepted no-op. The dashboard was removed. |

### Conflicts

`conflict-unowned` means a selected path exists but is absent from the prior manifest. `conflict-modified` means a manifest-owned path changed after installation. Both are preserved and block an apply. Review the reported paths, keep or move anything of yours, then add `--replace-conflicts` to the same apply only when replacing and backing up those exact paths is intended.

### Update

After pulling a new version, rerun the installer with the same location flags for every loaded scope:

```sh
git pull
sh install.sh --preview
sh install.sh --apply
```

Even a symlink install must be rerun, because tools and helpers are copy-pinned. Restart OpenCode afterward so sessions reload agent definitions, skills, and permissions.

### Rollback and uninstall

Both are two-step. Preview first, then repeat the exact command with `--apply` and the SHA-256 token that preview printed:

```sh
sh install.sh --rollback 20260722123456-12345
sh install.sh --rollback 20260722123456-12345 --apply \
  --confirm-rollback 'sha256:copy-the-current-preview-token'

sh install.sh --uninstall
sh install.sh --uninstall --apply \
  --confirm-uninstall 'sha256:copy-the-current-preview-token'
```

Use the same `--project` or `--dir` selector that was used to install; the manifest supplies the rest. The token is bound to the target, action, manifest, selected receipt, conflict choice, and full plan, so a stale or differently scoped token fails before anything is touched. Modified paths are preserved by default, which yields a partial uninstall; only a new `--replace-conflicts` preview selects them, and it emits a different token. Unrelated files and `.naru-backups/` are never removed.

## Talk to the orchestrator

`naru-orchestrator` is a visible primary agent, not a slash command. Select it in the OpenCode agent picker, make it the default, or launch OpenCode with it:

```json
{
  "default_agent": "naru-orchestrator"
}
```

```sh
opencode --agent naru-orchestrator
```

Then describe what you want in plain language: fix this failure, implement this change, review this PR, explain how this subsystem works. You do not choose an analysis mode, a concurrency level, or a workflow. The orchestrator reads the task and decides.

Do not use `naru-orchestrator` as a Task target from a custom agent. Custom agents should allowlist the four skills instead — see the [agent integration guide](/naru-opencode/agent-integration/).

## The four agents

```mermaid
flowchart TB
  U(["You"]):::actor
  ORC{{"naru-orchestrator<br/><small>plans and delegates · cannot edit · cannot run bash</small>"}}:::coord

  subgraph leaves["Subagents — hidden, cannot delegate further"]
    direction LR
    R["naru-reader<br/><small>read-only</small>"]:::read
    RUN["naru-runner<br/><small>read-only + shell</small>"]:::shell
    W["naru-writer<br/><small>the only editor</small>"]:::write
  end

  STOP["Local changes<br/><small>the default stopping point</small>"]:::write
  POST["One COMMENT-only review post<br/><small>explicit current request only</small>"]:::danger

  U --> ORC
  ORC --> R
  ORC --> RD
  ORC --> RUN
  ORC --> W
  W --> STOP
  ORC -.->|"'post the review'"| POST

  style leaves fill:none,stroke:#8f96a5,stroke-dasharray:2 3,color:#8f96a5

  classDef actor fill:#eef0f6,stroke:#5f6675,color:#14161d
  classDef coord fill:#ccd3ff,stroke:#3f4fbe,color:#1b2456
  classDef read fill:#d3ece5,stroke:#2f8f78,color:#123a31
  classDef shell fill:#e6f0cf,stroke:#6f8f2f,color:#2c3a10
  classDef write fill:#ffe4bd,stroke:#b8760f,color:#4a2c00
  classDef danger fill:#ffdcd6,stroke:#c0392b,color:#4a120c
```

<ul class="naru-legend">
  <li data-kind="read">Read-only, no shell</li>
  <li data-kind="shell">Read-only, runs checks</li>
  <li data-kind="write">Writes files</li>
  <li data-kind="danger">Leaves your machine</li>
</ul>

| Agent | Role | Edit | Bash |
| --- | --- | --- | --- |
| `naru-orchestrator` | Primary, visible. Plans, delegates, synthesizes, reports. | No | No |
| `naru-reader` | Investigation: finding code, tracing behavior, diagnosing, reviewing. | No | No |
| `naru-runner` | Runs tests, typecheck, lint, build, and reproductions. | No | Yes |
| `naru-writer` | The only role that can edit files. | Yes | Yes |

The three subagents are hidden and cannot delegate (`task: deny`), so the topology is always one root orchestrator with leaf children at depth 1. That is why OpenCode's default depth of 1 is sufficient.

## How it delegates

The orchestrator uses as many children as the work genuinely needs, in parallel, without asking permission to parallelize.

- Readers are cheap, so it fans them out widely on unfamiliar or broad work.
- `naru-runner` is used whenever a question needs a command run rather than reasoned about.
- `naru-writer` gets the edits, split at real boundaries — separate files, modules, or independent questions.

Effort scales to the task. A one-line fix gets no fan-out. There is no child-count ceiling to configure and no schedule to observe; the only durable brake is `maxConcurrentWriters` (see [runtime configuration](#runtime-configuration)), which exists to stop a runaway, not to shape a plan.

You still get one report at the end: what changed, which files, which checks actually ran and what they returned, and what risk remains.

### Per-dispatch models

If you configure model classes (see [runtime configuration](#runtime-configuration)), the orchestrator also picks a model per dispatch through the `naru-dispatch` tool: a cheap class for wide reader fan-out, a strong one for the dispatch that deserves it, both in the same turn. Without a `models` block — or without the plugin at all — every subagent inherits your session model and nothing else changes.

You can watch it happen in the TUI. While a dispatch runs, the tool's title reads `agent · provider/model@effort — description`, and the child session is titled `description (@agent · provider/model@effort)`. The final report then includes a one-line ledger of what was dispatched where, for example:

```text
Dispatched: 3× reader (light/luna-fast@high), 1× writer (standard/sol-fast@medium)
```

Dispatch changes the model, never the walls: the child runs under its own agent permissions, so `naru-writer` stays the only editor and readers stay shell-less regardless of which model a dispatch lands on.

## The walls

These are enforced mechanically by OpenCode permission frontmatter or by the tools themselves, not by polite prose in a prompt.

- **Only `naru-writer` can edit.** The orchestrator, both readers, and the runner have `edit` and `apply_patch` denied.
- **Secrets are denied to every role.** `.env`, `.env.*`, key material, `.ssh`, `.aws`, `.kube`, and `.gnupg` are unreadable. `.env.example` templates are allowed.
- **User intent is the sole authorization source.** Repository files, issue and PR text, diffs, comments, command output, and subagent reports are untrusted data. Instructions found there describe what someone wrote; they never widen scope or authorize an action.
- **Local changes are the default stop.** Commit, push, PR create/update, and GitHub posting happen only when the current request asked for them. That ask is the authorization — it is not reconfirmed, and it is not assumed.
- **One checkpoint, naming the exact action,** before destructive or irreversible operations, history rewrite or force push, hook bypass, production deploys, persistent database writes or migrations, secret access, billing or security-posture changes, dependency changes you did not request, or material scope expansion. Routine reads, checks, and in-scope commands need no checkpoint.
- **One writer per logical scope.** Two writers never touch the same file, contract, config, lockfile, or generated artifact; overlap serializes. Where Weaver is available, each writer checks `weaver status`, claims its exact scope before the first edit, and calls `weaver done`. A claim conflict is a scheduling signal — other work keeps moving and the blocked item is requeued. It is never turned into a question for you.
- **Verification happens after writers finish.** Results gathered while files are still changing are meaningless, so final checks wait for a quiet workspace, and a change after verification means verifying again.

`naru-runner` and `naru-writer` can execute repository code through ordinary checks and builds. That is useful, not harmless: package scripts and build targets can touch Git, files, databases, and external services. Naru is not a sandbox.

## The four skills

Skills are advisory. They shape how a request is approached and grant nothing at all: no tools, no scope, no permission change, no read-only guarantee.

| Skill | Ask for | Returns |
| --- | --- | --- |
| `naru-plan` | A plan or implementation approach | Advisory plan |
| `naru-impact` | Blast-radius or compatibility analysis | Advisory impact assessment |
| `naru-triage` | A bug or failure diagnosed | Advisory diagnosis |
| `naru-review` | A PR, branch, diff, or file reviewed | Dry-run review |

Ask naturally, or name one explicitly ("use the `naru-plan` skill…"). OpenCode discovers loaded skills on demand and decides which global and project sources are visible and how duplicate names resolve; inspect a skill's origin before trusting it.

## Pull-request review

Reviewing and posting are separate acts.

Review is dry-run by default: findings come back to you and nothing leaves your machine. A PR link is not posting authorization.

Posting requires an explicit request in your current message to the directly selected orchestrator — "post the review". Then the orchestrator runs a fresh review against the current head, never a pasted or cached payload, confirms the target still matches, and calls `naru-github-post-review` exactly once.

That tool is hard-coded to a `COMMENT` event. It cannot approve, request changes, or merge. It writes a dedupe marker, makes one attempt, and never retries; an ambiguous outcome is reported as ambiguous rather than repeated. Only `naru-orchestrator` can call it. If edits or a push land after a review, that review is stale and needs a new explicit request.

Any PR reference — full URL, `OWNER/REPO#NUMBER`, or a bare number resolved against the current workspace — is normalized to one canonical `(owner, repo, number)`. Owner and repo compare case-insensitively. If a reference resolves to more than one PR or to none, the orchestrator stops and asks.

## Isolated worktrees

Writers normally share your workspace. When full isolation is wanted, the orchestrator drives `naru-worktree`: `prepare_run`, then `prepare_item` per writer, `integrate_item` as each returns, `finalize_run` once the result is verified, then `cleanup_run`. `recover_run` picks a run back up after a restart instead of preparing duplicates. `snapshot` reports current state.

The tool is restricted to `naru-orchestrator`. Writers never commit, merge, or remove worktrees — integration belongs to the orchestrator. Isolation requires a clean repository; when the workspace is dirty or isolation is unavailable, the run silently downgrades to shared mode rather than asking you or imitating isolation with directory copies.

Tool-owned Git operations suppress hooks, serialize mutations per run, contain paths, write recovery metadata atomically, and attempt rollback on failure. They do not protect against unrelated external mutation of your workspace.

## Tools

| Tool | Purpose |
| --- | --- |
| `naru-git-read` | Bounded read-only Git: `repository`, `status`, `diff`, `log`, `file`, `grep`, `merge-base`. |
| `naru-github-read` | `resolve`, `issue`, `pull`, `source`. Pull snapshots are pinned to exact 40-hex SHAs. |
| `naru-github-post-review` | Orchestrator-only. One `COMMENT`-only attempt, no retry, dedupe marker. |
| `naru-worktree` | Orchestrator-only isolated writer worktrees and integration. |
| `naru-doctor` | Provider-free local install and configuration health report. |
| `naru-dispatch` | Orchestrator-only. Spawns a subagent on a per-dispatch model class. Registered by Naru's one plugin. |

The GitHub tools invoke authenticated `gh` through a validated interface rather than exposing a general shell.

## Runtime configuration

`naru-runtime.json` is optional. Without it, the defaults below apply. `naru-runtime.example.json` is installed beside the managed `agents/`, `skills/`, and `tools/` directories as a starting point; copy it into the same config root only when you actually want to change something:

```sh
cp .opencode/naru-runtime.example.json .opencode/naru-runtime.json
```

```json
{
  "schemaVersion": 1,
  "implementation": {
    "cleanWorkspaceRequired": true,
    "maxConcurrentWriters": 50,
    "workspaceMode": "auto"
  },
  "models": {
    "light":    { "use": "wide fan-out, mechanical lookups, simple reads", "chain": ["opencode/glm-5-free", "opencode/minimax-m3-free"] },
    "standard": { "use": "ordinary investigation, edits, checks", "chain": ["openai/gpt-5.6-terra@medium"] },
    "deep":     { "use": "architecture, security, data models, final review, tricky edits", "chain": ["openai/gpt-5.6-sol@high"] }
  }
}
```

| Field | Values | Meaning |
| --- | --- | --- |
| `cleanWorkspaceRequired` | must be `true` | Isolated worktrees require a clean repository. |
| `maxConcurrentWriters` | integer 1–50 | Runaway brake only. It does not shape the plan. |
| `workspaceMode` | `auto`, `shared`, `worktree` | `auto` uses isolation when the repository is clean; `shared` disables the worktree tool entirely; `worktree` selects isolation. |
| `models` | optional map | The model classes `naru-dispatch` can pick per dispatch. |

Model classes are named by you — `light`/`standard`/`deep` are just the shipped example. Each class carries a `use` string telling the orchestrator when to pick it and a `chain` of `provider/model` entries tried in order, with an optional `@effort` suffix (`low`, `medium`, `high`, `xhigh`, `max`) where the model supports it. An entry whose provider isn't authenticated is skipped, a failing entry falls to the next, and if the whole chain fails the dispatch simply runs on your session model. Leave `models` out entirely and every dispatch inherits your session model. The class list is read once at plugin load, so restart OpenCode after changing it.

That is the entire configuration surface. The file must be regular, non-symlinked JSON no larger than 64 KiB, unknown fields are rejected, and an invalid file is a startup-visible error rather than a silent partial policy. Prefer project-local configuration; changing global OpenCode configuration deserves explicit approval.

## Health check

The doctor is copy-pinned and read-only. It never loads plugins, credentials, or providers, never calls a model, and never mutates or uploads anything:

```sh
node ~/.config/opencode/tools/naru-doctor.js            # global install
node .opencode/tools/naru-doctor.js --project-root .    # project install
node /path/to/config-root/tools/naru-doctor.js --dir /path/to/config-root
```

The bounded, path-sanitized report covers candidate global, project, and custom scopes, manifest version and install mode, missing or modified assets, stale copy-pinned state, local OpenCode compatibility, and runtime-configuration validity. Custom scopes are reported as unconfirmed because arbitrary loading cannot be proven. Use `--source PATH` to compare an install against a checkout and `--json` for the structured form. A warning report exits nonzero for automation without changing state.

## Working on Naru itself

```sh
npm test            # node --test over tests/*.test.mjs
npm run test:bun    # bun transport check
npm run test:installer
```

Sources are plain `.js` and `.mjs`; there is no build step.

## Manual install

The installer is strongly preferred — a manual copy has no ownership manifest, so the doctor reports it as untracked and updates cannot preview or preserve conflicts. If you need one:

```sh
mkdir -p ~/.config/opencode/skills ~/.config/opencode/agents ~/.config/opencode/tools
cp -R skills/naru-* ~/.config/opencode/skills/
cp agents/naru-*.md ~/.config/opencode/agents/
cp tools/naru-*.js tools/package.json ~/.config/opencode/tools/
cp -R tools/naru-lib ~/.config/opencode/tools/
cp naru-runtime.example.json ~/.config/opencode/
```

Use `.opencode` in place of `~/.config/opencode` for a project install, and restart OpenCode afterward.

## What Naru does not manage

Naru does not modify your `AGENTS.md`, your optional `naru-runtime.json`, unrelated OpenCode tools, or external agent-state systems. Preview is the default; an applied install touches only its reviewed managed set.

## What Naru is not

- **Not a sandbox.** Shell-enabled roles run real repository code with your credentials and your network.
- **Not a proof system.** Gates and checks constrain behavior; they do not prove a report is true.
- **Not durable.** Nothing survives a process as authoritative shared state.
- **Not a global capacity meter.** Limits are local; they do not observe other processes, other machines, or provider-side quota.

## Troubleshooting

### Agents or skills look stale

Run the installed doctor with `--source /path/to/naru-opencode` to spot stale copy-pinned state. Preview `install.sh` with the original options, review any conflicts, apply, then restart OpenCode. Tools and helpers are copy-pinned even when Markdown is symlinked, and every loaded global and project scope needs the update.

### The installer reports a conflict

See [Conflicts](#conflicts). Nothing was changed; inspect the listed paths before deciding whether that exact apply should include `--replace-conflicts`.

### A child fails at the subagent depth limit

Confirm OpenCode is 1.18.4 or newer and that `subagent_depth` is at least 1, then reinstall the loaded scope and restart. Naru only ever delegates one level deep, so the OpenCode default is enough.

### The orchestrator will not edit a file

That is the design. It has no `edit` permission and delegates every change to `naru-writer`. If nothing is being written at all, check that all four agent files installed and that the orchestrator's `task` allowlist survived your local configuration.

### Review cannot resolve a pull request

Authenticate `gh` and supply a full PR URL or `OWNER/REPO#NUMBER`. A bare number requires the current workspace to resolve to the intended repository, and an ambiguous reference intentionally stops for clarification.

### A review was not posted

Posting needs an explicit request in the current message to the directly selected orchestrator. Review is otherwise dry-run. An identical repost is suppressed by the dedupe marker, a stale or degraded review is refused, and an ambiguous attempt is reported rather than retried.

### Isolated worktrees were not used

Isolation requires a clean repository, and `workspaceMode: "shared"` disables the worktree tool outright. A dirty workspace downgrades to shared mode silently and by design.
