# Support

Naru is a solo-maintainer, local-first project for OpenCode. Support is limited to the documented workflows and evidence that can be reviewed safely.

## Help channels

- Use [GitHub Issues](https://github.com/sean35mm/naru-opencode/issues) for non-confidential questions, reproducible bugs, documentation corrections, and feature proposals.
- Use the [private security advisory route](SECURITY.md) for vulnerabilities or anything that could expose secrets or enable an exploit. Do not use a public issue for security reports.
- Start with the [README](README.md), [user guide](docs/user-guide.md), and [development guide](docs/development.md) for documented installation, usage, safety, and check instructions.

The existing [compatibility reference](docs/src/content/docs/reference/compatibility.md) defines the release target, exclusions, and what provider-free observations count as evidence. It does not claim that the compatibility matrix passed; this page likewise makes no support claim beyond the explicitly documented target and evidence boundary.

## Safe evidence

Include, after review and redaction:

- the Naru version from `VERSION`, OpenCode version, operating system, runtime versions, and relevant install mode;
- the exact command or workflow, expected behavior, actual behavior, and a small reproducible sequence;
- sanitized error text, bounded logs, and relevant provider-free doctor or test output; and
- a minimal public reproduction only when it contains no private code or credentials.

Do not include API keys, tokens, cookies, environment-file contents, private configuration, credentials, unredacted prompts, private repository data, or provider output that contains sensitive information. Naru does not require secrets or provider spend for its local read-only workflows; do not upload diagnostics or authorize provider calls just to seek support.
