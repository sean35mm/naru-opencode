---
description: Naru convenience commands
agent: naru
subtask: false
---

Handle this Naru convenience invocation exactly as the current user request:

`$ARGUMENTS`

Supported syntax is `ship-review <pr> [<pr> ...] [--dry-run] [--comment-only] [--standard] [--concise|--detailed]`.

For `ship-review`, this native command invocation explicitly requests review and posting for each finite PR target unless `--dry-run` is present, which posts nothing. Choose APPROVE, REQUEST_CHANGES, or COMMENT according to the findings and requested scope. Defaults are release-critical profile and concise output. `--comment-only` restricts the decision to COMMENT; `--standard` selects the standard profile; output flags override rendering. Authorization remains valid through the ongoing task and its continuations unless the user narrows or revokes it.

Load `naru-review`. Use ordinary `gh pr review` or `gh api` through the coordinator by default; `naru-github-post-review` is optional when the user requests strict attestation. Resolve and review every target independently, including every changed path and relevant prior feedback. Use exact-SHA Git blobs when bounded helpers cannot return complete evidence; disclose genuine coverage gaps and do not approve an incomplete review. Recheck the target and reviewed base/head SHAs immediately before posting; review a changed diff again, and bind API submissions to the reviewed head with `commit_id`. Suppress duplicate feedback without prohibiting a separately requested review on the same head. Never blindly retry an uncertain POST or switch mechanisms after an ambiguous outcome, and never let one target's failure or ambiguity trigger or prevent another target's independent review. Honor host permissions. Do not create follow-up tickets or merge. Return only a terse per-PR status table or list after all finite targets finish.
