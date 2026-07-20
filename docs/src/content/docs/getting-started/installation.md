---
title: Installation
description: Install Naru globally, into a project, or with the optional activity dashboard.
---

Naru requires OpenCode 1.17.19 or later. Pull-request review workflows also need authenticated `gh`. Node.js or Bun is required when installing the optional dashboard.

```mermaid
flowchart LR
  A[Clone repository] --> B[Run install.sh]
  B --> C{Target}
  C -->|default| D[~/.config/opencode]
  C -->|--project| E[Current .opencode]
  C -->|--dir PATH| F[Custom config directory]
  B --> G{--with-dashboard?}
  G -->|yes| H[Copy and register TUI plugin]
  G -->|no| I[Install without dashboard]
  H --> J[Restart OpenCode]
  I --> J
```

**Walkthrough:** the installer validates and stages the release before updating managed paths. Markdown commands and agents are symlinked by default; executable tools, runtime helpers, plugins, and dashboard code are always copied. Re-run the installer after updates, then restart OpenCode.

## Install targets

```sh
# Global install (default)
./install.sh

# Current project's .opencode directory
./install.sh --project

# Another configuration directory
./install.sh --dir /path/to/opencode-config

# Copy Markdown instead of symlinking it
./install.sh --copy

# Include the full-TUI activity dashboard
./install.sh --with-dashboard
```

`--with-dashboard` safely updates the active TUI configuration and is unavailable under `opencode --mini`. The installer copies the runtime example but does not create or enable `naru-runtime.json`.

For migration, manual installation, and recovery details, use the canonical [user guide](https://sean35mm.github.io/naru-opencode/user-guide/).
