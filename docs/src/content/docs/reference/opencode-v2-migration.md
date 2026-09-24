---
title: OpenCode v2 migration and local preview
description: The native OC2 profile, safe activation, and legacy recovery boundary.
---

OC2 is a local native profile pinned to upstream stable OpenCode `2.0.15`, with an
OC2-only package plugin for Naru capabilities. It is
separate from stable OpenCode. Stable agents, plugins, configuration, credentials,
and data are neither loaded nor changed.
OpenCode 2.0.15 uses a fixed background-service port (`127.0.0.1:49374`).
If another OpenCode service occupies it, configure a free, dedicated loopback
port for OC2 before starting its TUI. The disposable launcher gate does this
without stopping or changing the regular OpenCode service.

## Native profile contract

The preview root defaults to `~/.local/share/naru-preview-oc2`. Native OC2 uses:

- config: `profile/config/opencode/opencode.json`
- global model selection: `profile/native-profile.json`
- managed-agent ownership: `profile/native-managed.json`
- native package: `lib/tools/oc2-native-plugin/` and its `skills/` directory
- data and conversations: the existing `host-data/` and `host-data/opencode.db`
- cache and state routing: `profile/cache/` and `profile/state/`

OC2 preserves the caller's HOME, PATH, current directory, and ordinary nonsecret
environment. Only OC2's config, data, cache, state, and database routes are
overridden. Explicit inherited `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, and
`OPENCODE_CONFIG_CONTENT` routes are removed so stable configuration cannot override
the OC2 profile. Project configuration keeps ordinary native behavior. Native
auto-update remains disabled for this pinned preview. `host.json` supplies the nonsecret, versioned native executable;
the launcher does not probe stable authentication paths.

Bare `oc2` starts ordinary native OpenCode with `naru` available in the picker.
`oc2 naru` creates a session through the native session API with `agent: naru`, then
opens that session in the same background service. This works when bare `oc2` started
the service first. The saved config does not set a parent model or variant, so users retain
OpenCode's normal top-level model UI. `oc2 naru run ...` maps to the supported native
`run --agent naru ...` form. Auth, debug, server, service, and other native commands
keep the same profile and argument boundaries.

Read-only and management commands do not create or refresh the managed projection.
Fresh installation and explicit setup create it; the first bare TUI or Naru session
can initialize a missing profile once. Existing profiles are not rewritten during
ordinary launches. A missing model pool does not block bare
`oc2`. Every explicit Naru execution, including `oc2 naru run`, requires a nonempty
global pool. Interactive use opens global model setup, while noninteractive use prints
the scripted setup command. The run form always supplies `--agent naru` and rejects a
second `--agent` or `-a` override instead of passing duplicate agent flags.

## Models and agents

Configure one OC2-global pool containing 1–32 exact
`provider/model#variant` references:

```sh
oc2 naru configure
oc2 naru models --list
oc2 naru models --set openai/gpt-5.4#high,anthropic/claude-sonnet-4-6
oc2 naru models --refresh
oc2 naru models --check openai/gpt-5.4#high
oc2 naru models --search 'GPT 5.4'
```

`configure` is the existing searchable multi-select model UI, scoped to models only.
It works outside Git and starts no broker or workspace inquiry. `models --set` is the
noninteractive equivalent. `--refresh`, `--check`, and `--search` retain the bounded
public-catalogue diagnostics and do not change the selected pool. Before first setup,
`models --list` reports that the native pool is uninitialized rather than silently
reading or mutating legacy state. The picker includes base models, individual
variants, and an “all advertised variants” option that expands the selected model's
currently advertised variants to exact references, deduplicates overlaps, and checks
the 32-reference limit after expansion. It does not subscribe to future variants.
The eligible catalogue is observed from the native host and optional validated
model feed, not hardcoded. Base models and variants count separately. Configuration
does not stop, restart, or promise to hot-reload active services or sessions. Restart
an active OC2 service yourself and create a new session after changing the pool.

Each exact reference projects one deterministic hidden reusable worker definition.
Its model object retains exact `providerID`, model ID, and optional variant. One
definition can create many native child sessions, including concurrent, background,
and continued sessions; there is no Naru broker slot limit. The visible `naru`
primary contains no model or effort override: the user chooses both in OpenCode.

OC2 does not project blanket permission overrides or role-specific MCP allowlists.
Tool access follows OpenCode's native permissions and the capabilities it advertises;
adding a native tool or MCP server does not require regenerating workers just for its
name. Assignments, not fixed reader/runner/writer roles, define investigation, checks,
edits, or reviews. The parent can do small work directly and dispatch useful independent
assignments in parallel, with one owner per shared file or contract and selective
worktrees when isolation helps. Prompt scope and safety rules are advisory, not a
replacement for native permission enforcement or current-user authorization.

