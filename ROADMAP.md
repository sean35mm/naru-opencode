# Naru Roadmap

**Status — 2026-08-06.** Planning document. Nothing here is evidence that a phase,
check, benchmark, or release has been completed.

Naru is thin hard walls and a free interior. The walls stand at the irreversible
edges and are mechanical rather than advisory; inside them the orchestrator is
trusted to plan and fan out on its own judgment. This roadmap is about making that
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
4. **Preview before mutation.** Every action that changes a user's machine shows
   exactly what it will do first. This is the product's identity, not a feature.
5. **Provider-neutral.** Naru must run on whatever model the user already has.
6. **Measurable claims.** Tie correctness, cost, and concurrency statements to
   versioned evidence. Never imply a speedup that was not measured.
7. **No remote telemetry.** Diagnostics stay bounded, sanitized, and local.

## Phase 1 — A stranger can install it and it works

**Status:** `Not started` · **Blocks everything else**

Today a stranger must clone the repo, run a shell script, and then discover that all
agents are pinned to `openai/gpt-5.6-*` models they may not have. Both halves of that
are fatal to adoption.

### Work

1. **Releases.** No git tag or GitHub release exists. Tag `v0.2.0`; add a workflow
   that, on tag, verifies CI is green, builds a tarball of the installable asset set
   (`agents/`, `skills/`, `tools/`, `install.sh`, `naru-runtime.example.json`,
   `VERSION`), and attaches it with a SHA-256 checksum.
2. **`bootstrap.sh`.** Small, auditable, curl-able. Installs exactly one file —
   `~/.naru/bin/naru` — and touches nothing else. Prints the line to add to `PATH`;
   edits a shell profile only with an explicit `--modify-path`.
3. **`naru` CLI.** A thin front door over the existing installer and doctor, not a
   reimplementation: `install`, `upgrade`, `doctor`, `uninstall`, `rollback`,
   `version`. Every mutating command previews and prompts; `--apply` is available for
   non-interactive use. Versions live at `~/.naru/versions/<v>` with `current` as a
   symlink, so rollback is a pointer flip.
4. **Provider neutrality.** Drop `model:` and `variant:` from the agent frontmatter so
   agents inherit the user's configured default model. Remove `naru-reader-deep`; with
   no model difference it is indistinguishable from `naru-reader`, and a lens belongs
   in the dispatch prompt. Final roster: `naru-orchestrator`, `naru-reader`,
   `naru-runner`, `naru-writer`.
5. **Docs.** Curl install as the primary path, clone-and-run as the alternative, and a
   section on overriding any agent's model or permissions through the native
   `agent` block in `opencode.json`.

**Exit criteria:** on a machine with only OpenCode, Node 24, and a configured model of
any provider, `curl … | sh` followed by `naru install` yields a working Naru, and
`naru upgrade` moves it to a newer release and back via `naru rollback`.

## Phase 2 — Trustworthy at rest

**Status:** `Not started`

The credibility layer that makes someone comfortable pointing Naru at a real
repository.

- **Stability contract.** State which agent IDs, tool names, and configuration keys
  are public API, and what a breaking change to them requires.
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

## Phase 4 — OpenCode v2

**Status:** `Blocked on upstream`

Fully specified in the
[v2 migration plan](docs/src/content/docs/reference/opencode-v2-migration.md).
The v-next simplification deleted the deepest v1 couplings — the Protocol 3 scheduler,
the delegate plugin, the dashboard — so what remains is agent definitions, five custom
tools, and one worktree adapter.

Permission inheritance is the gate. Naru's entire safety model rests on only
`naru-writer` holding `edit`. Verify that first; if it does not hold, nothing else is
worth migrating.

## Residual risks

1. **Prompt policy is not enforcement.** Checkpoints, scope discipline, and evidence
   requirements are instructions to a model. Only the permission map, the posting tool's
   orchestrator-only boundary and derivation of `COMMENT`, `APPROVE`, or `REQUEST_CHANGES`
   from asserted current-message policy plus final evidence gates, and worktree path containment
   are mechanical.
2. **Naru is not a sandbox.** It does not contain repository code, package scripts, or
   shell commands.
3. **One maintainer.** Response times and support scope are bounded by that.
4. **Upstream churn.** OpenCode v2 may change agent, tool, or permission contracts.

## Non-goals

A hosted service. A workflow DSL or TUI. A durable scheduler or job store. Remote
telemetry. A general-purpose agent framework. Support for editors other than OpenCode.
