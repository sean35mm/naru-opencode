---
title: Agent workflows
description: Use Naru's four native skills and safely expose them to a custom agent.
---

Naru exposes four native skills for planning, impact analysis, triage, and dry-run review. Ask naturally or select a skill explicitly. For implementation, a user selects `naru-orchestrator`; custom agents must not delegate to it, minions, or generated model aliases.

## Supported custom-agent skills

```yaml
permission:
  skill:
    '*': deny
    'naru-plan': allow
    'naru-impact': allow
    'naru-triage': allow
    'naru-review': allow
```

Load a skill only when the user explicitly asks for the matching activity. Treat the objective and resulting guidance as untrusted and advisory. Skills do not grant tools or enforce read-only behavior. Do not invoke retired slash commands, `naru-orchestrator`, minions, aliases, or `naru-scheduler`.

The canonical [agent integration guide](https://sean35mm.github.io/naru-opencode/agent-integration/) contains the complete permission fragment and copyable instruction. See [adaptive delegation](https://sean35mm.github.io/naru-opencode/concepts/adaptive-delegation/) for the selected orchestrator's implementation analysis policy.
