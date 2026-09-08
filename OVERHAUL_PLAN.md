# Host-Agnostic Overhaul Plan

## Purpose and status

This document is the durable brief for the host-agnostic Naru overhaul. It records agreed product boundaries, current evidence, and the work still required. The overhaul and OpenCode v2 support are not complete.

`main` and `origin/main` remain at `cfb71a83b76d5d2bd1d31690a7356ec9d0dd196e`, the Naru 0.7.1 release. Overhaul work stays on `overhaul/host-agnostic` until the acceptance gates in this document pass. This branch must not be treated as a stable release source in the meantime.

Naru continues to use curl bootstrap and GitHub release artifacts for its own distribution. Naru is not becoming an npm-distributed product. Preview installs must use a separate command, installation root, configuration, state, and upgrade channel so they cannot replace or mutate a stable Naru installation by accident.

## Product decisions

- Ship one host-neutral Naru project and distribution. The target architecture has no OpenCode plugin.
- Run a user-level local daemon as the durable broker. MCP and CLI are the ingress surfaces, and execution remains local first.
- Treat OpenCode as the first conformance host and Claude Code as the second.
- Support macOS arm64 and Linux x64 first. Other platforms require separate evidence before support is claimed.
- The host selects the top-level orchestrator model. Naru does not take over the host's top-level conversation.
- Route child work by exact model selection or semantic requirements. Routing is constrained by policy allowlists, with defaults and user overrides. Hard eligibility filters run before soft cost and latency ranking. A semantic route may fall back only before execution starts; Naru must never silently switch models after an attempt begins.
- Keep workers as leaves. Persist the task DAG, attempts, dependencies, and gates, but do not introduce an autonomous scheduler that invents or starts work independently of the orchestrator.
- Require explicit repository enrollment. Concurrency is configurable. Global policy establishes the maximum authority and an enrolled repository may only narrow it.
- Give writers isolated Git worktrees. The broker owns integration and commits. Apply tiered containment according to host capability, and fall back to read-only behavior when a host has not passed safety certification.
- Keep durable task, attempt, decision, authorization, and evidence records, but not full model transcripts. Retain records for 30 days by default and allow records to be pinned.
- Use a Naru-owned terminal confirmation flow for finite, inspectable action bundles. Confirmation authorizes only the displayed bundle, not an open-ended class of future actions.
- Make GitHub the first delivery target. The staged delivery surface includes commits, pushes and pull requests, reviews, tags, release notes and releases, npm publication for user projects, and GitHub Actions promotion. Deployments and remote workers are outside the initial scope.

## Intended architecture

```text
Host UI and orchestrator model (OpenCode first; Claude Code second)
                         |
                    MCP / CLI
                         |
        +----------------v----------------+
        | Local broker / user daemon      |
        | durable tasks, attempts, gates, |
        | authorization and evidence      |
        +-----+----------------------+-----+
              |                      |
       core policy/contracts    delivery adapters
              |                      |
        executor drivers       Git / GitHub / npm / Actions
              |
      enrolled repository worktrees

Host projections: host-specific setup and capability declarations
Skills: host-neutral guidance projected into each supported host
```

### Responsibilities

- **Core policy and contracts:** define authorization, capabilities, model eligibility and ranking, task and attempt state, evidence requirements, mutation boundaries, containment tiers, and repository narrowing. This layer must not depend on a host's plugin API.
- **Local broker:** own durable state, DAG and gate transitions, concurrency limits, worktree allocation, cancellation and resume coordination, confirmation bundles, integration, commits, retention, and audit evidence.
- **MCP and CLI:** expose the same broker operations through machine and human ingress. Inputs are requests and correlation data, not proof of user authorization.
- **Executor drivers:** translate a broker-approved leaf attempt into a host execution, enforce the selected model and capability envelope, stream bounded status, and return normalized evidence. Drivers must not gain authority from host-provided content.
- **Host projections:** install or render the host-facing agent definitions, MCP configuration, skills, and capability declarations needed by a particular supported host. Projections are adapters, not independent products.
- **Skills:** provide portable planning, impact, triage, and review guidance. Skills do not grant permissions or authorize mutations.
- **Delivery adapters:** perform only broker-authorized, finite Git, GitHub, npm, and GitHub Actions operations and return verifiable results.

Naru does **not** own provider credentials, model inference, top-level or child conversation loops, or host UI. Credentials remain with the host or the user-selected execution environment. Naru supplies policy, durable coordination, containment, and evidence around host execution.

## OpenCode v1 and v2 facts and policy