Setup appends the isolated package and skill directories to existing `plugins` and
`skills` arrays. The package registers `naru-git-read`, `naru-github-read`,
`naru-github-post-review`, and `naru-worktree`; it exposes `naru-impact`, `naru-plan`,
`naru-review`, `naru-triage`, `naru-coordinate`, `naru-select-workers`, and
`naru-evaluate` through native skill loading. Tool adapters derive
agent identity and cwd from trusted host execution/session context. Model-supplied
arguments cannot select either value, and workers cannot impersonate the primary
`naru` agent to post a review.

The package also registers native `/naru ship-review <PR...> [--dry-run]
[--comment-only] [--standard] [--concise|--detailed]` for an actual primary `naru`
session only. It uses the bundled command template: each PR is reviewed independently,
defaulting to a release-critical, concise, evidence-gated review POST with the
derived state. `--dry-run` posts nothing. Outside this command, generic current-user
posting language still authorizes only `COMMENT`; flags narrow or change the
command's profile and output, not worker identity or host permissions.

## Safe migration and ownership

On first setup, OC2 may import `globalWorkerPool.models` from a validated legacy
schema-v3 through schema-v6 `state.json`. It copies only exact model references into
the new native profile. It does not instantiate or load the broker and never rewrites
legacy state, tasks, enrollments, worktrees, or the database. No unconfigured
instruction snapshot, capability, token, or secret value is copied into native state
or prompts.

Native config updates preserve unrelated agents, providers, MCP servers, and explicit
user instructions. A private sidecar records the exact definitions OC2 owns. Updates
remove old managed reader/runner/writer definitions only when they exactly match the
record, then install reusable workers. User-edited definitions or custom name collisions
stop setup instead of being overwritten. Malformed JSON, symlink,
unsafe file mode, concurrent edit, or active profile lock fails closed. Writes use
private same-directory staging and compare-and-swap revalidation. A private recovery
generation covers config, ownership, and model profile files. Each rename is atomic,
but the generation is not one crash-atomic filesystem operation. The next explicit
setup finalizes a fully installed generation or rolls back a recognized partial one.
If any target contains a newer external edit, recovery preserves it and leaves the
recovery generation for manual inspection.

The update lock records its PID and operating-system process start identity. Setup
never clears an active lock or malformed metadata. If the recorded process is dead or
the PID has been reused, setup rechecks the lock inode before reclaiming it and then
runs transaction recovery. Transaction generations are built in private temporary
directories and published by one directory rename after the manifest is durable.
Recognized pre-manifest directories from older interrupted setup attempts are removed;
unexpected files are preserved and reported instead.

For schema-v5 or schema-v6 legacy state, setup also validates the previously approved
global-instructions reference inside the caller's HOME. It reads that explicit target
once and embeds the same bounded snapshot and digest in every generated native prompt.
It does not discover stable instruction files or copy unrelated configuration.

The old temporary standalone `agents.naru` definition is removed only when it exactly
matches the known historical definition. User-modified or unrelated `naru` entries are
never silently replaced; native setup reports the collision.

## Fresh local installation

Install the exact native package without lifecycle scripts. Keep the historical
isolated wrapper because the pinned updater and explicit legacy recovery path still
use it:

```sh
npm install --prefix "$HOME/.local/share/naru-opencode-v2" --ignore-scripts \
  --no-save --package-lock=false \
  @opencode/cli-darwin-arm64@2.0.15

npm run build
node .naru-build/tools/install-oc2.mjs \
  --preview-cli "$PWD/.naru-build/tools/naru-preview.mjs" \
  --opencode "$HOME/.local/share/naru-opencode-v2/node_modules/@opencode/cli-darwin-arm64/bin/opencode" \
  --v2-wrapper "$HOME/.local/bin/opencode2-naru" \
  --root "$HOME/.local/share/naru-preview-oc2" \
  --bin "$HOME/.local/bin/oc2"
# Before the first TUI: use a dedicated loopback port confirmed free on this host.
oc2 service set port 49273  # example; confirm availability before using it
```

Fresh installation requires absent root and launcher paths. It stages the compiled
tools, host metadata, legacy recovery launcher, native profile, and final `oc2`
wrapper. It does not copy stable credentials or configuration.

## Existing preview activation

For an existing beta-19425 OC2 profile, close interactive sessions. If the old
broker dispatcher is still installed, run `oc2 naru stop`; it cannot parse
`oc2 naru legacy stop`. Stop its native service only if `oc2 service --help`
lists `stop`. If the native dispatcher is already installed, run `oc2 service stop`
and use `oc2 naru legacy stop` only if you started its recovery broker. Perform
the guarded binary migration before any same-pin refresh:

