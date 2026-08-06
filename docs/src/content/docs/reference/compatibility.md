---
title: Compatibility policy and evidence
description: The 0.1.0 release target, feature prerequisites, exclusions, and evidence boundary.
---

## Release target

The 0.1.0 compatibility policy sets both the OpenCode floor and current target to **1.18.4**. The initial platform targets are **macOS arm64** and **Ubuntu x64**, with **Node 24** and **Bun 1.3.9** as the runtime test targets.

Git is a prerequisite for Git-backed workflows. GitHub review posting additionally requires `gh`. No Git or `gh` version floor has been established; evidence may record the exact versions observed without turning them into support claims.

| Surface | Policy |
| --- | --- |
| Naru skills and agents | OpenCode 1.18.4 or later; depth-1-compatible; scheduler defaults to `off` |
| Full TUI dashboard | Optional; Bun 1.3.9 is the syntax-smoke target |
| Mini TUI | Dashboard excluded |
| Native Windows | Unsupported and unclaimed for 0.1.0 |
| WSL | Unsupported and unclaimed for 0.1.0 |

Compatibility checks are provider-free. They do not run a model command, inspect provider authentication, or call a provider.

## Emitted candidate compatibility

The release candidate runs the emitted `.js` and `.mjs` compatibility output with the current Node and Bun targets; its authoritative runtime source is strict NodeNext TypeScript under `src/`. It does not depend on a runtime TypeScript loader or bundler, and the candidate intentionally excludes TypeScript source, declarations, source maps, caches, and secret-like paths. The dashboard TSX, installer shell script, MJS tests, and static JSON and Markdown are explicit candidate exceptions.

Candidate assembly and checking preserve the runtime validators in the emitted code and verify generated-output parity. They do not establish browser, native-Windows, WSL, curl-bootstrap, package-registry-install, or full-TUI rendering support. Those surfaces remain excluded or unclaimed until separately evidenced.

## What counts as evidence

The policy above is a release target, not a claim that the matrix has passed. A local smoke result records sanitized observations and bounded check outcomes, but explicitly does **not** qualify the release or establish immutable-candidate evidence.

The optional dashboard smoke can prove Bun syntax handling and exact TUI registration in an isolated configuration. It does not prove that the native full TUI loaded or rendered the dashboard, so that capability remains explicitly omitted rather than reported as successful.

Successful exact-candidate CI on macOS arm64 and Ubuntu x64 will establish the release matrix later. Until those runs exist against the unchanged candidate, this page makes no matrix-success claim.