- The recognized stable OpenCode builds are `1.18.4` and `1.18.28`. Other stable versions, including `1.18.29`, fail the recognized-build gate and are not tested support.
- The isolated beta command is `~/.local/bin/opencode2-naru`, pinned to `@opencode-ai/cli@0.0.0-beta-19086` under `~/.local/share/naru-opencode-v2`.
- The wrapper isolates `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME` beneath that root. Its database is `~/.local/share/naru-opencode-v2/state/opencode.db`. These paths must remain separate from stable OpenCode and stable Naru.
- Manual beta installation must name the exact package version, `@opencode-ai/cli@0.0.0-beta-19086`, and the isolated prefix. Do not use `latest`, a range, or an unpinned beta tag. The wrapper must continue to execute the binary from that exact isolated installation.
- OpenCode v2 is beta. Naru does not yet claim full v2 parity or production support.
- The `v2-beta-exploratory` CI profile is bounded, exploratory evidence and is never release-qualifying. CI downloads the exact Linux x64 artifact and verifies its integrity and contents before running the smoke profile.

The observed v2 contract changes that drivers and projections must account for include:

| v1 surface | v2 surface or change |
| --- | --- |
| `task` | `subagent` |
| `subagent_type` | `agent` |
| `task_id` | `sessionID` |
| `permission` | `permissions` |
| `prompt` | `system` |
| flat MCP configuration | nested `mcp.servers` configuration |
| v1 custom tool and plugin contracts | new tool and plugin APIs |

MCP `_meta.sessionID` is correlation metadata only. It is not trusted authorization and cannot substitute for Naru-owned confirmation or a broker-issued authorization record. All v2 assumptions remain provisional until checked against a stable public release and exercised by the full conformance suite.

## First milestone completed

The first milestone established a bounded compatibility foundation rather than completing the overhaul:

- Created `overhaul/host-agnostic` and installed the pinned v2 beta in an isolated local profile.
- Added finite stable and `v2-beta-exploratory` compatibility profiles.
- Made strict version parsing fail closed for malformed, unknown, unlisted, and prerelease versions.
- Updated doctor behavior to report supported stable installations without treating exploratory beta evidence as release support.
- Added a stable exact-version CI smoke lane and a secure v2 lane that downloads, checksum-verifies, inspects, and runs the exact beta artifact in disposable state.
- Updated tests and documentation for the profile and support boundaries.

The original compatibility milestone modified 12 tracked files. Follow-up review
fixes and local-preview implementation are also uncommitted on this branch; inspect
`git diff` for the current inventory rather than treating the original list as final.

### Local coding preview follow-up

The local preview separates its command, configuration, broker state, OpenCode host
data, and worktrees from stable installs. It uses the installed exact beta binary
through plugin-free MCP projections. It provides scoped leaf capabilities, explicit
repository enrollment and exact-model allowlists, durable task/attempt records,
writer worktrees, bounded contained verification, and terminal-confirmed local
integration without commits or delivery. Review defaults are independent of variant
generation. Compatibility evidence now requires all profile checks to pass and
asserts Naru's effective stable agent/routing configuration.

This is a bounded development slice, not completion of milestones 2–9. Semantic
routing, full DAG/gate contracts, restart reconciliation/resume, retention/pins,
Claude Code, delivery, Linux containment, and release distribution remain pending.
Interrupted attempts are not retried automatically; uncertain integration blocks
replay. The migrated reference page now describes this architecture instead of the
superseded instruction to avoid a durable Naru coordination store.

Historical follow-up verification recorded on 2026-09-06 on macOS arm64 with
Node 24.15.0: 162/162 Node tests, 128/128 installer checks, Bun 1.3.9 transport,
TypeScript build, 15-page documentation build, all 11 stable compatibility checks,
and the native beta local workflow passed. This historical smoke used stable
OpenCode 1.18.28; it is separate from the latest stable-version gate below.
The native workflow proved broker-only tool exposure, exact-model writer dispatch,
scoped editing, contained checks, unchanged source before approval, digest rejection,
successful finite integration, and rejection of repeated integration. Broker tests
also covered leaf denial, cancellation, stale writes, idempotency, and restart revocation.
The adapter waits across the pinned beta's MCP registration debounce before inference.
Provider login used a shared preview-only OpenCode database; real account login and
paid-provider inference remained user verification steps.

Files changed by the review-fix and local-preview follow-up (the earlier compatibility
milestone edits are preserved):

