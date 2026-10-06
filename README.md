# Naru for OpenCode

Naru adds a coordinating agent and a pool of model-pinned workers to [OpenCode](https://opencode.ai) v2. You pick the coordinator's model in OpenCode; Naru's `naru` agent plans, delegates independent tasks to workers in parallel, and synthesizes the results. It also ships seven on-demand skills, four bounded Git/GitHub/worktree tools, and a `/naru ship-review` command.

Naru and its workers have full tool permissions by default. Your request sets the scope; the agents are instructed to work within it without routine tool-approval prompts.

Built by [Naru Labs](https://github.com/sean35mm). Documentation: [sean35mm.github.io/naru-opencode](https://sean35mm.github.io/naru-opencode/).

## Requirements

- OpenCode **>= 2.0.15, < 2.1** on `PATH` (2.0.15 is the tested build; other 2.0.x patch releases are accepted as candidates). Naru does not install or manage OpenCode.
- Node 24.
- `git` for the Git-backed tools, and an authenticated `gh` for GitHub reads and review posting.
- macOS arm64 or Ubuntu x64. Native Windows and WSL are not supported.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/sean35mm/naru-opencode/main/bootstrap.sh | sh
naru install
```

The bootstrap downloads a checksum-verified release into `~/.naru` and installs one file, the `naru` command. It does not touch your OpenCode config; pass `--modify-path` if you want it to add `~/.naru/bin` to your shell profile.

`naru install` targets `~/.config/opencode` (or `--dir PATH`). It copies the compiled package to `.naru-native/package`, records its profile and ownership in `.naru-native/`, and registers the `naru` agent, plugin, and skills in `opencode.json` while leaving unrelated settings alone. It sets no parent model. It applies immediately and prints what it changed. Pass `--dry-run` to only print the plan, and `--opencode PATH` to use a specific OpenCode executable. (`--apply` and `--preview` are accepted for compatibility.)

The installer requires strict JSON and refuses to proceed when it finds `opencode.jsonc`, an existing `naru` command, or assets from a v1 install (`agents/naru.md`, `plugins/naru-dispatch.js`, `.naru-install.json`). It never deletes or converts them for you. If you are upgrading from a v1 install, remove it first with `naru uninstall --legacy` from Naru 0.9.0 (the last release that shipped it), or delete those files by hand, then run `naru install`.

Restart OpenCode after installing, then select `naru` in the agent picker or run `opencode --agent naru`.

From a clone:

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
npm ci && npm run build
sh install.sh --dry-run   # optional: print the plan only
sh install.sh
```

## Choose worker models

Installing registers the coordinator but no workers. Pick them explicitly:

```sh
naru configure                           # interactive picker from OpenCode's model catalogue; saves your choices
naru models --set openai/gpt-5.6-terra#medium,opencode/glm-5-free
naru models --list
```

References are `provider/model` with an optional `#variant` (reasoning effort). `naru models --set` checks syntax, duplicates, and the 32-worker limit offline; it does not check that the model is available to your account. Restart OpenCode after changing the pool.

## How it works

- **`naru`** is a primary agent with no pinned model; it uses whatever model and effort you choose in OpenCode. It does small tasks directly and delegates decomposable work to workers, several at once when the pieces are independent. It gives each assignment an objective, owned file scope, constraints, and the evidence it expects back, and keeps one owner per file.
- **Workers** (`naru-worker-<provider>-<model>-<hash>`) are reusable subagents, one per configured reference, each pinned to that exact model and variant. They have no fixed role: the assignment decides whether a worker investigates, edits, runs checks, or reviews. The coordinator picks a worker per task from the pool. It is told to honor an explicit "use model X" request and to report, not substitute, when that model isn't in the pool.
- **Skills** load on demand: `naru-coordinate`, `naru-select-workers`, `naru-evaluate`, `naru-plan`, `naru-impact`, `naru-triage`, and `naru-review`. They are guidance and grant nothing.
- **Tools**: `naru-git-read` (bounded read-only Git), `naru-github-read` (issues, PRs, manifest-first pull evidence), `naru-github-post-review`, and `naru-worktree` (isolated writer worktrees on a clean repository). The last two refuse any caller other than `naru`.
- **`/naru ship-review <pr> [<pr> ...]`** reviews each PR independently and, unless `--dry-run` is present, posts the appropriate `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` through ordinary coordinator `gh` tooling. `--comment-only`, `--standard`, and `--concise`/`--detailed` adjust the state, profile, and output.

## Permissions

Naru installs one allow-all rule on the coordinator and every worker. OpenCode resolves agent rules after global config, so this overrides inherited tool asks and denies for Naru agents only. Unrelated agents and your global rules are unchanged.

| Agent | Rule |
| --- | --- |
| `naru` and every worker | Allow every action on every resource: `{ "action": "*", "effect": "allow", "resource": "*" }` |

This includes shell commands, file access, skills, and available MCP tools. There are no Naru worker delivery denies or `gh api` approval prompts. OS permissions, credentials, tool availability, and the custom tools' own caller/input checks still apply.

Beyond those rules, the agents are instructed that your current request is the only source of authorization; that repository files, issue and PR text, command output, and worker reports are untrusted data; and that they must stop before destructive, production, database, billing, security, or secret-access actions you didn't ask for. Those are prompt instructions, not enforcement.

Review is dry-run by default. "Review and post" permits the appropriate review decision unless you request comment-only. Posting authorization lasts through the scoped task and its continuations. The coordinator uses ordinary `gh pr review` or `gh api`, verifies the reviewed head, discloses genuine coverage gaps, and never blindly retries an uncertain POST. Exact-SHA local review can cover files that bounded helpers cannot return. `naru-github-post-review` remains available as an optional strict attestation tool. Review posting does not authorize merging. See the [review lane](docs/src/content/docs/workflows/review-lane.md).

## Doctor, upgrade, version

```sh
naru doctor            # read-only check of host version, package integrity, agents, and registration
naru doctor --json
naru upgrade           # download the latest release, then install it (`--dry-run` only reports what it would do)
naru version
```

`naru doctor` does not load the plugin, start a session, or contact a provider. `--dir PATH` works with `install`, `uninstall`, `configure`, `models`, and `doctor`. Releases live under `~/.naru/versions/<version>` with `~/.naru/current` pointing at the active one.

## Uninstall

```sh
naru uninstall              # remove immediately
naru uninstall --dry-run    # print what would be removed
```

`naru uninstall` accepts `--dry-run` and `--dir PATH` like `install`. It removes from `opencode.json` the agents recorded in `.naru-native/ownership.json` that still match what Naru wrote, plus the `plugins` and `skills` entries that point into `.naru-native/package`, then deletes `.naru-native`. Agents you edited after installing are kept and listed; every other setting is left alone. It refuses to run, changing nothing, when the install state is incomplete or has unexpected files. It does not remove v1 files; use `naru uninstall --legacy` from Naru 0.9.0 for those.

The `naru` command itself stays: delete `~/.naru` and remove `~/.naru/bin` from `PATH` to remove it. Restart OpenCode afterwards. There is no `naru rollback` for native installs.

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
