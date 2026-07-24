---
title: Review lane
description: Keep Naru pull-request review dry by default and posting explicitly validated.
---

`naru-review` is dry-run by default. Posting requires a directly selected `naru-orchestrator` handling an explicit current natural-language request to post; custom agents cannot post.

```mermaid
flowchart TB
  A["User PR reference"]:::entry

  subgraph dry["ALWAYS DRY-RUN — nothing leaves your machine"]
    direction TB
    B["Normalize one PR target"]:::read
    C["Fresh canonical naru-review"]:::read
    D["Complete dry-run report"]:::artifact
  end

  E{"Explicit current<br/>post request?"}:::gate
  F["Return advisory review"]:::artifact

  subgraph post["OUTWARD-FACING — requires explicit current request"]
    direction TB
    G["Validate snapshot and payload"]:::gate
    H["One COMMENT-only posting attempt"]:::danger
  end

  A --> B --> C --> D --> E
  E -->|no| F
  E -->|yes| G --> H

  style dry fill:none,stroke:#8f96a5,stroke-dasharray:2 3,color:#8f96a5
  style post fill:none,stroke:#8f96a5,stroke-dasharray:2 3,color:#8f96a5

  classDef entry fill:#dfe4ff,stroke:#3f4fbe,color:#1b2456
  classDef read fill:#d3ece5,stroke:#2f8f78,color:#123a31
  classDef gate fill:#e8eaf0,stroke:#8f96a5,color:#22252e
  classDef danger fill:#ffdcd6,stroke:#c0392b,color:#4a120c
  classDef artifact fill:#f5f6fa,stroke:#5f6675,color:#14161d
```

<ul class="naru-legend">
  <li data-kind="read">Read-only</li>
  <li data-kind="danger">Leaves your machine</li>
</ul>

**Walkthrough:** references must normalize to one owner, repository, and positive pull number. A post request always obtains a fresh canonical review; pasted, stale, incomplete, degraded, or ambiguous results are rejected. Before POST, the tool rechecks a fresh final snapshot, head, feedback digest, inline locations, and existing marker. Same-target calls are serialized within one process using a bounded in-process PR table; cross-process deduplication remains impossible without durable external coordination, and ambiguous outcomes are never retried. The validated tool posts at most one comment-only review and never approves, requests changes, merges, or creates an ordinary issue comment.

For mixed implementation and review-post work, implementation, verification, judgment, remediation, and requested Git delivery finish first. The fresh review and posting attempt are the final serialized phase. See the canonical [user guide](/naru-opencode/user-guide/) for the full validation contract.
