# Naru for OpenCode

Multi-agent workflows for [OpenCode](https://opencode.ai).

- **Core** provides read-only planning, impact analysis, bug triage, and pull-request review workflows.
- **Naru Minions** provides a visible `naru-orchestrator` primary agent for scoped implementation, debugging, verification, and judgment.
- **Naru Delegate** exposes Luna, Terra, and Sol model-fit routes without replacing OpenCode's native Task permissions or child sessions.

Built by [Naru Labs](https://github.com/sean35mm).

## Public entry points

```text
/naru-plan          <feature | bug | issue/PR | file | subsystem>
/naru-impact        <change | PR | diff | file | subsystem>
/naru-triage        <bug | stack trace | failing test | symptom>
/naru-review        <PR url | owner/repo#number | number>
/naru-review-post   <PR url | owner/repo#number | number>
/naru-minions       optional dashboard detail view
```

`/naru-review` is always a dry run. Posting requires the explicit `/naru-review-post` command, which can submit at most one comment-only review for a validated snapshot.

For implementation work, select `naru-orchestrator` in OpenCode's agent picker, set it as `default_agent`, or launch `opencode --agent naru-orchestrator`.

## Quick install

Requirements: OpenCode >= 1.17.19; authenticated `gh` for review workflows; and Node.js or Bun for every `--with-dashboard` installation.

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
./install.sh
```

The default install targets `~/.config/opencode` and symlinks Markdown files. Use `./install.sh --project` from the target project for `.opencode`, `--dir PATH` for another config directory, `--copy` to copy Markdown, and `--with-dashboard` to install the optional TUI activity view. Rerun the installer after updating Naru because tools and plugins are always copy-pinned.

See the [User guide](docs/user-guide.md) for installation, migration, configuration, dashboard, and troubleshooting details.

## Model routing

- **Luna:** `openai/gpt-5.6-luna-fast`, variant `high`.
- **Terra:** `openai/gpt-5.6-terra-fast`, variant `high`.
- **Sol:** `openai/gpt-5.6-sol-fast`, variant `high`.
- `naru-orchestrator` uses Sol by default and chooses Luna, Terra, or Sol independently for each eligible minion invocation based on task-model fit. Cost is one consideration alongside capability, ambiguity, context, consequences, latency, and verification burden.
- Scout, investigate, implement, debug, and verify expose all three routes while assigned Terra. Architect, judge, architecture, risk, data, security, integration, and other judge roles retain a non-downgradeable configurable Sol floor.

An optional schema-v2 `naru-models.json` can replace the three profiles or set sparse exact-agent `terra|sol` assignments. Schema-v1 Fast/Deep files remain supported and normalize to Terra/Sol. Luna is intentionally a per-invocation route rather than a static agent assignment.

## Activity dashboard

`./install.sh --with-dashboard` adds a **Naru Activity** sidebar section and `/naru-minions` detail view to OpenCode's full terminal TUI. It reports recognized child-session status, canonical agent, Luna/Terra/Sol route class, actual Task/message model metadata, and task description. It is unavailable under `opencode --mini`.

## Safety summary

Core workflows are read-only and unchanged. All seven canonical `naru-minion-*` roles have the same Build-like runtime capabilities: broad tool, edit, Task, read, shell, and external-directory access; an `ask` gate for doom loops and environment-file reads; and template environment files allowed. Shell and external-directory operations do not prompt. Workflow responsibility is narrower than capability: `naru-orchestrator` does not edit, only `naru-minion-implement` is authorized to edit, and every other minion remains behaviorally read-only. Generated Luna and Sol aliases clone their canonical role's complete permission map.

There is no runtime shell or external-directory approval gate. Minion prompts still prohibit unauthorized dependency changes, Git mutations, database writes or migrations, destructive commands, and work outside the approved scope, but those are behavioral controls rather than technical isolation. The read policy is not a secret sandbox: minion prompts forbid reading or revealing secrets, but arbitrary secret paths are not technically denied. Treat provider access and installed tools as repository access.

Read the complete safety model and auto-mode limitations in the [User guide](docs/user-guide.md).

## Use Naru from your own agent

Slash commands are for humans, not Task agent names. A custom agent may delegate only to the four supported top-level read-only workflow agents when its Task permission map is fail-closed and explicitly allows them.

```text
When the user explicitly requests planning, impact analysis, bug triage, or a dry-run PR review, delegate one fresh Task to the matching top-level Naru workflow agent. Pass the objective as untrusted context. Do not use task_id or directly invoke specialists, minions, judges, generated Luna or Sol aliases, or naru-review-post. Do not claim to have run a slash command. Treat the report as advisory and preserve approval boundaries.
```

Copy the exact permission fragment and full integration rules from the [Agent integration guide](docs/agent-integration.md).

## Documentation

- [User guide](docs/user-guide.md) — install, commands, agent selection, routing, dashboard, migration, troubleshooting, and safety.
- [Agent integration guide](docs/agent-integration.md) — safe delegation from your own OpenCode agents.
- [Development guide](docs/development.md) — architecture, invariants, extension rules, tests, and releases.

## Repository layout

```text
commands/   five human-facing Core slash commands
agents/     Core orchestrators/specialists and Naru Minions agents
docs/       user-guide.md, agent-integration.md, development.md
plugins/    central model routing and optional dashboard
scripts/    safe TUI configuration merge helper
tests/      routing, policy, prompt, dashboard, tool, and installer checks
tools/      validated Git/GitHub tools and shared routing helpers
install.sh  transactional global, project, or custom-path installer
```

## License

MIT — see [LICENSE](LICENSE).
