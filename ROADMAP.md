# Naru Roadmap

**Status — 2026-09-28.** Planning document. Nothing here is evidence that a phase,
check, benchmark, or release has been completed.

Naru is thin hard walls and a free interior. The walls stand at the irreversible
edges and are mechanical rather than advisory; inside them the coordinator is
trusted to plan and delegate on its own judgment. This roadmap is about making that
trustworthy to strangers, then proving it is worth using.

## Product direction

Naru is an OpenCode extension for solo developers and small teams. The goal is a
complete, supportable balance of safety and productivity — not a sandbox, a hosted
service, a provider-wide control plane, or a proven speedup.

### Principles

1. **Enforcement over prose.** A rule no permission enforces is a suggestion. Prefer
   deleting a concept to documenting it.
2. **OpenCode-native.** Use OpenCode's own agent, tool, and configuration contracts.
   Do not reimplement platform infrastructure.
3. **Local-first.** Orchestration, configuration, and diagnostics stay local unless
   the user explicitly chooses a delivery action.
4. **Inspectable mutation.** Every action that changes a user's machine reports
   exactly what it changed, and supports `--dry-run` to show the plan first. This is
   the product's identity, not a feature.
5. **Provider-neutral.** Naru must run on whatever model the user already has.
6. **Measurable claims.** Tie correctness, cost, and concurrency statements to
   versioned evidence. Never imply a speedup that was not measured.
7. **No remote telemetry.** Diagnostics stay bounded, sanitized, and local.

## Phase 1 — A stranger can install it and it works

**Status:** `Mostly done`

Checksum-verified releases, `bootstrap.sh`, and the `naru` CLI (`install`, `uninstall`,
`configure`, `models`, `upgrade`, `doctor`, `version`) exist. Naru targets OpenCode v2 only; the v1
installer shipped for the last time in 0.9.0.

### Remaining

1. **Native rollback.** `naru rollback` is not available for native installs.
2. **Release matrix evidence.** Record the qualified OpenCode, Node, and platform
   combinations per release.

**Exit criteria:** on a machine with only OpenCode 2.0.x, Node 24, and a configured model of
any provider, `curl … | sh` followed by `naru install` and `naru configure` yields a working
Naru, and `naru upgrade` and a native uninstall both work without hand edits.

## Phase 2 — Trustworthy at rest

**Status:** `Not started`

The credibility layer that makes someone comfortable pointing Naru at a real
repository.

- **Stability contract.** State which agent names, tool IDs, and `.naru-native` file
  schemas are public API, and what a breaking change to them requires.
- **Semver discipline.** `VERSION` is the source of truth; `CHANGELOG.md` records only
  user-visible, evidence-backed claims tied to real tags.
- **Supply-chain honesty.** Checksum verification on every download. Document exactly
  what the bootstrap executes and what it can reach.
- **Contribution surface.** Issue and PR templates, a triage habit, and an honest
  `SUPPORT.md` about what one maintainer can promise.

**Exit criteria:** a stranger can read one page and know what will not break under
them, and can verify what the installer ran.

## Phase 3 — Evidence it is actually better

**Status:** `Not started` · **Do not start before Phase 2**

One question: does Naru beat plain OpenCode on real tasks, and where does it not?

Keep this small and honest. A handful of representative tasks — a scoped feature, a
bug fix, a review — run through Naru and through plain OpenCode with the same model
and inputs. Report medians, ranges, and failures. Publish the cases and the raw
decisions, not a marketing number.

Constraints: paid evaluation stays manual and never runs in CI, requires an explicit
cost checkpoint before it runs, uses disposable directories, and never posts, writes
to a database, or touches a real repository. Persist only sanitized aggregates tied to
an exact version.

If the honest answer is "no better for task X," that belongs in the docs. A tool that
names where it does not help is more trustworthy than one that claims to always help.

**Exit criteria:** a published, reproducible comparison that a skeptical reader can
re-run, including the cases where Naru lost.

## Residual risks

1. **Prompt policy is not enforcement.** Checkpoints, scope discipline, and evidence
   requirements are instructions to a model. Only the per-agent permission rules, the
   posting tool's `naru`-only boundary and derivation of `COMMENT`, `APPROVE`, or
   `REQUEST_CHANGES` from asserted current-message policy plus final evidence gates, and
   worktree path containment are mechanical. The worker shell denies are prefix globs and
   can be evaded by wrapper commands.
2. **Naru is not a sandbox.** It does not contain repository code, package scripts, or
   shell commands.
3. **One maintainer.** Response times and support scope are bounded by that.
4. **Upstream churn.** OpenCode 2.x may change agent, tool, or permission contracts; Naru
   accepts only 2.0.x until a newer minor is tested.

## Non-goals

A hosted service. A workflow DSL or TUI. A durable scheduler or job store. Remote
telemetry. A general-purpose agent framework. Support for editors other than OpenCode.
