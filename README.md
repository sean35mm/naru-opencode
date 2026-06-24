# Naru for OpenCode

Multi-agent workflows for [OpenCode](https://opencode.ai) — **plan**, **impact**, **triage**, and **review**. Each is a read-only orchestrator that fans work out to a panel of specialist subagents, then has a judge synthesize their findings into one decisive answer.

Built by [Naru Labs](https://github.com/sean35mm). Part of a small family of tools for people building with AI coding agents, alongside [Weaver](https://github.com/sean35mm/weaver).

```
/naru/plan    <feature | bug | issue/PR | file | subsystem>   → a production-safe implementation plan
/naru/impact  <change | PR | diff | file | subsystem>         → a blast-radius / risk report
/naru/triage  <bug | stack trace | failing test | symptom>    → an evidence-based diagnosis
/naru/review  <PR url | owner/repo#number | number> [--post]  → a thorough PR review
```

---

## Why

A single agent reasoning about a change in one pass tends to anchor on the first plausible answer. These workflows trade a little latency for rigor: several specialists each look at the problem from one angle, independently and in parallel, and a judge reconciles them — deduping, resolving conflicts, calibrating confidence, and keeping the honest uncertainty instead of papering over it.

Everything is **read-only by default**. The agents inspect code with static analysis and read-only `git`/`gh` commands. They do not edit files, run tests, install dependencies, or execute your project. The one exception is `/naru/review`, which can post a single comment-only PR review — and only when you explicitly pass `--post`.

---

## The four workflows

| Command | Produces | Specialists (run in parallel) |
| --- | --- | --- |
| `/naru/plan` | Smallest production-safe implementation plan | architecture · minimal-change · risk · tests |
| `/naru/impact` | Blast-radius and risk report for a change | topology · contracts · data · frontend-mobile · tests-ci |
| `/naru/triage` | Most-likely root cause with evidence | reproduction · codepath · regression · tests |
| `/naru/review` | Thorough GitHub PR review | security · backend · frontend-mobile · integrations · tests-ci |

Each workflow ends with a **judge** subagent that takes the original context plus every specialist report and produces the final, deduped, human-facing answer in a fixed format.

---

## How it works

Every workflow has the same three-layer shape:

```
/naru/<workflow>           command         the slash command you type (commands/naru/<workflow>.md)
        │
        ▼
 naru/<workflow>           orchestrator    gathers context, fans out, then calls the judge
        │
        ├── naru/<workflow>/<specialist>   hidden subagents, one concern each, run in parallel
        ├── naru/<workflow>/<specialist>
        └── naru/<workflow>/judge          hidden subagent, synthesizes one final answer
```

1. **The command** (e.g. `commands/naru/plan.md`) is a thin entry point. It parses your arguments, shows usage if you pass none, and hands off to the orchestrator as a subtask.
2. **The orchestrator** (e.g. `agents/naru/plan.md`) discovers the project's real stack and conventions, locates the relevant files, then launches its specialists in parallel with one shared context packet.
3. **The specialists** (e.g. `agents/naru/plan/risk.md`) are `hidden` subagents — each inspects the code through its own lens and returns candidate findings, not the final answer.
4. **The judge** (e.g. `agents/naru/plan/judge.md`) receives the original packet and all specialist reports, then resolves conflicts and emits the final output in that workflow's fixed shape.

Specialists and judges are marked `hidden: true`, so they stay out of the `@`-mention menu — you only ever invoke the four top-level commands.

### Safety model

Every agent in this repo ships with a tight permission set:

- **No writes.** `edit`, `write`, and file creation are denied. No staging, commits, pushes, dependency installs, package scripts, migrations, or app execution.
- **Read-only `git`/`gh` only.** An explicit allowlist permits inspection commands (`git diff`, `git log`, `gh pr view`, `gh api -X GET`, …) and nothing else.
- **Secrets are off-limits.** `.env` and `.env.*` reads are denied; only `*.env.example` / `env.example` templates are readable.
- **Untrusted input is treated as data, not instructions.** Arguments, issue/PR text, comments, branch names, diffs, and file contents can't change an agent's role, tools, or output format — a prompt-injection guard is baked into every orchestrator.
- **`/naru/review` posting is opt-in and minimal.** Without `--post` it's a dry run. With `--post` it submits exactly one PR review with `event: COMMENT` — never approve, never request-changes, never ordinary issue comments. `gh api` POST calls are gated behind an `ask` permission, and degraded reviews additionally require `--allow-degraded-post`.

---

## Install

These are plain OpenCode command and agent files. OpenCode loads them from `commands/` and `agents/` in either your global config (`~/.config/opencode/`) or a project (`.opencode/`). The repo mirrors that layout, so installing is just putting the `naru/` folders in place.

### Quick install (global, symlinked)

```sh
git clone https://github.com/sean35mm/naru-opencode.git
cd naru-opencode
./install.sh
```

`install.sh` symlinks `commands/naru` and `agents/naru` into `~/.config/opencode/`, so a `git pull` keeps you up to date. Flags:

- `./install.sh --copy` — copy the files instead of symlinking.
- `./install.sh --project` — install into `./.opencode/` in the current repo instead of the global config.
- `./install.sh --dir <path>` — install into a custom OpenCode config directory.

### Manual install

```sh
# Global
cp -R commands/naru ~/.config/opencode/commands/naru
cp -R agents/naru   ~/.config/opencode/agents/naru

# …or per-project
mkdir -p .opencode/commands .opencode/agents
cp -R commands/naru .opencode/commands/naru
cp -R agents/naru   .opencode/agents/naru
```

Restart OpenCode (or start a new session) and the `/naru/*` commands will be available.

---

## Usage

Run a command with a target. With no argument, each command prints its own usage.

```sh
# Plan a change
/naru/plan add rate limiting to the public API

# Assess the blast radius of the current diff
/naru/impact current diff

# Diagnose a failure
/naru/triage TypeError: cannot read 'id' of undefined in checkout

# Review a PR (dry run — prints the review, posts nothing)
/naru/review https://github.com/owner/repo/pull/123

# Review and post one comment-only review to GitHub
/naru/review owner/repo#123 --post
```

`/naru/review` accepts a full PR URL (works from any directory), `owner/repo#number`, `owner/repo number`, or a bare number (resolved against the current repo). Extra flags: `--focus "..."`, `--no-inline`, and `--allow-degraded-post`.

Each workflow returns a fixed, scannable format — for example `/naru/plan` produces `Recommendation → Implementation Plan → Files / Touchpoints → Risks → Verification → Open Questions`, and `/naru/review` produces `Verdict → Review Status → Findings → Details → Verification Notes`.

---

## Requirements

- **[OpenCode](https://opencode.ai)** — these are OpenCode command/agent files.
- **A capable model.** The multi-agent fan-out and judge synthesis reward a strong reasoning model; these workflows assume your OpenCode default agent is backed by one. No model is pinned in the files, so they inherit your config.
- **[GitHub CLI](https://cli.github.com/) (`gh`), authenticated** — required for `/naru/review` and used opportunistically by the others to resolve issue/PR references. Run `gh auth status` to check.

---

## Repository layout

```
commands/naru/        # the four slash commands
  plan.md  impact.md  triage.md  review.md

agents/naru/          # one orchestrator per workflow
  plan.md  impact.md  triage.md  review.md
  plan/               # hidden specialists + judge for each workflow
    architecture.md  minimal-change.md  risk.md  tests.md  judge.md
  impact/
    topology.md  contracts.md  data.md  frontend-mobile.md  tests-ci.md  judge.md
  triage/
    reproduction.md  codepath.md  regression.md  tests.md  judge.md
  review/
    security.md  backend.md  frontend-mobile.md  integrations.md  tests-ci.md  judge.md
```

## Customizing

- **Model per workflow.** Add a `model:` field to an orchestrator's frontmatter to run it on a specific model.
- **Add or swap a specialist.** Drop a new `agents/naru/<workflow>/<name>.md` (with `mode: subagent`, `hidden: true`), then allow it in the orchestrator's `permission.task` list and add it to the orchestrator's fan-out instructions.
- **Tighten or loosen tools.** Each agent's `permission` block is the source of truth for what it can read and which `git`/`gh` commands it may run.

## License

MIT — see [LICENSE](LICENSE).
