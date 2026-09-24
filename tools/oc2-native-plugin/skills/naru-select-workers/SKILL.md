---
name: naru-select-workers
description: Use when selecting reusable native workers for tasks from exact provider/model/variant references without inventing model rankings.
---

# Naru Select Workers

Use only the worker inventory and capabilities the host actually exposes. Do not call a nonexistent router. Each configured worker is reusable across independent sessions and has an exact model/variant reference; assign by task and scoped ownership, not by a fixed reader/runner/writer tier. The parent may handle small work directly. Full tool and MCP availability is a permission fact, not evidence of model quality.

For each candidate, keep three evidence classes separate:

- configured facts: exact agent name, role, provider/model reference, and variant;
- manual hypotheses: plausible suitability that has not been measured; and
- measured evidence: relevant observed task results or capability reports available in the current context.

Honor a current user override first, then prefer relevant measured evidence and task suitability. State uncertainty when evidence is absent. Do not rank providers, select every model from one provider by identity, enforce provider quotas or default speed levels, or invent strengths from a model name. Record the exact agent selected and the brief factual reason.

Use subscription-backed or otherwise authorized configured routes only. If the requested work has no available authorized route, stop and report the gap; do not silently switch to a billed fallback. Parallelize genuinely independent assignments and avoid low-value fan-out.
