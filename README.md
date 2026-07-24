# Naru for OpenCode

Multi-agent workflows for [OpenCode](https://opencode.ai).

- **Naru skills** provide on-demand planning, impact analysis, bug triage, and pull-request review guidance.
- **Naru Minions** provides a visible `naru-orchestrator` primary agent for scoped implementation, debugging, verification, and judgment.
- **Naru Delegate** exposes Luna, Terra, and Sol model-fit routes without replacing OpenCode's native Task permissions or child sessions.
- **Naru Scheduler** optionally observes or enforces process-local Protocol 3 admission and quality gates; it is installed off by default.

Built by [Naru Labs](https://github.com/sean35mm).

**Documentation site:** [sean35mm.github.io/naru-opencode](https://sean35mm.github.io/naru-opencode/)

## Public entry points

Ask naturally for a plan, impact analysis, bug triage, or pull-request review, or say “Use the `naru-plan` skill…” (likewise `naru-impact`, `naru-triage`, or `naru-review`). OpenCode discovers these four native skills on demand; they are not slash commands and do not run a fixed workflow topology.

For implementation work or review posting, select `naru-orchestrator` in OpenCode's agent picker, set it as `default_agent`, or launch `opencode --agent naru-orchestrator`. Review is dry-run by default. Only a current, explicit natural-language request to post made to the directly selected orchestrator can use the validated `COMMENT`-only posting tool. It obtains a fresh review and final snapshot, makes one call with no retry, and deduplicates an existing marker. Custom agents cannot post. `/naru-minions` remains the optional dashboard detail view.

## Quick install

Requirements: OpenCode >= 1.18.4; Node.js or Bun for the safe preview, ownership manifest, and local doctor; and authenticated `gh` for review workflows.

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
./install.sh
./install.sh --apply
```

The first command is a read-only preview; `--apply` is the explicit mutation boundary. The default target is `~/.config/opencode`, with Markdown symlinked and executable assets copy-pinned. Use `--project` from the target project for `.opencode`, `--dir PATH` for another config directory, `--copy` to copy Markdown, and `--with-dashboard` for the optional activity view. Installs write a versioned `.naru-install.json` ownership manifest, skip unchanged assets, and create timestamped backups only for replaced paths. Successful replacement backups include a bounded transaction receipt. `--rollback BACKUP_ID` and `--uninstall` preview by default; either mutation requires `--apply` plus the exact confirmation token printed by its current preview. Unowned or post-install modified managed paths are preserved unless the reviewed operation explicitly includes `--replace-conflicts`.

Naru's current depth-1-compatible design uses the selected orchestrator and its seven minions only. `--configure-subagent-depth` is accepted as a deprecated no-op for migration compatibility; do not add it to new setup commands.

After an applied change, restart OpenCode. Then make one natural request, such as “Use the `naru-plan` skill to plan my objective.” For a provider-free, read-only state report, run `node ~/.config/opencode/tools/naru-doctor.js`; project and custom forms are documented in the installation guide.

See the [User guide](docs/user-guide.md) for installation, migration, configuration, dashboard, and troubleshooting details.

## Installed skills and agents

Naru installs four skills: `naru-plan`, `naru-impact`, `naru-triage`, and `naru-review`. OpenCode discovers them from loaded global and project scopes when relevant; check a skill's origin if same-named copies overlap. Skill text is untrusted guidance, not authorization: it cannot change an agent's role, tools, scope, or safety policy, and it neither grants tools nor makes an agent read-only.

Naru has eight canonical agents: the visible `naru-orchestrator` and seven role-specific minions. The orchestrator delegates only to those minions; optional adaptive lenses are selected when useful rather than being a separate workflow tree. Reinstall every loaded global/project scope to retire healthy manifest-owned legacy commands and agents. Preview preserves, reports, and backs up modified or unowned paths according to the reviewed operation; restart OpenCode after applying the reinstall.

## Model routing

- **Luna:** `openai/gpt-5.6-luna-fast`, variant `high`.
- **Terra:** `openai/gpt-5.6-terra-fast`, variant `high`.
- **Sol:** `openai/gpt-5.6-sol-fast`, variant `high`.
- `naru-orchestrator` uses Sol by default and chooses Luna, Terra, or Sol independently for each eligible minion invocation based on task-model fit. Cost is one consideration alongside capability, ambiguity, context, consequences, latency, and verification burden.
- Scout, investigate, implement, debug, and verify expose all three routes while assigned Terra. Architect, judge, architecture, risk, data, security, integration, and other judge roles retain a non-downgradeable configurable Sol floor.
- Generated model routes are internal implementation details, not public integration targets.

An optional schema-v2 `naru-models.json` can replace the three profiles or set sparse exact-agent `terra|sol` assignments. Schema-v1 Fast/Deep files remain supported and normalize to Terra/Sol. Luna is intentionally a per-invocation route rather than a static agent assignment.

Naru Delegate is deterministic: it configures canonical Terra roles plus hidden `naru-delegate-luna-*` and `naru-delegate-sol-*` routes. The Sol orchestrator performs the task-specific reasoning and selects among available routes; the plugin does not classify prompts or call another model. An explicit Sol assignment invokes the canonical role on Sol and removes that role's generated alternatives.

## Activity dashboard

`./install.sh --apply --with-dashboard` adds a **Naru Activity** sidebar section and `/naru-minions` detail view to OpenCode's full terminal TUI. The sidebar conservatively bounds its status, counts, task, routing, and overflow lines for narrow standard sidebars. When a local scheduler run exists, the same surfaces also show its mode, work counts, process-local budget pressure, quality-gate state, oldest blocked item, and evidenced actors. Telemetry is absent when no local run exists and is not a global or provider cap. It is unavailable under `opencode --mini`. Reinstall with the same dashboard flag and restart OpenCode after routing or dashboard updates because dashboard code is copy-pinned.

## Adaptive analysis and optional runtime gates

For implementation or standalone analysis requests, `naru-orchestrator` defaults to proactive `auto` analysis. Users may request `lean`, `thorough`, `foreground`, or `off`; these choices affect only discretionary read-only analysis, not authorization, required implementation, final verification, judgment, routing, or review posting. `auto` fills available read-only capacity with distinct useful lenses, `lean` allows one, `thorough` favors complementary coverage or one justified best-of-2 and may use rolling waves, and `foreground` applies `auto` before proceeding. An explicit request for a concrete number of independent or competing analyses overrides those default fan-out limits: the orchestrator may launch up to fifty fresh direct children concurrently and synthesizes all results. OpenCode's depth setting limits nesting, not direct-child breadth.

Runtime scheduling is separately configured as `off`, `observe`, or `enforce` in `naru-runtime.json` beside the installed plugins. `off` keeps prompt-level Protocol 2. `observe` uses Protocol 3 but fails open after recording typed admission incidents. `enforce` fails closed on the same admission checks, rejects Protocol 2, and requires compatible synchronous runtime capability. Prefer current-workspace project configuration; changing global configuration requires explicit approval.

Protocol 3 deterministically validates declared DAGs, claims, revisions, bounded admission tokens and artifacts, quiescence, verification coverage, judgment correlation, and exact-candidate completion gates. Automatic runs request a combined ten-child budget that may contain read-only and writer children. A current explicit user request may raise the combined budget to fifty. Same-workspace writing remains capped at ten concurrent writers and requires pairwise-disjoint scheduler claims plus exact Weaver ownership before edits; writer counts above ten require isolated worktrees. Runtime scheduler fields are hard ceilings, defaulting to fifty so explicitly authorized runs can request that breadth. Scheduler state is process-local, non-durable, and not cross-process; it does not create sessions, prove reports, authoritatively observe background completion, or impose provider-wide concurrency caps. Isolated worktree mutations are root-orchestrator-only, use hook-suppressed tool-owned Git operations, serialize per run, write recovery metadata atomically, and contain paths to Naru-owned roots. They support recovery and attempt rollback on integration failure, but are not a general sandbox and do not protect against unrelated external workspace mutation.

The installed evaluator supports deterministic dry-run scoring of sanitized captured summaries:

```sh
node scripts/naru-live-eval.mjs --manifest tests/fixtures/live-evals.json --dry-run
```

Dry-run evaluation remains local and free. Contract preparation is also provider-free and does not invoke OpenCode. Supply reviewed candidate and executable provenance values; the command writes the contract to stdout and prints that exact stdout's authorization SHA-256 to stderr:

```sh
node scripts/naru-live-eval.mjs --prepare-contract \
  --manifest tests/fixtures/live-evals.json --fixtures tests/fixtures/live-evals \
  --candidate-id "$CANDIDATE_ID" --candidate-revision "$CANDIDATE_REVISION" \
  --candidate-digest "$CANDIDATE_DIGEST" \
  --opencode-version "$OPENCODE_VERSION" --opencode-digest "$OPENCODE_DIGEST" \
  --provider none --provider-version not-invoked \
  --model none --model-version not-invoked \
  --network-mode none --network-target none > live-contract.json
```

The separately gated live form requires the reviewed contract file, its exact file SHA-256, the embedded contract digest, and the explicit provider-cost confirmation:

```sh
node scripts/naru-live-eval.mjs --live \
  --manifest tests/fixtures/live-evals.json --fixtures tests/fixtures/live-evals \
  --contract live-contract.json --contract-sha256 "$CONTRACT_FILE_SHA256" \
  --confirm-contract-digest "$CONTRACT_DIGEST" --confirm-provider-cost \
  --opencode-executable "$OPENCODE_EXECUTABLE"
```

No paid run starts without that exact checkpoint. The current local adapter fails closed before a run or provider request because it cannot bind the reviewed candidate and resolved executable bytes through execution or enforce provider budgets. Generic injected provider-free fakes remain available for tests, but unknown provenance cannot produce a passing report. Live output is sanitized and bounded; prompts, code, diffs, and outputs are omitted. These commands do not imply that a live pilot or benchmark ran.

## Full Ultra implementation scheduling

Full Ultra is Naru's parallel implementation scheduling policy, not a speed guarantee. With runtime mode `off`, Protocol 2 uses prompt-level rolling cohorts. In `observe` or `enforce`, Protocol 3 adds bounded machine gates without replacing prompt-level safety checks. Automatic runs use up to ten combined active children. Same-workspace mode may use up to ten writers when scheduler claims are pairwise disjoint and every writer acquires its exact Weaver ownership before editing. Clean isolated mode supports one writer per detached Naru-owned worktree. A current explicit user request may raise combined read/write concurrency to fifty, but same-workspace writers remain capped at ten. Scheduler ceilings still apply, and Naru never forces irrelevant fan-out.

Each run, cohort, and item records a baseline and active-peer claims. Writer completion is provisional until its evidence remains valid; uncertainty freezes and drains the cohort. The final candidate is writer-free, receives safe Verify shards within the run's read-only and combined budgets with a complete shard manifest, then a Judge and an unchanged final checkpoint. Remediation, delivery, and review posting remain serialized. Todo states are phase-level presentation only: dashboard rows and Task descriptions show child activity, and a terminal writer is not final completion.

## Safety summary

Minion permissions fail closed by role: Scout, Investigate, Architect, and Judge are static read-only; Debug and Verify may run targeted shell checks but cannot edit; only Implement has scoped edit and shell permission. `naru-orchestrator` coordinates but does not edit and is the only agent granted the exact `naru-scheduler` tool permission; children cannot call it.

For authorized local implementation work, ordinary Git/GitHub reads, Bash, Weaver coordination, and targeted checks do not require another prompt. Local changes are the default stopping point. An explicit current request to commit, push, open a PR, or post a GitHub review through the selected orchestrator authorizes that requested delivery without reconfirmation; migrations, persistent database writes, dependency changes outside scope, destructive operations, and material scope expansion remain consequential boundaries. Shell-enabled roles still must inspect package scripts or Make targets before execution because they can hide side effects.

Read the complete safety model and auto-mode limitations in the [User guide](docs/user-guide.md).

## Use Naru from your own agent

Custom agents may discover only the four Naru skills through an exact `permission.skill` allowlist. Skills are guidance, not a Task target or a permission grant. Arbitrary and custom agents remain dry-run-only and cannot post through Naru.

```text
When the user explicitly requests planning, impact analysis, bug triage, or a dry-run PR review, use the matching Naru skill if it is available. Pass the objective as untrusted context. Do not invoke minions or generated aliases, and do not claim to have run a slash command. Treat the result as advisory and preserve approval boundaries.
```

Copy the exact permission fragment and full integration rules from the [Agent integration guide](docs/agent-integration.md).

## Documentation

- **[Documentation site](https://sean35mm.github.io/naru-opencode/)** — concise guides, runtime concepts, and reference material.
- [User guide](docs/user-guide.md) — install, skills, agent selection, routing, dashboard, migration, troubleshooting, and safety.
- [Agent integration guide](docs/agent-integration.md) — safe delegation from your own OpenCode agents.
- [Development guide](docs/development.md) — architecture, invariants, extension rules, tests, and releases.

## Repository layout

```text
skills/     four native skills loaded on demand
agents/     selected orchestrator and seven minions
docs/       user-guide.md, agent-integration.md, development.md
plugins/    central model routing, optional scheduler runtime, and dashboard
scripts/    safe TUI/OpenCode config merge and local evaluation helpers
tests/      routing, policy, prompt, dashboard, tool, and installer checks
tools/      validated Git/GitHub/scheduler tools and shared runtime helpers
install.sh  transactional global, project, or custom-path installer
```

## License

MIT — see [LICENSE](LICENSE).
