---
name: naru-select-workers
description: Use when selecting reusable native workers for tasks from exact provider/model/variant references without inventing model rankings.
---

# Naru Select Workers

Use only the worker inventory and capabilities the host actually exposes. Do not call a nonexistent router. Each configured worker is reusable across independent sessions and has an exact model/variant reference; assign by task and scoped ownership, not by a fixed reader/runner/writer tier. Choose the model and effort together before dispatch. The parent may handle small work directly. Full tool and MCP availability is a permission fact, not evidence of model quality.

An explicit request to use a model for a delegated task takes precedence over autonomous selection or doing the task directly. Match exact references or unambiguous friendly names against the configured pool and dispatch the matching native worker. Honor a specified effort exactly; if omitted, choose a configured effort for that model and state it. Clarify unresolved model/provider/version ambiguity before dispatch. If the requested model or effort is absent, report that without dispatching a substitute. Do not bypass the pool through model overrides or `general`, change the parent model or pool, or continue a session running a different model/effort instead.

For each candidate, keep three evidence classes separate:

- configured facts: exact agent name, role, provider/model reference, and variant;
- manual hypotheses: plausible suitability that has not been measured; and
- measured evidence: relevant observed task results or capability reports available in the current context.

Honor a current user override first, then prefer relevant observed results available in context and explicit user-provided guidance. Consider required capabilities, ambiguity, consequences, context needs, available verification, and time/cost only where known. Effort labels across models are not equivalent quality guarantees; neither the highest effort nor a particular provider is a default. Do not infer superiority, speed, price, or suitability from a model's name, provider, inventory position, or similarity to the parent alone. Successful completion does not establish comparative superiority. The native `general` subagent is unpinned and may inherit the parent's model and effort: use it when that is intentional, not as the default substitute for a configured worker. State the chosen agent, actual model/effort reference (or inherited parent selection for `general`), and the concrete basis, not just the task's difficulty. Label provisional choices honestly; no invented measurements or verbose chain of thought.

When evidence does not distinguish plausible candidates, consider an untried or less-observed candidate on bounded, low-risk work that already needs delegation. Do not create extra assignments, impose provider quotas, or rotate models for appearance. For consequential work, weak evidence calls for stronger verification, not arbitrary exploration.

Continue an existing session when retained context is useful and its results remain sound; context retention is not evidence of general model superiority. Use a fresh session for independent review; changing models alone does not establish independence or quality. Before reassigning or escalating effort, distinguish tool or permission gaps, missing context or unclear scope, execution or reasoning errors, and interrupted or unobservable outcomes. Address the actual blocker rather than treating every failure as a model-quality problem.

Use subscription-backed or otherwise authorized configured routes only. If the requested work has no available authorized route, stop and report the gap; do not silently switch to a billed fallback. Parallelize genuinely independent assignments and avoid low-value fan-out.
