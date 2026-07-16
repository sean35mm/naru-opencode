---
description: Run a thorough dry-run multi-agent GitHub PR review with Naru.
agent: naru-review
subtask: true
---

# /naru-review

Target and raw arguments:

Raw arguments:

```text
$ARGUMENTS
```

If empty, show:

```text
/naru-review <github-pr-url|owner/repo#number|owner/repo number|number> [--focus "..."] [--no-inline] [--summary-only]
```

Use `naru-review` as the source of truth. This command is dry-run only and never posts to GitHub. Reject `--post` and direct users to `/naru-review-post <target> [--focus "..."]`.
