# Naru Product and Audit Roadmap

**Status — 2026-07-21:** Planning document for the accepted local Phase 1 candidate and the work that may follow. This roadmap is not evidence that any phase, check, delivery, benchmark, compatibility claim, or release has been completed.

## Product direction

Naru is an OpenCode-specific, local-first multi-agent platform for its owner and other solo developers. The goal is a complete, supportable balance of safety and productivity—not a sandbox, hosted service, provider-wide control plane, or proven speedup.

### Product principles

1. **OpenCode-specific.** Optimize for OpenCode's actual agent, plugin, TUI, tool, and configuration contracts rather than introducing a broad abstraction that weakens the product.
2. **Local-first.** Keep orchestration, configuration, diagnostics, and evaluation artifacts local unless a user explicitly chooses a delivery action.
3. **Explicit boundaries.** Mutation, provider cost, GitHub posting, and commit/push/release actions require clear, separate authorization boundaries.
4. **Progressive disclosure.** Lead with outcomes and safe defaults; move protocol, routing, alias, and scheduler details into advanced reference material.
5. **Measurable claims.** Tie correctness, compatibility, cost, latency, and concurrency statements to versioned evidence. Do not imply speedup or support that has not been tested.
6. **Compatibility over gratuitous renames.** Preserve public commands, agent IDs, configuration keys, routing prefixes, and protocol IDs unless a justified migration has a compatibility plan.
7. **No remote telemetry by default.** Keep diagnostics bounded and sanitized, and never upload them automatically.

## Phase 1 — Local safety and release baseline

**Status:** `Complete locally; delivery pending`

### Accepted candidate

- Git HEAD: `f5cbb52e2f5f7036c88ddc8a5b22c1bcf201a232`.
- Before `ROADMAP.md`: 25 modified tracked files and 3 new files, all uncommitted.
- The candidate hardens worktree path and ownership handling; scheduler hard ceilings and run/context binding; timeout cleanup and redacted reporting; review-post freshness, deduplication, and process-local serialization; canonical test and CI scripts; installer canonical-root guards; dashboard source-contract and state/helper coverage; and aligned public, development, runtime, and limitations documentation.

### Supplied local evidence

| Check | Supplied result |
| --- | --- |
| Canonical Node test suite | 170/170 passed |
| Bun transport check | Passed |
| Installer suite | 76/76 passed |
| Dashboard contract suite | 12/12 passed |
| Documentation build | 16 pages built |
| Candidate diff check | Passed |
| Final Judge | Accepted the exact candidate |

This evidence is local only. Remote GitHub CI has not run, the changes are uncommitted and unpushed, and no paid live benchmark has run.

### Delivery gate

Before any later phase begins:

- [ ] Review the complete Phase 1 diff together with `ROADMAP.md`.
- [ ] If the candidate changes, rerun the canonical checks affected by the change and obtain a fresh exact-candidate judgment.
- [ ] Obtain explicit authorization before committing or pushing.
- [ ] Keep unrelated Phase 2+ work out of the Phase 1 delivery unit.

**Likely paths:** the current 28-path Phase 1 candidate under `README.md`, `docs/`, `install.sh`, `naru-runtime.example.json`, `package.json`, `.github/workflows/ci.yml`, `tests/`, and `tools/`.

**Dependencies:** none beyond the accepted local candidate and this roadmap review.

**Risks:** a moving candidate invalidates exact-candidate evidence; remote behavior remains unknown until the exact candidate runs in CI; mixing later work makes review and rollback harder.

**Exit criteria:** the Phase 1 + roadmap unit is reviewed, unchanged checks remain applicable or are rerun, explicit delivery authorization is recorded, and the exact candidate is committed/pushed only if authorized.

## Phase 2 — Empirical validation and benchmark evidence

**Objective:** establish reproducible, appropriately bounded evidence about Naru's safety, task quality, latency, cost, and topology without turning provider calls into CI or marketing unsupported speed claims.

### Ordered work

1. **Free deterministic specification.** Define fixtures, schemas, rubrics, invariant checks, sanitized output rules, and a matched baseline. Validate all planning and scoring paths without a provider call.
2. **Paid pilot.** After an exact cost checkpoint, run the smallest useful case set once in a disposable directory. Review safety, cleanup, output sanitization, and actual spend before considering repetition.
3. **Optional comparison matrix.** Only after a second explicit cost checkpoint, run approved cases against matched single-agent OpenCode. Prefer three repetitions for ranges and medians, but only after the pilot is approved.

