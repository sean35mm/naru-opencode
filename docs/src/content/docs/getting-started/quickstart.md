---
title: Quickstart
description: Install Naru, select the implementation coordinator, and choose the right entry point.
---

## 1. Install

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
./install.sh --configure-subagent-depth
./install.sh --apply --configure-subagent-depth
```

The first run is a read-only preview; the second applies exactly that option set. The default target is `~/.config/opencode`. The depth flag safely configures Naru's required top-level `subagent_depth`; without it, the installer leaves OpenCode config untouched. Naru requires OpenCode 1.18.4+, Node.js or Bun, and depth `2` or higher. Exactly `2` is recommended and matches the current topology.

Restart OpenCode after the applied install. Then take exactly one safe first action:

```text
/naru-plan <your objective>
```

## 2. Choose what happens next

1. **Analyze:** use `/naru-plan`, `/naru-impact`, `/naru-triage`, or `/naru-review` for a read-only result.
2. **Implement:** select **`naru-orchestrator`** in OpenCode's agent picker, set it as `default_agent`, or run `opencode --agent naru-orchestrator` for authorized scoped work. It coordinates work but does not edit; only the scoped Implement minion edits files.
3. **Runtime safety (optional):** leave scheduling `off`, or deliberately configure `observe`/`enforce` only after reading the compatibility requirements.
4. **Activity (optional):** preview and apply the dashboard install with the same explicit boundary:

   ```sh
   ./install.sh --with-dashboard --configure-subagent-depth
   ./install.sh --apply --with-dashboard --configure-subagent-depth
   ```

## 3. Keep delivery explicit

Local edits are the normal stopping point. Commit, push, pull-request creation, and review posting happen only when the current request explicitly asks for them. `/naru-review` never posts; `/naru-review-post` is the dedicated posting command.

Run `node ~/.config/opencode/tools/naru-doctor.js` for a provider-free, read-only local state report. Continue with [installation](https://sean35mm.github.io/naru-opencode/getting-started/installation/) for project/custom targets, lifecycle previews, conflicts, backups, and doctor options, or see the canonical [user guide](https://sean35mm.github.io/naru-opencode/user-guide/) for complete operational details.
