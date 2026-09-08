---
title: OpenCode v2 migration and local preview
description: The plugin-free local preview, supported boundaries, and remaining conformance work.
---

The host-neutral architecture in `OVERHAUL_PLAN.md` supersedes the earlier
prompt-only migration strategy. OpenCode owns conversations, inference, provider
credentials, and UI. Naru owns repository enrollment, scoped tool access, durable
attempt records, isolated writer worktrees, and explicit integration approval.
Naru must not add an autonomous scheduler that invents or starts work.

## Local development preview

The preview uses the existing native `@opencode-ai/cli@0.0.0-beta-19086`
installation. It does not upgrade OpenCode or install an OpenCode plugin.
Its command, configuration, host data, broker socket, and worktrees live in a
separate preview root. The stable Naru installer and upgrade channel are unchanged.

From the checkout, with Node 24 and the isolated beta already installed, build and
install a fresh snapshot. Both destinations must be absent; the installer refuses
to overwrite them:

```sh
npm run build
node .naru-build/tools/install-oc2.mjs \
  --preview-cli "$PWD/.naru-build/tools/naru-preview.mjs" \
  --opencode "$HOME/.local/share/naru-opencode-v2/node_modules/@opencode-ai/cli/bin/opencode2.exe" \
  --v2-wrapper "$HOME/.local/bin/opencode2-naru" \
  --root "$HOME/.local/share/naru-preview-oc2" \
  --bin "$HOME/.local/bin/oc2"
```

Bare `oc2` remains vanilla OpenCode v2 through the isolated `opencode2-naru`
wrapper. It is not Naru by default. Use the explicit `naru` route for:

```sh
oc2 naru auth login
oc2 naru models
oc2 naru enroll /path/to/repository --model provider/model --write 'src/**'
oc2 naru open /path/to/repository
oc2 naru status
oc2 naru integrate TASK_ID
oc2 naru stop
```

Replace `provider/model` with an exact model available to your authenticated
OpenCode account. `--model` accepts comma-separated exact models; `--write`
accepts comma-separated scopes. Omitting `--write` enrolls read-only access.
Provider login is handled by OpenCode in the preview profile; credentials are
never copied from stable OpenCode. Pick the orchestrator model in OpenCode.
OpenCode keeps preview credentials and conversations in one preview-only database;
each host process has separate configuration and an authenticated local server.
The adapter waits for MCP registration before inference to avoid the pinned beta's
initial tool-catalog race. Project configuration loading is disabled in these hosts.

The host projection denies native tools and exposes Naru over MCP. The broker
issues separate capabilities to the orchestrator and each leaf attempt. Workers
cannot start other workers, choose another repository, or integrate changes.
Model selection must match the enrollment allowlist; no fallback is performed.
There are at most two simultaneous attempts and no autonomous queue.

Writers start from a clean Git repository in isolated worktrees. File writes are
restricted to enrollment scopes and checked against the hash returned by a prior
read. Existing source files stay unchanged until `integrate` displays a finite
bundle and the user confirms its digest in a terminal. The digest authorizes
immutable patch and untracked-file bytes captured in that bundle. Integration uses
those same bytes; later writer-worktree changes are not re-read into the target.
Integration creates no commit and performs no remote delivery.

Verification commands run in disposable copies under macOS filesystem/network
containment. They cannot access user credentials or mutate the original checkout.
They may change the disposable copy; those changes are discarded. A sandbox denial
is a failed check, not a successful verification. Other platforms fail closed for
this operation until independently certified. Dependency directories such as
`node_modules` are omitted, and the preview never installs dependencies. These checks
are usable only when dependency-free or when the required runtime is already available.
This boundary constrains preview workers; it is not a claim that Naru can sandbox a
malicious host executable itself.

## Evidence and limitations

The original `v2-beta-exploratory` profile verifies only the exact executable's
version/help surfaces and remains release-ineligible. It is not the preview's
behavioral conformance test and cannot establish full v2 parity.

Run the native local workflow check on macOS with Node 24 after building:

```sh
npm run test:preview:built -- /absolute/path/to/the/pinned/native/opencode2
```

It uses the real beta with a local mock provider to exercise MCP, exact-model
dispatch, isolated editing and verification, and finite integration. It uses no
provider credentials or paid inference. `auth login --help` and `models --help` on
the pinned beta confirm the standalone flags used by the preview, but no real provider
was authenticated or inferred against. Those remain user verification steps.

This is a development preview, not completion of the overhaul. It supports local
inspection, exact-model leaf attempts, scoped text edits, bounded isolated checks,
and terminal-approved integration. Durable records survive broker restarts;
interrupted attempts are not automatically retried. An integration interrupted at
an uncertain boundary requires manual inspection and is not replayed.

Still pending: semantic model routing and catalog policy, full DAG/gate contracts,
resume/reconciliation across every failure boundary, retention/pinning, staged
delivery, Claude Code, Linux containment certification, and curl-distributed
preview releases with migration/rollback evidence. Keep this branch away from
`main` until the plan's applicable acceptance gates pass.

## Upstream contracts

The installed beta has native `permissions` rules, agent `system` prompts,
`mcp.servers`, `debug agents`, and standalone API/run commands. Pin and exercise
these concrete surfaces rather than assuming a v1 custom-tool interface works.
The current upstream subagent contract includes `sessionID` for continuation;
the older August 2026 statement that no resume argument exists is superseded.
Source snapshots remain provisional until validated against the selected binary
and a stable public release.

## Required release gates

- Prove permission denial, leaf-only execution, repository narrowing, and containment.
- Prove exact and semantic routing and pre-execution-only fallback rules.
- Exercise cancellation, restarts, duplicate requests, uncertain integration, and recovery.
- Prove trusted finite approval and protection against untrusted MCP metadata.
- Run the same conformance expectations for each supported host and platform.
- Keep the legacy plugin for a documented deprecation release until replacement parity passes.