### Case coverage

Expand beyond the current live `plan-fanout` case with synthetic, repository-safe cases for:

- planning;
- impact analysis;
- bug triage;
- dry-run review;
- scoped implementation;
- isolated-writer success and safe shared-mode fallback;
- scheduler `off`; and
- one deliberately selected `observe` or `enforce` path.

Every case must preserve no-post, no-secret, and no-raw-output boundaries. Fixtures must be synthetic or otherwise approved for the selected provider. Review posting, repository delivery, persistent data writes, and unrelated filesystem mutation are forbidden evaluation actions.

### Predeclared evaluation contract

Before execution, freeze in a human-readable manifest:

- provider, model identifiers, OpenCode version, Naru commit/version, operating system, and date;
- immutable fixture identity, case count, case IDs, permitted mutations, and expected outcomes;
- repetition count, per-case and run timeout, maximum dollar spend, and cost stop condition;
- correctness and rubric criteria, safety invariants, cleanup requirements, and abort conditions; and
- matched single-agent OpenCode baseline configuration, with the same inputs, environment, timeout, model, and rubric wherever the topology permits.

The exact **live-action checkpoint** must restate and obtain approval for: provider, models, disposable directory, network target, cases, repetitions, timeout, and maximum spend. Paid evaluation remains manual and must never run in CI.

### Measurements and reporting

Capture only what is necessary to report:

- safety-invariant pass/fail;
- task and rubric correctness decisions;
- end-to-end and relevant structural latency;
- cost/token data when the provider exposes it safely and comparably;
- topology, observed concurrency, routing, and fallback mode; and
- timeout, cancellation, worktree, and process cleanup outcomes.

Report medians and ranges across repetitions, plus failures and missing data. Do not turn concurrency observations into provider-wide guarantees or latency observations into unsupported speed claims.

Persist only sanitized structural aggregates and explicit rubric decisions tied to immutable versions and date. Never persist prompts, source, diffs, model outputs, credentials, session tokens, or provider tokens. Publishing results or changing README/docs/marketing claims requires a separate checkpoint after artifact review.

### Work map

**Likely existing paths:** `scripts/naru-live-eval.mjs`, `tools/naru-lib/evaluation.mjs`, `tools/naru-lib/live-evaluation.mjs`, `tools/naru-lib/opencode-live-evaluation.mjs`, `tests/fixtures/live-evals.json`, `tests/evaluation.test.mjs`, `tests/live-evaluation.test.mjs`, `tests/behavioral-evals.test.mjs`, `README.md`, and `docs/src/content/docs/reference/limitations.md`.

**Potential planned/new paths:** `tests/fixtures/live-evals/` for isolated synthetic repositories and `evaluation-results/` for reviewed, sanitized aggregate artifacts. Their names and retention policy must be approved before creation.

**Dependencies:** delivered or otherwise frozen Phase 1 baseline; available disposable test directory; exact OpenCode/provider versions; approved pilot budget.

**Risks:** provider nondeterminism, accidental data capture, incomparable baselines, cost overrun, ambiguous cancellation, topology visibility gaps, and overgeneralization from a small sample.

**Stop/go gates:** stop after deterministic specification review; stop before the paid pilot; stop after pilot review; stop before a comparison matrix; stop before publishing or changing public claims.

**Exit criteria:** deterministic cases and rubrics pass locally; the paid pilot, if authorized, stays within its contract and cleans up; any approved repetitions produce a sanitized immutable aggregate with limitations; baseline comparison is matched; no source/raw output is retained; public claims remain unchanged until separately approved.

## Phase 3 — Product clarity, onboarding, lifecycle, and local diagnostics

**Objective:** make the first successful use outcome-led and make local installation state understandable and reversible without hiding advanced capability.

### First-run journey

Present four choices in this order:

1. **Analyze:** four read-only workflows—plan, impact, triage, and dry-run review.
2. **Implement:** select `naru-orchestrator` for authorized scoped work.
3. **Runtime safety (optional):** leave scheduling `off`, or deliberately choose `observe`/`enforce` after reading compatibility requirements.
4. **Activity:** optionally install and open the dashboard.

Publicly describe **Full Ultra** as isolated parallel implementation. Put Protocol 2/3 mechanics, model profiles, generated aliases, and routing internals in advanced reference. Preserve slash commands, agent IDs, configuration keys, routing prefixes, and protocol IDs unless evidence justifies a migration with compatibility and deprecation handling.