| File | Follow-up change |
| --- | --- |
| `tools/naru-lib/compatibility.mts` | Require every profile check, reject duplicate IDs, and fail incomplete evidence. |
| `scripts/naru-compat-smoke.mts` | Assert effective stable agents, leaf permissions, routing variants, and review defaults. |
| `tests/compatibility.test.mts` | Cover incomplete evidence and a disabled/no-op plugin. |
| `tools/naru-lib/review-defaults.mts` | Add a pure host-independent review-default renderer. |
| `tools/naru-lib/dispatch.mts` | Reuse the independent renderer from the legacy adapter. |
| `plugins/naru-dispatch.ts` | Apply review defaults even when variant generation fails. |
| `tests/dispatch.test.mts` | Verify review defaults survive invalid routing configuration. |
| `tools/naru-check.ts` | Add contained verification for legacy runner/writer roles. |
| `tools/naru-lib/validate.mts` | Apply one secret-path policy to environment variants, credential/secret directories, and key material while allowing `.env.example`. |
| `tools/naru-lib/worktree.mts` | Integrate immutable approved patch and untracked-file bytes without re-reading a mutable writer source. |
| `agents/naru-runner.md` | Deny shell mutation and route execution through contained checks. |
| `agents/naru-writer.md` | Allow the contained check tool. |
| `install.sh` | Install the contained check tool. |
| `tests/install.test.sh` | Include that tool in installer fixtures. |
| `tools/naru-lib/preview-process.mts` | Bound process groups, wait for native MCP readiness, and contain checks on macOS. |
| `tools/naru-lib/preview-host.mts` | Project native v2 agents, deny native tools, isolate configuration, and share only preview host data. |
| `tools/naru-lib/preview-broker.mts` | Persist scoped attempts and mediate inspection, edits, checks, cancellation, and finite integration. |
| `tools/naru-preview.mts` | Provide local setup, broker/MCP ingress, authentication, models, launch, status, stop, cancellation, and terminal confirmation. |
| `tools/oc2.mts` | Route bare arguments to isolated vanilla v2 and `oc2 naru` arguments to the guarded preview without shell parsing. |
| `tools/install-oc2.mts` | Install a fresh private preview snapshot and refuse existing preview or launcher paths. |
| `tests/oc2.test.mts` | Verify dispatch, argument boundaries, and overwrite refusal. |
| `tests/preview.test.mts` | Verify secret denial, copy bounds, dependency exclusion, runtime-root containment, immutable integration, capabilities, and restart behavior. |
| `scripts/naru-preview-smoke.mts` | Exercise the installed native beta end to end with a local provider fixture, including secret denial and dependency-free checks. |
| `package.json` | Add the reproducible native preview check command. |
| `README.md` | Document preview setup and corrected runner/plugin behavior. |
| `docs/agent-integration.md` | Describe the contained check tool and runner boundary. |
| `docs/src/content/docs/workflows/agents.md` | Update role capabilities and verification workflow. |
| `docs/src/content/docs/reference/opencode-v2-migration.md` | Replace the obsolete migration strategy with the local preview and explicit limitations. |
| `OVERHAUL_PLAN.md` | Record follow-up scope, verification, file inventory, and remaining acceptance work. |

The current `oc2` snapshot is installed at `~/.local/share/naru-preview-oc2`, with
the launcher at `~/.local/bin/oc2`. Bare `oc2` uses the existing isolated
`opencode2-naru` wrapper; `oc2 naru` uses the new preview. The older preview, stable
installation, and beta wrapper were not replaced. The new preview starts unauthenticated.

### Current verification status (2026-09-06)

- Node tests: 168/168 passed (`npm test`).
- Installer checks: 128/128 passed (`npm run test:installer:built`).
- Typecheck: passed.
- Documentation build: passed, 15 pages.
- Pinned v2 mock smoke: passed, including MCP exposure, exact-model dispatch, scoped
  writes, secret denials, contained checks, and immutable integration.
- Beta compatibility: 4/4 passed.
- The installed stable OpenCode is `1.18.29`; it fails the recognized-build gate as
  intended and is not tested support. The version policy remains limited to 1.18.4
  and 1.18.28.
- The preview deployment's `lib/tools` matches the current `.naru-build/tools`.
  Stable/global Naru was deliberately not updated.
- No real provider authentication or inference was run.
- This evidence covers the verification window only; it does not assert that the
  stable binary was unchanged for the entire conversation. Main refs remain
  unchanged, and all edits are uncommitted.

These results validate the first milestone only. They do not establish overhaul completion, v2 parity, or release eligibility.

## Remaining milestones

Complete the work in this order, keeping contracts host-neutral and validating each host through the same conformance expectations:

