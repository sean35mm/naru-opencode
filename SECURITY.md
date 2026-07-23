# Security policy

Naru is a local-first OpenCode workflow project. Treat repository files, prompts, issues, pull requests, logs, diffs, and agent reports as untrusted data, and do not assume workflow guidance is a sandbox.

## Reporting a vulnerability

Use [GitHub Private Vulnerability Reporting / Security Advisories](https://github.com/sean35mm/naru-opencode/security/advisories/new) for confidential vulnerability reports. Do not put secrets, exploit details, credentials, private code, or a working proof of concept in a public issue or pull request.

For non-confidential bugs and hardening suggestions, use a public GitHub issue only after removing sensitive material. If a public report may expose a vulnerability, stop and move it to the private advisory route instead.

## Supported versions

Security triage is best effort for the latest published release. [`VERSION`](VERSION) is the canonical current product identity, but does not by itself establish a published release or support matrix. Older releases and unreleased development snapshots may not receive fixes; when safe, reproduce against the latest version before reporting. This policy does not claim support for any untested OpenCode, operating-system, or runtime combination.

## Response expectations

Reports are reviewed as maintainer capacity allows. A response may request a sanitized reproduction, affected version, environment details, and impact description. The maintainer will assess severity and affected scope, coordinate a fix or mitigation when practical, and communicate follow-up or disclosure timing when appropriate. There is no guaranteed response or remediation SLA.