Align the root `README.md` with the safe quickstart: effective `subagent_depth >= 2`, the distinction between slash commands and primary-agent selection, and exactly one next action plus any required OpenCode restart at each setup endpoint.

### Evidence-first onboarding and diagnostics

Before adding code, perform fresh, recorded walkthroughs on macOS and Ubuntu using disposable homes/projects and the documented global/project/custom plus copy/symlink modes. Record where users cannot determine loaded scope, effective settings, or update state.

Only if recurring undiagnosable states are confirmed, add a provider-free, read-only doctor/status surface that reports:

- loaded global/project/custom scopes and installed Naru version;
- stale copy-pinned or mixed-generation managed assets;
- effective `subagent_depth` and the source that wins;
- OpenCode/runtime compatibility;
- routing and scheduler/runtime configuration; and
- dashboard installation/registration.

Reports must be bounded, sanitized, path-conscious, and safe to share. They must not inspect credentials, invoke providers, mutate configuration, or upload anything.

### Lifecycle plan

Design install/update/rollback/uninstall metadata around a versioned manifest of exact managed ownership, selected options, source version, location mode, and copy/symlink method.

- Preview changes by default and clearly separate inspection from mutation.
- Preserve unrelated files and managed files modified after installation; require an exact user choice for conflicts.
- Cover global, project, and custom targets plus copy and symlink installs.
- Document backup creation, retention, pruning, and rollback limits.
- Keep actual uninstall destructive and available only after an exact user action; exercise it solely against disposable fixtures in tests.
- Do not add curl-pipe-shell installation or automatic self-update.

### Work map

**Likely existing paths:** `README.md`, `docs/user-guide.md`, `docs/src/content/docs/index.mdx`, `docs/src/content/docs/getting-started/installation.md`, `docs/src/content/docs/getting-started/quickstart.md`, `docs/src/content/docs/concepts/protocols.md`, `docs/src/content/docs/reference/runtime-config.md`, `install.sh`, `tests/install.test.sh`, `scripts/merge-opencode-config.mjs`, `scripts/merge-tui-config.mjs`, and `plugins/naru-minions-dashboard.tsx`.

**Potential planned/new paths (only if walkthrough evidence supports them):** `tools/naru-doctor.js`, `tests/doctor.test.mjs`, and a versioned install-manifest schema under `tools/naru-lib/`.

**Dependencies:** stable Phase 1 behavior; approved public terminology; access to clean macOS and Ubuntu fixtures; a reviewed draft compatibility-assumptions input that Phase 3 walkthroughs validate and Phase 4 later finalizes.

**Risks:** documentation duplication, misleading scope detection, stale manifests, accidental deletion of user files, backup accumulation, and copy/symlink mixed-generation ambiguity.

**Stop/go gates:** walkthrough review before code; diagnostic design review before creating a command/tool; lifecycle preview review before mutation support; exact confirmation before any real uninstall trial.

**Exit criteria:** both OS walkthroughs are reproducible; quickstart reaches one safe outcome with an unambiguous restart/next action; any added doctor is provider-free, read-only, bounded, and fixture-tested; lifecycle previews accurately classify owned/unrelated/modified files; disposable fixture tests cover install, update, rollback, and uninstall without touching real user configuration.

## Phase 4 — Compatibility contract and matrix

**Objective:** state and continuously verify the support envelope without claiming untested platforms or interfaces.

### Contract

Define and publish:

- tested OpenCode floor and current-stable policy;
- tested macOS and Ubuntu versions/architectures;
- supported Node, Bun, Git, and `gh` floors/current versions by feature;
- full TUI and dashboard behavior, including explicit mini-TUI exclusions; and
- explicit Windows and WSL status. Native Windows is unsupported until tested; WSL support must likewise be earned by evidence.

Expand CI beyond Ubuntu/Node 24 only where the contract or failure evidence warrants it. Add provider-free OpenCode boot/plugin/config smoke coverage at floor and current stable, a dashboard compile/load contract against each supported runtime, and install/update/rollback coverage across the supported location and copy/symlink matrix.

Provider calls stay out of CI. Merely adding a CI workflow is not evidence: only a successful run against the exact immutable candidate counts.

### Work map

**Likely existing paths:** `.github/workflows/ci.yml`, `.github/workflows/docs.yml`, `package.json`, `docs/package.json`, `install.sh`, `tests/install.test.sh`, `tests/config-policy.test.mjs`, `tests/dashboard-contract.test.mjs`, `tests/bun-transport.test.mjs`, `plugins/naru-delegate.js`, `plugins/naru-scheduler.js`, and `plugins/naru-minions-dashboard.tsx`.

