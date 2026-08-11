# Changelog

All notable user-visible changes are recorded here. The canonical semantic product version is the contents of [`VERSION`](VERSION).

## Unreleased

### Added

- Added schema v3 formal pull-request review decisions: explicit current-message policies can authorize evidence-gated `APPROVE` or `REQUEST_CHANGES`, while the posting tool derives the event and accepts no raw event input.
- Added limited-evidence review comments with a generated warning; incomplete inventory or feedback integrity remains unpostable.

### Fixed

- Replaced patch-size heuristics with structural patch-completeness validation so complete large patches remain formally eligible while malformed, missing, redacted, or bounded-out evidence fails closed.

## [0.4.1] - 2026-08-10

### Fixed

- Hardened pull-request review posting with machine-readable mutation state, strict canonical-or-alias schema handling, complete-body size checks, and limitation-aware deduplication. Honest limitations remain publishable for complete reviews, while corrected tool calls are allowed only after a correctable pre-POST rejection; attempted or unknown POST outcomes remain terminal and never use another mutation path.
- Expanded the tool's nested schema and contract tests for aliases, fail-closed dual keys, preflight correction, mutation outcomes, limitations, body bounds, deduplication, and posting policy.

## [0.4.0] - 2026-08-07

### Added

- `naru doctor` validates the `models` block: it reports the configured class names and raises `invalid-models-block` with the exact parse error when the block is malformed — previously a typo silently removed every generated variant, since the plugin fails open by design.

### Changed

- `naru-dispatch` now works through generated agent variants instead of a custom tool. The plugin's config hook clones the base subagents into hidden per-class variants — `naru-reader-<class>`, `naru-runner-<class>`, `naru-writer-<class>` — with the class's model and thinking effort baked in, and the orchestrator dispatches them through OpenCode's native `task` tool. This restores the TUI's native subagent rendering: proper cards, click-to-open child threads, and thread cycling, with the class visible in the agent name. The `models` block in `naru-runtime.json` is unchanged; a class's first authenticated chain entry is baked into its variants at startup.

### Removed

- The `naru-dispatch` tool and its SDK session path. Model selection no longer creates sessions by hand, so Naru no longer carries custody of session-creation safety invariants — variants are byte-for-byte permission clones of the base agents, and OpenCode's task tool owns spawning end to end. The per-dispatch `effort` override is expressed as additional classes (for example `deep-max`) rather than a call argument.

## [0.3.0] - 2026-08-07

### Added

- The `naru-dispatch` plugin and tool: the orchestrator can now pick a model class per dispatch. An optional `models` block in `naru-runtime.json` maps class names (for example `light`, `standard`, `deep`) to ordered model chains like `"openai/gpt-5.6-sol@high"`; the tool description is generated from the configured classes, an optional per-dispatch `effort` overrides the chain default, chains fall through on failure, and an unconfigured or fully failed chain inherits the parent session model instead of failing the dispatch.
- Dispatch visibility: the running tool title and the child session title carry `agent · provider/model@effort`, results name the model that actually ran (including fallbacks), and the orchestrator reports a one-line dispatch ledger.

### Security

- Dispatched children are bound to their agent by name, so OpenCode applies the agent's own permission frontmatter; the dispatch prompt body never carries a `tools` map, session permissions passed at create are deny-only, only `naru-orchestrator` may call the tool, and children are denied `naru-dispatch` and `task`, keeping delegation at depth 1.

## [0.2.1] - 2026-08-06

### Fixed

- `naru install` and `naru upgrade` now pin copies instead of symlinks. A symlinked release install pointed into `~/.naru/versions/<version>`, which later upgrades supersede and users may prune, leaving dangling links in the OpenCode config. Installing from a cloned checkout with `install.sh` still defaults to symlinks, where `git pull` is the point.

## [0.2.0] - 2026-08-06

A large simplification. Naru is now thin hard walls and a free interior: the walls
are mechanical, and inside them the orchestrator plans and fans out on its own
judgment.

### Added

- `bootstrap.sh` and a `naru` command. `curl -fsSL .../bootstrap.sh | sh` downloads a checksum-verified release into `~/.naru` and installs the CLI without touching OpenCode configuration. `naru install`, `upgrade`, `doctor`, `uninstall`, `rollback`, and `version` front the existing installer; every mutating command previews and asks before applying.
- A release workflow that verifies the tag matches `VERSION`, runs the suites, publishes a tarball with a SHA-256 checksum, and installs that tarball into a disposable HOME before publishing.

