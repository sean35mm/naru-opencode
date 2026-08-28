---
description: Naru convenience commands
agent: naru-orchestrator
subtask: false
---

Handle this Naru convenience invocation exactly as the current user request:

`$ARGUMENTS`

Supported syntax is `ship-review <pr> [<pr> ...] [--dry-run] [--comment-only] [--standard] [--concise|--detailed]`.

For `ship-review`, this native command invocation itself explicitly authorizes automatic `select-state` and at most one review POST per finite PR target unless `--dry-run` is present. Defaults are release-critical profile and concise output. `--comment-only` narrows the submission policy to comment-only; `--standard` selects the standard profile; output flags override rendering. Persistent `defaultDecision=automatic` never authorizes select-state, and generic post/comment/submit wording remains comment-only; only this current native invocation carries the automatic-state authorization.

Resolve and review every target independently using complete manifest-first evidence, including every manifest path and feedback unit. Preserve exact-head deduplication and review a new head again. Never retry a POST after an ambiguous outcome, and never let one target's failure or ambiguity trigger or prevent another target's independent review. `--dry-run` performs the review but posts nothing. Do not create follow-up tickets. Return only a terse per-PR status table or list after all finite targets finish.