**Potential planned/new paths:** a compatibility policy page under `docs/src/content/docs/reference/` and provider-free OpenCode smoke fixtures under `tests/fixtures/`.

**Dependencies:** Phase 3 walkthrough evidence; available pinned OpenCode floor/current artifacts; a documented dashboard runtime contract; controlled CI budget/time.

**Risks:** OpenCode/OpenTUI drift, mutable CI dependencies, OS-specific shell behavior, false confidence from shallow startup checks, and expanding a matrix faster than it can be maintained.

**Stop/go gates:** approve the support contract before matrix expansion; review every added matrix axis for demonstrated value; require exact-candidate CI before changing support claims.

**Exit criteria:** the support table names tested versions and explicit exclusions; provider-free floor/current boot, plugin, config, dashboard, and lifecycle checks pass locally where applicable and in exact-candidate CI; failures are reproducible; docs make no broader claim than the matrix proves.

## Phase 5 — Release identity, governance, and release candidate

**Objective:** create the minimum durable release discipline a solo maintainer needs, then prove one immutable release candidate.

### Minimal governance

Add only after content review:

- one canonical `VERSION` source and a defined SemVer policy;
- deprecation and migration rules;
- `CHANGELOG.md`;
- `SECURITY.md` with a private reporting route;
- `SUPPORT.md`; and
- `CONTRIBUTING.md`.

These are **planned/new paths**. Avoid heavyweight governance, committees, or process documents until usage demonstrates a need.

### Dependency and release stewardship

- Pin GitHub Actions to reviewed immutable revisions where practical, with readable version comments if needed.
- Obtain prior authorization for any dependency change before updating documentation dependencies, and keep authorized documentation-dependency changes controlled and reviewable with build evidence.
- Keep releases manual; no automatic release, tag, or publication path.

### Immutable release-candidate gate

An RC is eligible only when all of the following refer to one unchanged candidate:

- [ ] clean candidate worktree and immutable commit identity;
- [ ] canonical local checks pass;
- [ ] exact-candidate remote CI passes;
- [ ] compatibility matrix evidence matches documented support;
- [ ] a sanitized evaluation artifact exists, or the release explicitly states that paid comparative evidence is absent;
- [ ] disposable install/update/rollback/uninstall fixtures pass;
- [ ] built docs match the candidate and distributable artifact;
- [ ] changelog, migration notes, canonical version, artifact version, and proposed tag agree; and
- [ ] no unresolved P0/P1 issue remains.

Commit, push, tag, GitHub Release creation, and docs publication are separate explicit delivery checkpoints. This roadmap authorizes none of them.

Defer package-manager/marketplace distribution, signing/SBOM, issue templates, and marketing assets until evidence of need, unless a specific item is demonstrably cheap and low-maintenance after the RC is complete.

### Work map

**Likely existing paths:** `README.md`, `docs/development.md`, `docs/user-guide.md`, `docs/src/content/docs/`, `.github/workflows/ci.yml`, `.github/workflows/docs.yml`, `package.json`, `docs/package.json`, `install.sh`, and `LICENSE`.

**Planned/new paths:** `VERSION`, `CHANGELOG.md`, `SECURITY.md`, `SUPPORT.md`, and `CONTRIBUTING.md`.

**Dependencies:** completed Phase 4 contract/evidence; reviewed Phase 2 evaluation statement; proven Phase 3 lifecycle; an explicitly selected RC candidate.

**Risks:** version drift, mutable action tags, dependency churn, docs/artifact mismatch, accidental publication, and governance overhead disproportionate to a solo-maintainer project.

**Stop/go gates:** approve governance text before adding files; freeze the RC before broad verification; re-freeze after any change; obtain independent explicit authorization at every delivery checkpoint.

**Exit criteria:** one version source drives documented release identity; governance files are accurate and maintainable; every RC checklist item is tied to the same immutable candidate; deferred distribution work remains out of scope; no delivery occurs without its own authorization.

## Phase 6 — Maintenance loop

**Objective:** keep compatibility and evidence current with the smallest sustainable recurring process.

- Run free deterministic and compatibility checks for Naru releases and relevant OpenCode stable changes.
- Consider a small paid sentinel only when prompts, routes, models, or session behavior change, and only after explicit budget and live-action approval.
- Track the compatibility matrix, known limitations, migrations, documentation drift, dependency updates, and benchmark provenance.
- Keep changelog and migration guidance synchronized with each release candidate.
- Never schedule paid benchmarks, enable remote telemetry, or automatically upload diagnostics.

