---
title: Adaptive delegation
description: How Naru selects the smallest useful read-only analysis before implementation.
---

For a material implementation request, `naru-orchestrator` defaults to `auto`: it selects the smallest useful read-only lens, not every available specialist. The choice changes discretionary analysis only; it never changes authorization, edit ownership, verification, judgment, routing, or delivery boundaries.

```mermaid
flowchart TD
  A[Implementation request] --> B{Analysis preference}
  B -->|off| C[Record mode-off]
  B -->|lean| D[At most one useful lens]
  B -->|auto| E[Smallest useful lens set]
  B -->|thorough| F[Complementary lenses or one best-of-2]
  B -->|foreground| G[Apply auto before continuing]
  C --> H[Scoped implementation]
  D --> H
  E --> H
  F --> H
  G --> H
```

**Walkthrough:** use Scout when ownership is unknown, Investigate when behavior is uncertain, Architect for consequential structural decisions, and a read-only Verify preparation task when a check plan needs independent review. `lean` permits at most one lens; `thorough` may add complementary evidence or one justified best-of-2 pair. `off` disables only optional analysis.

Naru does not force fan-out. It preserves limits of two active writers, two read-only children, and four total children. Read the canonical [user guide](https://sean35mm.github.io/naru-opencode/user-guide/) for the complete selection rules.
