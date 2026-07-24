---
title: Adaptive delegation
description: How Naru proactively fills bounded read-only capacity before implementation.
---

For a material implementation request, `naru-orchestrator` defaults to `auto`: it fills available read-only capacity with distinct useful lenses and queues additional useful questions for rolling refill. It does not launch irrelevant or duplicate specialists. The choice changes discretionary analysis only; it never changes authorization, edit ownership, verification, judgment, routing, or delivery boundaries.

```mermaid
flowchart TB
  A["Implementation request"]:::entry
  B{"Analysis preference"}:::coord
  C["off"]:::gate
  D["lean"]:::read
  E["auto"]:::read
  F["thorough"]:::read
  G["foreground"]:::read
  H["Scoped implementation"]:::write

  A --> B
  B --> C & D & E & F & G
  C & D & E & F & G --> H

  classDef entry fill:#dfe4ff,stroke:#3f4fbe,color:#1b2456
  classDef coord fill:#ccd3ff,stroke:#3f4fbe,color:#1b2456
  classDef read fill:#d3ece5,stroke:#2f8f78,color:#123a31
  classDef write fill:#ffe4bd,stroke:#b8760f,color:#4a2c00
  classDef gate fill:#e8eaf0,stroke:#8f96a5,color:#22252e
```

<ul class="naru-legend">
  <li data-kind="read">Read-only</li>
  <li data-kind="write">Writes files</li>
</ul>

| Preference | Optional read-only analysis |
| --- | --- |
| `off` | None. Records mode-off and proceeds. |
| `lean` | At most one useful lens. |
| `auto` | The smallest useful lens set. This is the default. |
| `thorough` | Complementary lenses, or one justified best-of-2 pair. |
| `foreground` | Applies `auto` and finishes it before continuing. |

Every branch converges on the same scoped implementation step, because the preference changes only how much read-only evidence is gathered first. None of these branches can widen what the implementation step is allowed to touch.

**Walkthrough:** use Scout when ownership is unknown, Investigate when behavior is uncertain, Architect for consequential structural decisions, and a read-only Verify preparation task when a check plan needs independent review. `lean` permits at most one lens; `thorough` may add complementary evidence or one justified best-of-2 pair. `off` disables only optional analysis.

## The seven minions

The orchestrator coordinates but never edits. Of its seven minions, six are strictly read-only and exactly one — Implement — may modify your workspace. This is the boundary the whole workflow is built around.

```mermaid
flowchart TB
  ORC{{"naru-orchestrator — coordinates, never edits"}}:::coord
  SC["Scout"]:::read
  IN["Investigate"]:::read
  AR["Architect"]:::read
  DB["Debug"]:::read
  VE["Verify"]:::read
  JU["Judge"]:::read
  IM["Implement"]:::write

  ORC --> SC & IN & AR & DB & VE & JU
  ORC ==>|"only writer"| IM

  classDef coord fill:#ccd3ff,stroke:#3f4fbe,color:#1b2456
  classDef read fill:#d3ece5,stroke:#2f8f78,color:#123a31
  classDef write fill:#ffe4bd,stroke:#b8760f,color:#4a2c00
```

<ul class="naru-legend">
  <li data-kind="read">Read-only</li>
  <li data-kind="write">Writes files</li>
</ul>

| Minion | Role | Can it change your workspace? |
| --- | --- | --- |
| Scout | Rapid read-only context | No |
| Investigate | Uncertain behaviour | No |
| Architect | Consequential structural decisions | No |
| Debug | Diagnosis, may run targeted checks | No |
| Verify | Bounded checks, may run targeted checks | No |
| Judge | Final judgment on the candidate | No |
| **Implement** | Scoped edits inside an approved packet | **Yes — only this one** |

Naru proactively fills a combined ten-child automatic pool with distinct useful read-only and writer work but does not invent irrelevant fan-out. A current explicit user request may raise combined concurrency to fifty. Same-workspace writers remain capped at ten and require disjoint scheduler claims plus exact Weaver ownership before editing. Read the canonical [user guide](/naru-opencode/user-guide/) for the complete selection rules.

Those limits are concurrent ceilings, not lifetime child-count ceilings. If the user explicitly requests a concrete number of independent or competing analyses, the orchestrator may intentionally repeat a lens and launches the requested number of fresh direct children in rolling waves before synthesizing all terminal reports. `subagent_depth` limits nesting, so depth `1` supports this breadth while preventing those children from spawning grandchildren.
