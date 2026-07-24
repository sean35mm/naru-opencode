# Changelog

All notable user-visible changes are recorded here. The canonical semantic product version is the contents of [`VERSION`](VERSION).

## Unreleased

### Changed

- Migrated from the five retired Core slash commands and workflow-agent tree to four native on-demand skills: `naru-plan`, `naru-impact`, `naru-triage`, and `naru-review`.
- Kept review dry-run by default; only an explicit current natural-language request to the directly selected orchestrator can make one validated `COMMENT`-only post.
- Simplified the canonical agent surface to `naru-orchestrator` plus seven minions, with depth-1-compatible delegation and optional adaptive lenses.
- Raised automatic read/write concurrency to a combined ten-child pool, allowed explicit user-requested fan-out up to fifty, and raised coordinated same-workspace writing to ten disjoint Weaver-claimed writers.
- Reinstall now retires healthy manifest-owned legacy definitions while preserving, reporting, and backing up modified or unowned paths according to the reviewed preview.

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
