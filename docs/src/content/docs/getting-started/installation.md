---
title: Installation
description: Install Naru into an OpenCode 2.0.x configuration directory, choose workers, check health, upgrade, and remove it.
---

Naru needs OpenCode **>= 2.0.15, < 2.1** on `PATH` (2.0.15 is the tested build) and Node 24. Install OpenCode separately; Naru does not manage its binary. Pull-request workflows also need an authenticated `gh`.

## Quick install

```sh
curl -fsSL https://raw.githubusercontent.com/sean35mm/naru-opencode/main/bootstrap.sh | sh
naru install
```

The bootstrap downloads a checksum-verified release into `~/.naru` and installs one file, the `naru` command. It does not read or modify your OpenCode configuration, and it edits a shell profile only if you pass `--modify-path`; otherwise it prints the `PATH` line for you to add. To install an exact version:

```sh
curl -fsSL https://raw.githubusercontent.com/sean35mm/naru-opencode/main/bootstrap.sh | sh -s -- --version vX.Y.Z
```

`naru install` prints the plan and asks before applying. `--apply` skips the prompt, `--preview` only prints the plan, `--dir PATH` selects another config directory (one OpenCode actually loads), and `--opencode PATH` names an exact OpenCode executable.

| Command | Effect |
| --- | --- |
| `naru install [--dir PATH]` | Preview the install, then ask |
| `naru configure [--dir PATH] [--apply]` | Pick worker models from OpenCode's catalogue; preview unless applied |
| `naru models --list [--dir PATH]` | List the configured worker references |
| `naru models --set REF[,REF] [--dir PATH] [--apply]` | Preview or save exact worker references offline |
| `naru doctor [--dir PATH] [--json]` | Read-only package and registration health |
| `naru uninstall [--dir PATH]` | Preview the removal, then ask |
| `naru upgrade` | Download the latest release, then preview the install |
| `naru version` | Show installed and latest versions |

Releases live under `~/.naru/versions/<version>` with `~/.naru/current` pointing at the active one, so an upgrade keeps the previous release on disk.

## Install from a clone

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
npm ci
npm run build
sh install.sh --preview
sh install.sh --apply
```

In a checkout, `install.sh` runs the built copy under `.naru-build/`, so build first.

## What gets written

- `.naru-native/package/`: a copy (not a symlink) of the compiled tools, the Naru plugin, the `/naru` command, and seven skills. A checkout update changes nothing until you apply another install.
- `.naru-native/profile.json`, `ownership.json`, `manifest.json`: the selected worker models, the agents Naru owns, and a hash of every package file.
- `opencode.json`: the `naru` agent, one agent per configured worker, and the plugin and skills paths. Unrelated settings are preserved and no parent model is set.

Restart OpenCode after applying, choose the coordinator's model in OpenCode, and select `naru` in the agent picker or run `opencode --agent naru`.

## Choose workers

A fresh install has no workers. Add them:

```sh
naru configure --apply
naru models --set openai/gpt-5.6-terra#medium,opencode/glm-5-free --apply
```

`naru configure` needs a terminal and reads OpenCode's normal model catalogue. `naru models --set` checks reference syntax, duplicates, and the 32-reference limit offline; it does not check that a model is available to your account. Neither command enables a provider. Restart OpenCode after changing workers. See [agents and workers](/naru-opencode/workflows/agents/) for how the coordinator uses them.

## Conflicts and v1 installs

The installer requires strict JSON in `opencode.json` and refuses to continue when it finds:

- `opencode.jsonc`, or config it cannot parse;
- an existing `naru` command (`commands/naru.md`, `command/naru.md`, or a `command.naru` / `commands.naru` config entry);
- v1 assets: `agents/naru.md`, `agents/naru-orchestrator.md`, `plugins/naru-dispatch.js`, a `naru-dispatch` plugin entry, or `.naru-install.json`.

It never deletes or converts these. To move from a v1 install, run `naru uninstall --legacy` from Naru 0.9.0 (the last release with the v1 installer; it previews and prints a confirmation command), or remove the listed files and entries by hand. Then run `naru install`. Don't print config or authentication contents while diagnosing a conflict.

## Doctor

```sh
naru doctor
naru doctor --dir /path/to/opencode-config --json
```

The doctor checks the observed OpenCode version, the package against its manifest, the managed agents and permission rules, and the plugin and skills registration. It reports `runtimeEvidence: not-run`: it does not load the plugin, start a session, or contact a provider, so a healthy report is not proof that a model works.

## Uninstall

```sh
naru uninstall
naru uninstall --dir /path/to/opencode-config --apply
```

`naru uninstall` prints the plan and asks, like `install`; `--apply` skips the prompt and `--preview` only prints the plan. Applying it:

- removes from `opencode.json` each agent listed in `.naru-native/ownership.json` whose entry still matches what Naru wrote, and the `plugins` and `skills` entries that point into `.naru-native/package`, through the same locked, recoverable write the installer uses;
- keeps and lists any Naru agent you edited after installing (it is yours now);
- leaves every other setting untouched, dropping `agents`, `plugins`, or `skills` only if removal empties them;
- deletes `.naru-native` (package, profile, ownership record, manifest).

If Naru is not installed it says so and changes nothing. If the state is incomplete, unparseable, modified, or contains unexpected files, or `opencode.json` still references a missing `.naru-native`, it stops without changing anything and tells you what to fix. It does not remove v1 files; use `naru uninstall --legacy` from Naru 0.9.0 or delete them by hand.

The `naru` command is not removed: delete `~/.naru` and remove `~/.naru/bin` from `PATH` for that. Restart OpenCode afterwards. `naru rollback` is not available for native installs.