```sh
npm run build
node .naru-build/tools/install-oc2.mjs --update \
  --preview-cli "$PWD/.naru-build/tools/naru-preview.mjs" \
  --v2-wrapper "$HOME/.local/bin/opencode2-naru" \
  --root "$HOME/.local/share/naru-preview-oc2" \
  --native-root "$HOME/.local/share/naru-opencode-v2"
node .naru-build/tools/install-oc2.mjs --setup-native \
  --root "$HOME/.local/share/naru-preview-oc2"
# After the updater, before the first new TUI: use a free dedicated port.
oc2 service set port 49273  # example; confirm this port is free first
```

`--refresh-code` verifies the installed 2.0.15 hash and version, refuses live
preview processes and update locks, and swaps only compiled tools under the existing
guard. Profile setup is explicit above, or lazy on the first bare TUI or Naru launch. It is
safe when old `host.json` and legacy state exist but native config does not: the setup
validates metadata, imports only a valid old global model list, and otherwise creates
an empty native pool. It never starts the broker or restarts a service.

After native activation, close interactive native sessions and run `oc2 service stop`
before each later refresh. Use `oc2 naru legacy stop` only if you explicitly started
the recovery broker after activation.

The only supported binary migration is beta-19425 to 2.0.15. The updater pins
the npm wrapper and matching macOS arm64 / Linux x64 native artifacts by SRI,
checks the 2.0.15 native `package/bin/opencode` executable, and retains the
beta-19425 recovery generation. The native binary prints `opencode v2.0.15`
even when installed as the isolated `opencode2` file.

For subsequent same-pin code refreshes after activation and service stop:

```sh
oc2 service stop
node .naru-build/tools/install-oc2.mjs --refresh-code \
  --preview-cli "$PWD/.naru-build/tools/naru-preview.mjs" \
  --root "$HOME/.local/share/naru-preview-oc2"
node .naru-build/tools/install-oc2.mjs --setup-native \
  --root "$HOME/.local/share/naru-preview-oc2"
```

The updater verifies pinned SRI, archive paths, package identities, native magic, and
the exact predecessor and target versions. It retains a complete predecessor recovery
generation and rolls back caught switch failures. It refuses an active daemon,
process, broker socket, or `start.lock`. An interrupted switch remains fail-closed;
inspect `start.lock/phase.json` and restore all recorded generation files together.
Never reset `state.json`, `host-data/`, worktrees, or profile data as part of recovery.

The historical broker CLI is recovery-only:

```sh
oc2 naru legacy status
oc2 naru legacy stop
```

Normal `oc2` and `oc2 naru` paths never start it.
`oc2 naru legacy stop` affects only that broker. It is not a substitute for
`oc2 service stop` before a post-activation update or refresh, and it is unavailable
under the old first-migration dispatcher.

## Development verification

All unit and process tests use temporary fixtures. The native acceptance gate requires
the exact 2.0.15 executable and a loopback-only synthetic provider:

```sh
npm run build
node --test --test-concurrency=1 \
  .naru-build/tests/oc2-native-projection.test.mjs \
  .naru-build/tests/oc2-native-config.test.mjs \
  .naru-build/tests/oc2-native-launch.test.mjs \
  .naru-build/tests/oc2-native-plugin.test.mjs \
  .naru-build/tests/oc2-profile.test.mjs \
  .naru-build/tests/oc2.test.mjs
node .naru-build/scripts/naru-native-agent-smoke.mjs \
  /absolute/path/to/opencode-2.0.15
node .naru-build/scripts/naru-native-capabilities-smoke.mjs \
  /absolute/path/to/opencode-2.0.15
node .naru-build/scripts/naru-native-launch-smoke.mjs \
  /absolute/path/to/opencode-2.0.15
```

The native smoke targets parent selection, exact worker models and variants, native
subagent lifecycle, available native tools, normal cwd and nonsecret
environment inheritance, stable-profile non-discovery, and MCP visibility after
restart without agent regeneration. It does not establish fixed role permissions.

The capability smoke separately verifies package-directory loading, all four
specialized tools, trusted per-session Git cwd, parent and worker skill loading, and
worker review denial before transport. The launcher smoke starts an isolated service
through bare production `oc2`, then uses the production `oc2 naru` path to create two
model-free Naru sessions in distinct project directories. It also verifies that
`oc2 service stop` leaves native profile files unchanged. These describe source
capabilities and verification targets, not final check results or activation of the
installed native profile. This migration is local development work, not release
qualification. The user installed the stable 2.0.15 binary; the native code changes
remain in this workspace without real-account validation.
