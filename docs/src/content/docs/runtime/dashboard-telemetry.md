---
title: Dashboard and telemetry
description: Read Naru child activity and process-local scheduler telemetry in the full terminal UI.
---

Install the optional dashboard with `./install.sh --with-dashboard`, then restart OpenCode. It adds a **Naru Activity** sidebar section and `/naru-minions` detail view in the full terminal TUI.

```mermaid
flowchart LR
  subgraph sources["SOURCES — local only"]
    direction TB
    A["Native sessions and Tasks"]:::read
    C["Same-process scheduler run"]:::read
  end

  subgraph proj["PROJECTION"]
    direction TB
    B["Dashboard state helper"]:::coord
    D["Telemetry projection"]:::coord
  end

  subgraph surfaces["SURFACES"]
    direction TB
    E["Naru Activity sidebar"]:::artifact
    F["naru-minions detail view"]:::artifact
  end

  A --> B
  C --> D
  B --> E
  D --> E
  B --> F
  D --> F

  style sources fill:none,stroke:#8f96a5,stroke-dasharray:2 3,color:#8f96a5
  style proj fill:none,stroke:#8f96a5,stroke-dasharray:2 3,color:#8f96a5
  style surfaces fill:none,stroke:#8f96a5,stroke-dasharray:2 3,color:#8f96a5

  classDef coord fill:#ccd3ff,stroke:#3f4fbe,color:#1b2456
  classDef read fill:#d3ece5,stroke:#2f8f78,color:#123a31
  classDef artifact fill:#f5f6fa,stroke:#5f6675,color:#14161d
```

<ul class="naru-legend">
  <li data-kind="read">Read-only</li>
</ul>

**Walkthrough:** the dashboard recognizes canonical Naru children and managed routes, then shows status, age, task, route, and model metadata. When a scheduler run exists in the same process, telemetry adds mode, item counts, local budget pressure, quality-gate progress, oldest blocked item, and bounded actor groups.

Telemetry is hidden when unavailable. It is process-local, non-durable, not cross-process, not an authoritative background-completion signal, and not a provider or global concurrency cap. The dashboard is unavailable under `opencode --mini`.

For installation and troubleshooting details, see the canonical [user guide](/naru-opencode/user-guide/).
