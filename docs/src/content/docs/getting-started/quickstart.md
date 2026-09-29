---
title: Quickstart
description: Install Naru, pick worker models, select the coordinator, and ask for something.
---

## 1. Install

```sh
curl -fsSL https://raw.githubusercontent.com/sean35mm/naru-opencode/main/bootstrap.sh | sh
naru install
```

The bootstrap installs only the `naru` command. `naru install` previews every change to `~/.config/opencode` and asks before applying it. You need OpenCode 2.0.15 or a later 2.0.x patch release on `PATH`, and Node 24.

## 2. Pick workers

```sh
naru configure --apply
```

This offers models from OpenCode's catalogue and saves the ones you choose as workers. For a non-interactive setup, use `naru models --set provider/model#variant[,REF] --apply`.

## 3. Select the coordinator

Restart OpenCode, choose a model for the coordinator as you normally would, then pick **`naru`** in the agent picker or start OpenCode with it:

```sh
opencode --agent naru
```

## 4. Ask for something

```text
Rate limiting drops valid requests after a deploy. Find out why and fix it.
```

The coordinator decides how to split the work. Independent pieces go to workers in parallel; small ones it does itself. It reports what changed, which files it touched, and which checks actually ran.

Work stops at local changes. Workers can't push or post to GitHub, and the coordinator is told to act on delivery only when your current request asks for it.

## 5. Optional

- **Skills.** Ask for a plan, an impact analysis, a triage, or a review, or name a skill: "Use `naru-plan` to plan …".
- **PR review.** `/naru ship-review 123 --dry-run` reviews a pull request without posting. Drop `--dry-run` to post one evidence-gated review.
- **Health.** `naru doctor` checks the install without starting a session.

Continue with [installation](/naru-opencode/getting-started/installation/) for conflicts, v1 cutover, and uninstall, or [agents and workers](/naru-opencode/workflows/agents/) for how delegation and permissions work.
