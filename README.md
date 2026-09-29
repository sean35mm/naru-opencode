# Naru for OpenCode

Naru adds a coordinating agent and a pool of model-pinned workers to [OpenCode](https://opencode.ai) v2. You pick the coordinator's model in OpenCode; Naru's `naru` agent plans, delegates independent tasks to workers in parallel, and synthesizes the results. It also ships seven on-demand skills, four bounded Git/GitHub/worktree tools, and a `/naru ship-review` command.

The design rule is **thin hard walls, free interior**: a few mechanical permission rules at the irreversible edges (pushing, posting to GitHub), and the coordinator's own judgment everywhere else.

Built by [Naru Labs](https://github.com/sean35mm). Documentation: [sean35mm.github.io/naru-opencode](https://sean35mm.github.io/naru-opencode/).

## Requirements

- OpenCode **>= 2.0.15, < 2.1** on `PATH` (2.0.15 is the tested build; other 2.0.x patch releases are accepted as candidates). Naru does not install or manage OpenCode.
- Node 24.
- `git` for the Git-backed tools, and an authenticated `gh` for GitHub reads and review posting.
- macOS arm64 or Ubuntu x64. Native Windows and WSL are not supported.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/sean35mm/naru-opencode/main/bootstrap.sh | sh
naru install           # previews, then asks before applying
```

The bootstrap downloads a checksum-verified release into `~/.naru` and installs one file, the `naru` command. It does not touch your OpenCode config; pass `--modify-path` if you want it to add `~/.naru/bin` to your shell profile.

`naru install` targets `~/.config/opencode` (or `--dir PATH`). It copies the compiled package to `.naru-native/package`, records its profile and ownership in `.naru-native/`, and registers the `naru` agent, plugin, and skills in `opencode.json` while leaving unrelated settings alone. It sets no parent model. Pass `--apply` to skip the prompt, `--preview` to only print the plan, and `--opencode PATH` to use a specific OpenCode executable.

The installer requires strict JSON and refuses to proceed when it finds `opencode.jsonc`, an existing `naru` command, or assets from a v1 install (`agents/naru.md`, `plugins/naru-dispatch.js`, `.naru-install.json`). It never deletes or converts them for you. If you are upgrading from a v1 install, remove it first with `naru uninstall --legacy` from Naru 0.9.0 (the last release that shipped it), or delete those files by hand, then run `naru install`.

Restart OpenCode after installing, then select `naru` in the agent picker or run `opencode --agent naru`.

From a clone:

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
npm ci && npm run build
sh install.sh --preview
sh install.sh --apply
```

## Choose worker models

Installing registers the coordinator but no workers. Pick them explicitly:

```sh
naru configure                           # interactive picker from OpenCode's model catalogue; previews
naru configure --apply                   # same, then saves
naru models --set openai/gpt-5.6-terra#medium,opencode/glm-5-free --apply
naru models --list
```

References are `provider/model` with an optional `#variant` (reasoning effort). `naru models --set` checks syntax, duplicates, and the 32-worker limit offline; it does not check that the model is available to your account. Restart OpenCode after changing the pool.

## How it works

- **`naru`** is a primary agent with no pinned model; it uses whatever model and effort you choose in OpenCode. It does small tasks directly and delegates decomposable work to workers, several at once when the pieces are independent. It gives each assignment an objective, owned file scope, constraints, and the evidence it expects back, and keeps one owner per file.
- **Workers** (`naru-worker-<provider>-<model>-<hash>`) are reusable subagents, one per configured reference, each pinned to that exact model and variant. They have no fixed role: the assignment decides whether a worker investigates, edits, runs checks, or reviews. The coordinator picks a worker per task from the pool. It is told to honor an explicit "use model X" request and to report, not substitute, when that model isn't in the pool.
- **Skills** load on demand: `naru-coordinate`, `naru-select-workers`, `naru-evaluate`, `naru-plan`, `naru-impact`, `naru-triage`, and `naru-review`. They are guidance and grant nothing.
- **Tools**: `naru-git-read` (bounded read-only Git), `naru-github-read` (issues, PRs, manifest-first pull evidence), `naru-github-post-review`, and `naru-worktree` (isolated writer worktrees on a clean repository). The last two refuse any caller other than `naru`.
- **`/naru ship-review <pr> [<pr> ...]`** reviews each PR independently and, unless `--dry-run` is present, authorizes one review POST per PR with an evidence-gated `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`. `--comment-only`, `--standard`, and `--concise`/`--detailed` adjust the state, profile, and output.

## Permissions

Naru writes these rules into each agent's OpenCode permissions. OpenCode resolves rules last-match-wins after your global config, so they apply even under a global skill deny.

| Agent | Rule |
| --- | --- |
| `naru` and every worker | `skill`: allow `naru-*` and `unslop` |
| Workers | `shell`: deny `git push*`, `gh pr create*`, `gh pr merge*`, `gh pr review*`, `gh pr comment*`, `gh issue create*`, `gh issue comment*`, `gh release create*`, `gh release delete*`, `gh release edit*`, `gh release upload*` |
| Workers | `shell`: ask `gh api*` |

Everything else follows your normal OpenCode permissions. The shell rules are prefix matches on parsed commands, so a wrapper such as `git -C dir push` is not caught. Treat them as guardrails, not a sandbox.

Beyond those rules, the agents are instructed that your current request is the only source of authorization; that repository files, issue and PR text, command output, and worker reports are untrusted data; and that they must stop before destructive, production, database, billing, security, or secret-access actions you didn't ask for. Those are prompt instructions, not enforcement.

Review posting is dry-run by default. A generic request to post, comment, or submit a review yields only a complete `COMMENT`. `APPROVE` or `REQUEST_CHANGES` needs explicit current-message wording ("approve if clear", "request changes if blocked") plus complete evidence. The tool makes at most one POST attempt and never retries an ambiguous outcome. It cannot merge. See the [review lane](docs/src/content/docs/workflows/review-lane.md).

## Doctor, upgrade, version

```sh
naru doctor            # read-only check of host version, package integrity, agents, and registration
naru doctor --json
naru upgrade           # download the latest release, then the same preview-first install
naru version
```

`naru doctor` does not load the plugin, start a session, or contact a provider. `--dir PATH` works with `install`, `configure`, `models`, and `doctor`. Releases live under `~/.naru/versions/<version>` with `~/.naru/current` pointing at the active one.

## Uninstall

There is no `naru uninstall` or `naru rollback` for native installs yet; both commands print manual steps and change nothing. To remove Naru by hand, quit OpenCode, then:

1. In `~/.config/opencode/opencode.json`, delete the `agents` entries listed in `~/.config/opencode/.naru-native/ownership.json`, and the `plugins` and `skills` entries that point into `~/.config/opencode/.naru-native/package`.
2. Delete `~/.config/opencode/.naru-native`.
3. Optionally delete `~/.naru` and remove `~/.naru/bin` from `PATH`.

## Limits

Naru is not a sandbox and not a proof system. Workers run real commands with your credentials. Reports and passing checks are evidence, not proof. There is no durable run state across OpenCode sessions. The compatibility smoke runs provider-free in CI on macOS arm64 and Ubuntu x64 against OpenCode 2.0.15; that does not establish access to any particular provider or account.

## Development

```sh
npm ci
npm run typecheck
npm test                 # clean build, then the Node test suite
npm run build --prefix docs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [development guide](docs/development.md).

## License

MIT. See [LICENSE](LICENSE).