### Changed

- Simplified the agent surface to `naru-orchestrator` plus three subagents: `naru-reader`, `naru-runner`, and `naru-writer`. Only `naru-writer` can edit files; readers are fail-closed read-only with no shell. Delegation remains depth-1.
- Agents no longer declare a `model:`; each inherits the user's configured OpenCode default, so Naru runs on any provider without configuration. Per-agent models are set through OpenCode's native `agent` block in `opencode.json`.
- Replaced fixed analysis modes and child-count ceilings with orchestrator judgment. The only concurrency setting is the `implementation.maxConcurrentWriters` brake.
- Migrated from the five retired Core slash commands and workflow-agent tree to four native on-demand skills: `naru-plan`, `naru-impact`, `naru-triage`, and `naru-review`.
- Kept review dry-run by default; only an explicit current natural-language request to the directly selected orchestrator can make one validated `COMMENT`-only post.
- Reinstall retires healthy manifest-owned legacy definitions while preserving, reporting, and backing up modified or unowned paths according to the reviewed preview.

### Removed

- Scheduling Protocol 2 and Protocol 3, the `naru-scheduler` tool and plugin, admission tokens, run manifests, work-item DAGs, and quality artifacts. Protocol 3 defaulted to `off` and could not refuse anything in `observe`.
- The `naru-delegate` plugin, generated model aliases, Sol xhigh escalation, and `naru-models.json`.
- The Naru Activity dashboard plugin, its TUI registration, and scheduler telemetry. Naru now ships no plugins.
- The TypeScript `src/` tree and release-candidate assembler; `tools/` and `scripts/` are now edited directly as plain JavaScript.
- The live-evaluation harness, and `--with-dashboard`, which is now a deprecated accepted no-op.

### Limitations

- Removing Protocol 3 removes no real enforcement: it was process-local, non-durable, off by default, and fail-open in `observe`. Enforcement continues to come from OpenCode's permission evaluation, the comment-only posting tool, and worktree path containment.
- Prompt policy is not a sandbox. Checkpoints, scope discipline, and evidence requirements are instructions to a model, not mechanisms.

## [0.1.0] - 2026-07-22

### Added

- Read-only `/naru-plan`, `/naru-impact`, `/naru-triage`, and `/naru-review` workflows, plus the explicit comment-only `/naru-review-post` boundary.
- The visible `naru-orchestrator` and Naru Minions workflow for scoped implementation, debugging, verification, and judgment, with fail-closed role permissions.
- Naru Delegate routing across Luna, Terra, and Sol profiles while preserving OpenCode's native Task and child-session behavior.
- Optional Protocol 2/3 scheduling, bounded shared or isolated worktree execution, transactional recovery metadata, and the opt-in full-TUI Naru Activity dashboard.
- Transactional installation with preview/apply boundaries, ownership manifests, conflict handling, backups, rollback, uninstall, and the provider-free read-only local doctor.
- Provider-free deterministic evaluation of sanitized summaries and a contract-gated live-evaluation scaffold whose current local adapter fails closed before OpenCode or provider execution.
- User, development, runtime, safety, and integration documentation, with repository CI covering Node tests, the Bun smoke test, installer tests, documentation builds, and whitespace checks.

### Limitations

- The scheduler is process-local and optional; it is not a sandbox, provider-wide concurrency cap, cross-process coordinator, or proof that reports or background work are correct.
- Worktree isolation is narrow Naru-owned recovery tooling and does not protect against unrelated external workspace mutation. Dashboard telemetry is unavailable in `opencode --mini` and is not global or durable.
- The initial entry does not establish a complete OpenCode, operating-system, runtime, dashboard, or compatibility support matrix. The existing [compatibility reference](docs/src/content/docs/reference/compatibility.md) records the release target, exclusions, and provider-free evidence boundary without claiming that the matrix passed.
- No paid benchmark, live model-quality result, or compatibility evidence is claimed by this entry. The contract-gated scaffold currently fails closed before OpenCode or provider execution, so no live-pilot result or provider cost is claimed.
