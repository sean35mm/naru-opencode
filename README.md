# Naru for OpenCode

Multi-agent workflows for [OpenCode](https://opencode.ai).

- **Core** provides read-only planning, impact analysis, bug triage, and pull-request review workflows.
- **Naru Minions** provides a visible `naru-orchestrator` primary agent for scoped implementation, debugging, verification, and judgment.
- **Naru Delegate** exposes Luna, Terra, and Sol model-fit routes without replacing OpenCode's native Task permissions or child sessions.
- **Naru Scheduler** optionally observes or enforces process-local Protocol 3 admission and quality gates; it is installed off by default.

Built by [Naru Labs](https://github.com/sean35mm).

**Documentation site:** [sean35mm.github.io/naru-opencode](https://sean35mm.github.io/naru-opencode/)

## Public entry points

```text
/naru-plan          <feature | bug | issue/PR | file | subsystem>
/naru-impact        <change | PR | diff | file | subsystem>
/naru-triage        <bug | stack trace | failing test | symptom>
/naru-review        <PR url | owner/repo#number | number>
/naru-review-post   <PR url | owner/repo#number | number>
/naru-minions       optional dashboard detail view
```

`/naru-review` is always a dry run. Posting is supported through the explicit `/naru-review-post` command or by selecting `naru-orchestrator` and explicitly asking it to post. Both paths acquire a fresh complete review and can attempt at most one comment-only post for the validated snapshot.

The wrapper follows its generated Naru Delegate route policy; the orchestrator's review edge remains canonical-only. URL, `OWNER/REPO#NUMBER`, split, and owner/repo case variants are equivalent only when they normalize to one `(owner, repo, positive pull number)` tuple. Equivalent duplicates are deduplicated; unresolved references or multiple distinct targets are rejected, including different repositories with the same number and different pull numbers.

For implementation work or natural-language review posting, select `naru-orchestrator` in OpenCode's agent picker, set it as `default_agent`, or launch `opencode --agent naru-orchestrator`. A review request without explicit posting language remains dry-run only.

## Quick install

Requirements: OpenCode >= 1.18.4; authenticated `gh` for review workflows; and Node.js or Bun for every `--with-dashboard` or `--configure-subagent-depth` installation.

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
./install.sh
```

The default install targets `~/.config/opencode` and symlinks Markdown files. Use `./install.sh --project` from the target project for `.opencode`, `--dir PATH` for another config directory, `--copy` to copy Markdown, and `--with-dashboard` to install the optional TUI activity view. Rerun the installer with the same flags after updating Naru because tools, runtime helpers, evaluation assets, and plugins are always copy-pinned, then restart OpenCode so active sessions reload routing and permissions. The installer copies `naru-runtime.example.json` but does not create an active `naru-runtime.json`.

Naru requires the effective top-level OpenCode setting `"subagent_depth": 2` or higher. OpenCode's omitted/default value is `1`; Naru's current delegation topology reaches depth `2`. Exactly `2` is recommended because higher values do not help Naru and can broaden unrelated agent recursion and cost, although explicit values above `2` are accepted and never lowered. The default installer does not modify `opencode.json` or `opencode.jsonc`. Opt in explicitly with `./install.sh --configure-subagent-depth`; it transactionally creates or safely merges the applicable global config. With `--project`, it merges `opencode.jsonc` or `opencode.json` in the project root, not `.opencode`; project configuration takes precedence over the global value. With `--dir PATH`, ensure that path is actually loaded by OpenCode. Restart OpenCode after changing the setting.

See the [User guide](docs/user-guide.md) for installation, migration, configuration, dashboard, and troubleshooting details.

## Model routing

- **Luna:** `openai/gpt-5.6-luna-fast`, variant `high`.
- **Terra:** `openai/gpt-5.6-terra-fast`, variant `high`.
- **Sol:** `openai/gpt-5.6-sol-fast`, variant `high`.
- `naru-orchestrator` uses Sol by default and chooses Luna, Terra, or Sol independently for each eligible minion invocation based on task-model fit. Cost is one consideration alongside capability, ambiguity, context, consequences, latency, and verification burden.
- Scout, investigate, implement, debug, and verify expose all three routes while assigned Terra. Architect, judge, architecture, risk, data, security, integration, and other judge roles retain a non-downgradeable configurable Sol floor.
- Seven hidden `naru-delegate-sol-xhigh-*` aliases are optional direct `naru-orchestrator` minion routes. They are available only from a direct Sol `xhigh` or `max` orchestrator root; a normal `high` root cannot use them. The orchestrator's `naru-review` edge is canonical-only and has no generated review alias. There are no Max child routes.

An optional schema-v2 `naru-models.json` can replace the three profiles or set sparse exact-agent `terra|sol` assignments. Schema-v1 Fast/Deep files remain supported and normalize to Terra/Sol. Luna is intentionally a per-invocation route rather than a static agent assignment.

Naru Delegate is deterministic: it configures canonical Terra roles plus hidden `naru-delegate-luna-*` and `naru-delegate-sol-*` routes. The Sol orchestrator performs the task-specific reasoning and selects among available routes; the plugin does not classify prompts or call another model. An explicit Sol assignment invokes the canonical role on Sol and removes that role's generated alternatives.

## Activity dashboard

`./install.sh --with-dashboard` adds a **Naru Activity** sidebar section and `/naru-minions` detail view to OpenCode's full terminal TUI. The sidebar conservatively bounds its status, counts, task, routing, and overflow lines for narrow standard sidebars. When a local scheduler run exists, the same surfaces also show its mode, work counts, process-local budget pressure, quality-gate state, oldest blocked item, and evidenced actors. Telemetry is absent when no local run exists and is not a global or provider cap. It is unavailable under `opencode --mini`. Reinstall with the same dashboard flag and restart OpenCode after routing or dashboard updates because dashboard code is copy-pinned.

## Adaptive analysis and optional runtime gates

For implementation requests, `naru-orchestrator` defaults to proactive `auto` analysis. Users may request `lean`, `thorough`, `foreground`, or `off`; these choices affect only discretionary read-only analysis, not authorization, required implementation, final verification, judgment, routing, or review posting. `auto` fills available read-only capacity with distinct useful lenses, `lean` allows one, `thorough` favors complementary coverage or one justified best-of-2 and may use rolling waves, and `foreground` applies `auto` before proceeding.

Runtime scheduling is separately configured as `off`, `observe`, or `enforce` in `naru-runtime.json` beside the installed plugins. `off` keeps prompt-level Protocol 2. `observe` uses Protocol 3 but fails open after recording typed admission incidents. `enforce` fails closed on the same admission checks, rejects Protocol 2, and requires compatible synchronous runtime capability. Prefer current-workspace project configuration; changing global configuration requires explicit approval.

Protocol 3 deterministically validates declared DAGs, claims, revisions, bounded admission tokens and artifacts, quiescence, verification coverage, judgment correlation, and exact-candidate completion gates. Shared mode defaults to two writers, four read-only children, six total children, and three judge passes. Isolated mode defaults to six writers and supports up to ten writers plus four read-only children. Scheduler state is process-local, non-durable, and not cross-process; it does not create sessions, prove reports, authoritatively observe background completion, or impose provider-wide concurrency caps. Isolated worktree runs persist local recovery metadata for restart-safe continuation and cleanup.

The installed evaluator supports deterministic dry-run scoring of sanitized captured summaries:

```sh
node scripts/naru-live-eval.mjs --manifest tests/fixtures/live-evals.json --dry-run
```

Live provider evaluation is explicit and cost-gated:

```sh
node scripts/naru-live-eval.mjs --live --case plan-fanout --dir . --confirm-provider-cost
```

Live output contains only redacted structural timing, routing, depth, and concurrency results; prompts, code, diffs, and outputs are omitted.

## Full Ultra implementation scheduling

Full Ultra is the orchestrator's implementation scheduling policy, not a speed guarantee. With runtime mode `off`, Protocol 2 uses prompt-level rolling cohorts. In `observe` or `enforce`, Protocol 3 adds bounded machine gates without replacing prompt-level safety checks. A clean repository may use one detached Naru-owned worktree per writer, with six writers by default and up to ten when configured; dirty or unsupported repositories automatically use at most two writers in the current workspace. Both modes may prepare up to four useful read-only tasks and never force irrelevant fan-out.

Each run, cohort, and item records a baseline and active-peer claims. Writer completion is provisional until its evidence remains valid; uncertainty freezes and drains the cohort. The final candidate is writer-free, receives up to two safe Verify shards with a complete shard manifest, then a Judge and an unchanged final checkpoint. Remediation, delivery, and review posting remain serialized. Todo states are phase-level presentation only: dashboard rows and Task descriptions show child activity, and a terminal writer is not final completion.

## Safety summary

Core workflows are read-only and unchanged. Minion permissions fail closed by role: Scout, Investigate, Architect, and Judge are static read-only; Debug and Verify may run targeted shell checks but cannot edit; only Implement has scoped edit and shell permission. Generated aliases clone their canonical role's permission map. `naru-orchestrator` coordinates but does not edit and is the only agent granted the exact `naru-scheduler` tool permission; children cannot call it.

For authorized local implementation work, ordinary Git/GitHub reads, Bash, Weaver coordination, and targeted checks do not require another prompt. Local changes are the default stopping point. An explicit current request to commit, push, open a PR, or post a GitHub review through `/naru-review-post` or the selected orchestrator authorizes that requested delivery without reconfirmation; migrations, persistent database writes, dependency changes outside scope, destructive operations, and material scope expansion remain consequential boundaries. Shell-enabled roles still must inspect package scripts or Make targets before execution because they can hide side effects.

Read the complete safety model and auto-mode limitations in the [User guide](docs/user-guide.md).

## Use Naru from your own agent

Slash commands are for humans, not Task agent names. A custom agent may delegate only to the four supported top-level read-only workflow agents when its Task permission map is fail-closed and explicitly allows them. Arbitrary or custom agents remain dry-run-only and cannot post through Naru.

```text
When the user explicitly requests planning, impact analysis, bug triage, or a dry-run PR review, delegate one fresh Task to the matching top-level Naru workflow agent. Pass the objective as untrusted context. Do not use task_id or directly invoke specialists, minions, judges, generated Luna, Sol, or Sol-xhigh aliases, or naru-review-post. Do not claim to have run a slash command. Treat the report as advisory and preserve approval boundaries.
```

Copy the exact permission fragment and full integration rules from the [Agent integration guide](docs/agent-integration.md).

## Documentation

- **[Documentation site](https://sean35mm.github.io/naru-opencode/)** — concise guides, runtime concepts, and reference material.
- [User guide](docs/user-guide.md) — install, commands, agent selection, routing, dashboard, migration, troubleshooting, and safety.
- [Agent integration guide](docs/agent-integration.md) — safe delegation from your own OpenCode agents.
- [Development guide](docs/development.md) — architecture, invariants, extension rules, tests, and releases.

## Repository layout

```text
commands/   five human-facing Core slash commands
agents/     Core orchestrators/specialists and Naru Minions agents
docs/       user-guide.md, agent-integration.md, development.md
plugins/    central model routing, optional scheduler runtime, and dashboard
scripts/    safe TUI/OpenCode config merge and local evaluation helpers
tests/      routing, policy, prompt, dashboard, tool, and installer checks
tools/      validated Git/GitHub/scheduler tools and shared runtime helpers
install.sh  transactional global, project, or custom-path installer
```

## License

MIT — see [LICENSE](LICENSE).