**Likely paths:** `tests/`, `tests/fixtures/`, `.github/workflows/ci.yml`, `.github/workflows/docs.yml`, `docs/`, `README.md`, `package.json`, `docs/package.json`, and the planned Phase 5 governance/version files.

**Dependencies:** a released compatibility contract and minimal governance; a known-good deterministic evaluation suite; explicit approval for any paid sentinel.

**Risks:** silent OpenCode/OpenTUI drift, stale docs, dependency abandonment, benchmark version ambiguity, and maintenance work expanding without user value.

**Stop/go gates:** classify each upstream or Naru change before adding checks; use free evidence first; stop for budget approval before every paid sentinel; stop for delivery approval before each release action.

**Exit criteria:** each release has current free checks, compatibility and limitation notes, migration guidance where needed, dependency review, and traceable benchmark provenance; no paid or uploaded activity occurs implicitly.

## Cross-phase gate matrix

| Phase | Entry criteria | Required evidence | User checkpoint | Exit criteria |
| --- | --- | --- | --- | --- |
| 1. Local baseline | Accepted candidate at the stated HEAD and baseline status | Supplied local check counts, diff check, exact-candidate Judge | Review Phase 1 + roadmap; separately authorize commit/push | Reviewed delivery unit; changed checks rerun; delivery only if authorized |
| 2. Empirical validation | Frozen Phase 1 and reviewed deterministic spec | Versioned fixtures/rubrics, safety invariants, matched baseline, sanitized aggregate | Approve pilot contract/cap; approve repetitions; separately approve publication/claim changes | Bounded pilot/matrix evidence with cleanup, provenance, and limitations |
| 3. Clarity and lifecycle | Stable behavior and approved terminology | Fresh macOS/Ubuntu walkthroughs; provider-free fixture results for any new diagnostics/lifecycle operations | Approve code after walkthrough findings; exact action for destructive uninstall | Safe first run; bounded doctor if justified; proven preview/update/rollback/uninstall fixtures |
| 4. Compatibility | Walkthrough data and draft support policy | Floor/current provider-free smoke, OS/runtime/dashboard/lifecycle matrix, exact-candidate CI | Approve support envelope and material CI expansion | Published claims equal exact-candidate evidence; unsupported targets are explicit |
| 5. Release candidate | Phases 2–4 evidence or explicit documented omissions | Clean immutable RC, local + remote checks, compatibility/lifecycle/docs/version consistency, no P0/P1 | Separate approval for commit, push, tag, GitHub Release, and docs publication | One supportable RC/release identity; no implicit delivery |
| 6. Maintenance | Released contract, governance, and deterministic suite | Per-release checks, drift/dependency review, migrations, benchmark provenance | Approve each paid sentinel and each delivery action | Current evidence and docs with no scheduled spend, telemetry, or upload |

## Residual risks carried forward

These are current architectural or integration limits, not promises that later phases will eliminate them:

1. Scheduler and review-post coordination are process-local, not durable across processes.
2. Review posting has an unavoidable interval between the final review read and POST; an ambiguous POST outcome is not retried, so success can remain unknown.
3. Timeout cleanup targets direct child processes and does not guarantee complete process-group termination.
4. Worktrees improve ownership and recovery but are not sandboxes against unrelated concurrent filesystem mutation.
5. OpenCode and OpenTUI plugin, configuration, session, and rendering interfaces can drift.
6. Documentation appears in multiple surfaces and can diverge.
7. Copy-pinned assets can produce mixed-generation installs when updates are incomplete or flags differ.

## Explicit non-goals

- Hosted control plane, accounts, or team collaboration.
- Remote analytics or telemetry.
- A durable cross-process scheduler unless measured need justifies it.
- Provider-wide concurrency guarantees.
- Automatic merge, deploy, tag, release, or docs publication.
- Native Windows support without a tested contract; WSL is also not implied.
- Automatic paid CI evaluation or scheduled provider spend.
- Speedup claims before matched, versioned evidence exists.
- Broad provider abstraction that weakens the OpenCode-specific focus.

## Immediate next decision

Review `ROADMAP.md` together with the complete Phase 1 diff. Then decide whether to authorize the Phase 1 commit and push. No commit, push, tag, release, publication, benchmark, or other delivery authorization is implied by this roadmap.