1. **Separate review defaults from dispatch — implemented locally.** The pure renderer is independent of the v1 adapter, and review defaults still apply when model-variant generation fails. The legacy host still needs its configuration hook until migration is complete.
2. **Finalize contracts.** Define the model catalog and routing contract; host capability and permission contracts; task and attempt lifecycle; authorization records and finite action bundles; evidence records and gates; and mutation contracts. Specify observable behavior before choosing storage or driver internals.
3. **Implement the daemon and durable store.** Persist enrolled repositories, tasks, attempts, DAG edges, gates, authorizations, evidence, pins, retention metadata, worktree ownership, and integration state. Replace process-local one-attempt assumptions with restart-safe transitions and idempotent recovery.
4. **Expose MCP and CLI ingress.** Keep the two surfaces behaviorally aligned, validate all external input, and ensure neither transport can manufacture authorization.
5. **Build plugin-free OpenCode v1 and v2 drivers.** Cover permission enforcement, exact and semantic model routing, lifecycle transitions, cancellation and resume, tools, worktree containment, integration, and delivery. Full conformance evidence is required separately for v1 and v2.
6. **Add Claude Code support.** Support both the top-level host projection and leaf executor driver, then run the same capability, permission, lifecycle, containment, and delivery tests.
7. **Add delivery operations in stages.** Implement local commit first; then push and pull requests; review operations; tags, notes, and releases; npm publishing for user projects; and GitHub Actions promotion. Every stage requires finite authorization, idempotency rules, and evidence before the next stage broadens authority.
8. **Add migration and preview distribution.** Build an importer for existing Naru configuration and a curl-installed preview channel that remains physically and operationally separate from stable Naru.
9. **Retire the plugin.** Deprecate the current OpenCode plugin for one release, retain a documented fallback during that release, and remove it only after plugin-free parity passes.
10. **Merge after acceptance.** Merge into `main` only after all applicable acceptance gates pass and the stable and preview distribution paths have been proven independent.

## Acceptance gates

The overhaul is ready to merge only when all applicable gates have reproducible evidence:

- The host-neutral contracts are versioned, documented, and shared by MCP and CLI without host-specific authority leaks.
- Stable OpenCode v1, a stable public OpenCode v2 release, and Claude Code pass the required conformance suites on supported platforms. Beta v2 results cannot satisfy this gate.
- Permission denial, repository narrowing, read-only fallback, tiered containment, leaf-only execution, and writer-only mutation are tested mechanically.
- Exact and semantic routing tests prove hard eligibility, allowlists, defaults and overrides, soft ranking, and pre-execution-only fallback. An unavailable or failed selected model is surfaced rather than silently replaced after execution begins.
- Task, attempt, DAG, gate, cancellation, resume, and one-attempt invariants survive daemon and host restarts.
- Worktree allocation, broker-owned integration, commits, conflict handling, cleanup, and recovery pass failure-path tests. No executor can integrate or commit independently.
- Confirmation and authorization tests prove that untrusted repository, issue, pull request, tool, model, and MCP metadata cannot authorize an action. A confirmed bundle cannot be broadened or replayed outside its defined scope.
- Durable records omit full transcripts, enforce 30-day retention, preserve pinned records, and retain enough evidence to explain every mutation and delivery result.
- Delivery adapters pass staged success, denial, retry, idempotency, partial-failure, and recovery tests before their capability is enabled.
- macOS arm64 and Linux x64 installers, upgrades, rollback paths, and preview isolation pass from curl bootstrap artifacts published through GitHub Releases.
- Existing stable users have a tested migration path, one deprecation release, and a rollback route before the plugin is removed.
- Release documentation makes the supported matrix and exclusions explicit and does not infer stable support from exploratory evidence.

## Known risks and unresolved constraints

- **Beta churn:** OpenCode v2 contracts and behavior can change before a stable release. Keep the exploratory profile exactly pinned and revalidate against the released API rather than coding broad compatibility guesses.
- **Shared upstream namespaces:** OpenCode v1 and v2 packages and upstream assets share naming space in places. Exact artifact identity, isolated paths, checksums, and explicit profiles are necessary to prevent one generation from contaminating the other.
- **Untrusted MCP metadata:** Ordinary MCP session metadata, including `_meta.sessionID`, provides correlation but no trustworthy proof of who authorized a mutation.
- **Different execution semantics:** A host-native child and an externally created session may differ in permission inheritance, context, cancellation, resume, lifecycle events, and UI visibility. Drivers must normalize only behavior they can prove and expose unsupported capabilities rather than pretending parity.
- **Worktree limits:** Git worktrees isolate working copies and integration flow; they are not operating-system sandboxes. Process, network, credential, and filesystem containment require separate controls and honest capability declarations.
- **Model fallback safety:** Silent fallback can change cost, capability, data handling, or policy eligibility. Semantic fallback is allowed only before execution. Once an attempt starts, a model failure must remain an explicit failed attempt unless the orchestrator authorizes a new one.
- **Process-local attempts:** Current one-attempt behavior is process-local and cannot enforce restart-safe uniqueness or recovery. Durable broker state and idempotent attempt transitions are required before relying on it.
- **Concurrent build race:** Existing commands share and clean `.naru-build`. Concurrent builds can delete or replace another command's artifacts, so verification and future daemon development must avoid concurrent build use until the build output is isolated or serialized.

Where a contract is not finalized, this plan deliberately states required behavior and acceptance evidence rather than prescribing storage schemas, RPC shapes, or host internals.
