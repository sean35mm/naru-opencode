---
title: Quickstart
description: Install Naru, select the orchestrator, ask for something, and see what happens.
---

## 1. Install

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
sh install.sh --preview
sh install.sh --apply
```

The first run is a read-only preview; the second applies exactly that option set. The default target is `~/.config/opencode`; use `--project` or `--dir PATH` for another target. Naru requires OpenCode 1.18.4+ and Node 24, and works at OpenCode's default `subagent_depth` of `1`.

Restart OpenCode after the applied install.

## 2. Select the orchestrator

Pick **`naru-orchestrator`** in OpenCode's agent picker, set it as `default_agent`, or start OpenCode with it:

```sh
opencode --agent naru-orchestrator
```

## 3. Ask for something

Ask in plain language. No mode flags, no ceremony.

```text
Rate limiting drops valid requests after a deploy. Find out why and fix it.
```

## 4. What happens

The orchestrator plans, then fans out to subagents on its own judgment:

- **`naru-reader`** investigates — finds the code, traces behavior, diagnoses. Read-only.
- **`naru-reader-deep`** handles high-consequence judgment — architecture, security, data models, dependencies, final review. Same read-only permissions, stronger model.
- **`naru-runner`** runs tests, typecheck, lint, build, and reproductions. Read-only plus bash; it cannot edit.
- **`naru-writer`** applies the change. It is the only role with edit permission.

The orchestrator itself cannot edit files and cannot run bash. Those walls are OpenCode permission frontmatter, not instructions. Subagents cannot spawn their own children, so the shape is always one orchestrator over a flat set of workers.

Work stops at local changes. Commit, push, pull-request creation, and review posting happen only when your current request explicitly asks for them. Before anything destructive or irreversible — migrations, persistent database writes, production deploys, secret access, unrequested dependency changes — you get one checkpoint that names the exact action.

## 5. Optional extras

**Skills.** `naru-plan`, `naru-impact`, `naru-triage`, and `naru-review` are advisory guidance you can invoke by name. They shape approach; they grant no tools and relax no permissions.

```text
Use the `naru-plan` skill to plan <your objective>
```

**Health check.** A provider-free, read-only report of local install and config state:

```sh
node ~/.config/opencode/tools/naru-doctor.js --json
```

**Runtime config.** Copy `naru-runtime.example.json` to `naru-runtime.json` only if you need to change writer workspace behavior. See [runtime configuration](/naru-opencode/reference/runtime-config/).

Continue with [installation](/naru-opencode/getting-started/installation/) for project targets, lifecycle previews, conflicts, and backups, or see the [user guide](/naru-opencode/user-guide/) for full operational detail.
