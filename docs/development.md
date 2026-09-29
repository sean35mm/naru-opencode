---
title: Naru development guide
description: Repository layout, native architecture, invariants, tests, and releases.
---

# Naru development guide

Naru's design rule: hard mechanical walls at irreversible edges, freedom inside them. The walls are OpenCode permission rules Naru writes into its agents and checks inside its own tools, not prose.

## Repository layout

| Path | Contents |
| --- | --- |
| `bin/naru` | The `naru` CLI: a thin front door over `install.sh`, `tools/naru-native.mjs`, and the doctor. |
| `install.sh` | Launcher for the native installer. In a checkout it runs the built copy in `.naru-build/`. |
| `bootstrap.sh` | Downloads and verifies a release into `~/.naru` and installs the `naru` shim. |
| `commands/naru.md` | The `/naru` command template, copied into the package as `command.md`. |
| `tools/naru-native.mts` | `install`, `configure`, and `models` entry point. |
| `tools/naru-doctor.ts` | Read-only native health report. |
| `tools/naru-*.ts` | The four custom tools. The filename is the tool ID. |
| `tools/naru-lib/` | Shared modules: native install and profile, agent projection, preview server, Git/GitHub/review/worktree libraries, validation, transport. |
| `tools/oc2-native-plugin/` | The OpenCode plugin (tools and `/naru` command) and the seven skills. |
| `scripts/` | Compatibility and capability smokes, the release publisher, and build helpers. Not installed. |
| `tests/` | Node test sources (plus one Bun transport test). |
| `docs/` | This guide and the Astro site under `docs/src/`. |

## Architecture

`naru install` copies the compiled `tools/` tree and `commands/naru.md` into `<config>/.naru-native/package`, records a hash of every file in `manifest.json`, and transactionally updates `opencode.json`, `profile.json`, and `ownership.json`:

- `agents.naru`: primary coordinator, no model, skill allow rules (`tools/naru-lib/oc2-native-projection.mts`).
- `agents.naru-worker-*`: one subagent per configured reference, pinned to that model and variant, with the skill allow rules plus the delivery shell denies and `gh api*` ask.
- `plugins`: the package's `tools/oc2-native-plugin`, which registers the four tools and the `/naru` command.
- `skills`: the package's `tools/oc2-native-plugin/skills`.

The plugin resolves each tool call's working directory from the OpenCode session record and passes `DEFAULT_RUNTIME_CONFIG`; there is no user runtime config file. OpenCode owns permission evaluation, sessions, child tasks, cancellation, and retries. Naru owns the prompts, the permission rules, and the validated tool surface.

The installer refuses JSONC, ambiguous config, an existing `naru` command, and v1 assets rather than rewriting them. Keep those collision checks: users upgrading from v1 rely on them.

## Source-of-truth map

| Concern | Source |
| --- | --- |
| Agent prompts, worker naming, permission rules | `tools/naru-lib/oc2-native-projection.mts` |
| Install, package, ownership, upgrade | `tools/naru-lib/native-install.mts`, `tools/naru-lib/oc2-native-config.mts` |
| Plugin tool and command registration | `tools/oc2-native-plugin/index.mts` |
| Skill guidance | `tools/oc2-native-plugin/skills/*/SKILL.md` |
| Read-only Git | `tools/naru-git-read.ts`, `tools/naru-lib/git.mts` |
| GitHub reads and pull snapshots | `tools/naru-github-read.ts`, `tools/naru-lib/github.mts` |
| Review construction and posting | `tools/naru-github-post-review.ts`, `tools/naru-lib/review.mts` |
| Worktree lifecycle | `tools/naru-worktree.ts`, `tools/naru-lib/worktree.mts` |
| Input validation, spawn, output bounds | `tools/naru-lib/validate.mts`, `transport.mts`, `output.mts` |
| Supported OpenCode and Node versions | `tools/naru-lib/compatibility.mts` |
| Health report | `tools/naru-doctor.ts` |

## TypeScript source and emitted runtime

Sources are `.ts` and `.mts`. `npm run build` type-checks and emits `.js`/`.mjs` into a clean `.naru-build/`, bundles the preview wizard, and copies the shell scripts and non-code assets (`scripts/copy-build-assets.mjs`, plain JavaScript and excluded from the TypeScript project). Installs, tests, and release archives run that tree; never edit it directly. Validate at tool boundaries, reject unknown fields, bound sizes, and build fixed argument arrays, never a shell string.

## Invariants

- The coordinator has no pinned model; each worker has exactly one model and optional variant.
- Worker rules keep the delivery denies (`git push*`, `gh pr`/`gh issue`/`gh release` mutations) and the `gh api*` ask. Both `naru` and workers keep the `naru-*` and `unslop` skill allows.
- `naru-github-post-review` and `naru-worktree` refuse any caller other than `naru`.
- Review posting requires schema v5 for new mutations, derives the event from manifest-bound final evidence, makes one POST attempt, and never retries an ambiguous outcome. v2/v3/v4 remain recognition-only.
- Install previews by default and writes nothing until `--apply`. It never deletes user or v1 data.
- The doctor stays read-only and provider-free.

## Tests

```sh
npm run typecheck
npm test                  # clean build, then every emitted Node test
npm run test:bun          # Bun transport test; needs Bun 1.3.9
npm run build --prefix docs
git diff --check
```

Tests never touch a real `~/.config/opencode`; install tests use temporary HOME and XDG roots. `tests/release-workflow.test.mts` reads workflow files from the checkout, so run it from the repository root after building.

With a real OpenCode 2.0.15 binary:

```sh
NARU_NATIVE_TEST_REAL_OPENCODE=/absolute/path/to/opencode node --test .naru-build/tests/native-install.test.mjs
npm run test:compat -- --opencode /absolute/path/to/opencode --json
node .naru-build/scripts/naru-native-capabilities-smoke.mjs /absolute/path/to/opencode   # macOS only
```

All three use disposable HOME directories and no provider credentials. CI runs both smokes against pinned, integrity-checked 2.0.15 binaries.

## Extending Naru

1. Add a tool as `tools/naru-<name>.ts` with validation in `tools/naru-lib/`, a bounded enumerated operation surface, and an entry in the plugin's `TOOL_INVENTORY`.
2. Add a skill under `tools/oc2-native-plugin/skills/naru-<name>/SKILL.md`; the `naru-*` allow already covers it.
3. Change agent prompts or permission rules only in `oc2-native-projection.mts`, and update the doctor's projection check and the docs in the same change.

Reserved contracts: the `naru` and `naru-worker-*` agent names, the tool IDs, the review dedupe marker, and the `.naru-native` file schemas. Change them only with a migration and a targeted test.

## Release checklist

1. Run the checks above plus the real-host smokes, and record any that were not run.
2. Confirm the permission rules, caller restrictions, and posting contract still match the invariants.
3. Confirm README and docs match the installed inventory, CLI flags, and stated limitations.
4. Review the complete diff for local paths, secrets, stale identifiers, and unintended user-config changes.

Releases are cut by Release Please and the Release workflow; see [CONTRIBUTING.md](https://github.com/sean35mm/naru-opencode/blob/main/CONTRIBUTING.md).
