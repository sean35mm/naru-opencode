---
title: Quickstart
description: Install Naru, select the implementation coordinator, and choose the right entry point.
---

## 1. Install

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
./install.sh --configure-subagent-depth
```

The default target is `~/.config/opencode`. The explicit flag safely configures Naru's required top-level `subagent_depth`; without it, the installer leaves OpenCode config untouched. Naru requires OpenCode 1.18.4+ and depth `2` or higher. Exactly `2` is recommended and matches the current topology. Restart OpenCode after installation.

## 2. Pick the workflow

Use a command for a read-only result:

- `/naru-plan` for an implementation plan
- `/naru-impact` for change impact
- `/naru-triage` for a failure diagnosis
- `/naru-review` for a dry-run pull-request review

For implementation, select **`naru-orchestrator`** in OpenCode's agent picker, set it as `default_agent`, or run `opencode --agent naru-orchestrator`. It coordinates work but does not edit; only the scoped Implement minion edits files.

## 3. Keep delivery explicit

Local edits are the normal stopping point. Commit, push, pull-request creation, and review posting happen only when the current request explicitly asks for them. `/naru-review` never posts; `/naru-review-post` is the dedicated posting command.

Continue with [installation](https://sean35mm.github.io/naru-opencode/getting-started/installation/) for target and dashboard options, or see the canonical [user guide](https://sean35mm.github.io/naru-opencode/user-guide/) for complete operational details.
